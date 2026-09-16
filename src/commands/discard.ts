import path from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { loadConfig } from '../config/config.js';
import { GitService } from '../git/repo.js';
import { reportConflict } from '../safety/conflict.js';
import { acquireLock } from '../safety/lock.js';
import {
  createSafepoint,
  incomingDir,
  pinStash,
  stageIncoming,
  updateJournal,
} from '../safety/safepoint.js';
import { WorklogError } from '../utils/errors.js';
import { log, runAction } from '../utils/logger.js';
import { toRepoRelative } from '../utils/paths.js';

interface DiscardOptions {
  message?: string;
  dryRun?: boolean;
}

interface DiscardEntry {
  /** Absolute location of the downloaded file. */
  abs: string;

  /** Repository-relative path used by Git. */
  rel: string;

  /** Downloaded SFTP content captured before switching branches. */
  content: Buffer;
}

export function registerDiscardCommand(program: Command): void {
  program
    .command('discard')
    .description(
      'Accept downloaded SFTP file(s) as authoritative and replace their work-branch versions',
    )
    .argument('<files...>', 'existing tracked file(s) that were just downloaded from the server')
    .option('-m, --message <message>', 'message for the replacement commit on the work branch')
    .option('-n, --dry-run', 'show what would be replaced, then exit without changes')
    .action(runAction(discardAction));
}

async function discardAction(files: string[], options: DiscardOptions): Promise<void> {
  const git = new GitService();
  const root = await git.ensureRepo();
  const config = await loadConfig(root);

  for (const branch of [config.mainBranch, config.workBranch]) {
    if (!(await git.branchExists(branch))) {
      throw new WorklogError(
        `Branch "${branch}" does not exist in this repository.`,
        'worklog expects a snapshot branch and a development branch (see worklog.config.json).',
      );
    }
  }

  const branch = await git.currentBranch();

  if (branch !== config.workBranch) {
    throw new WorklogError(
      `You are on "${branch}" but discard must run from "${config.workBranch}".`,
      `Run "git checkout ${config.workBranch}" first.`,
    );
  }

  const merge = await git.mergeState();
  if (merge.inProgress) {
    throw new WorklogError(
      'A merge is already in progress.',
      'Finish it (git add <files> && git commit) or abort it (git merge --abort), then run worklog discard again.',
    );
  }

  /*
   * Capture and validate every file before changing anything.
   * A bad second or third path must not leave earlier files half-processed.
   */
  const entries = await resolveEntries(files, root);

  for (const entry of entries) {
    if (!(await git.isTracked(entry.rel))) {
      throw new WorklogError(
        `${entry.rel} is not already tracked on ${config.workBranch}.`,
        'Use "worklog sync <path>" when importing a new file for the first time.',
      );
    }

    if (!(await git.existsInRef(config.mainBranch, entry.rel))) {
      throw new WorklogError(
        `${entry.rel} does not exist on ${config.mainBranch}.`,
        'Use "worklog sync <path>" when importing a new file for the first time.',
      );
    }
  }

  if (options.dryRun) {
    git.setReadOnly(true);
    log.heading('Dry run — nothing has been changed');
    log.plain(`  ${entries.length} file(s) would be replaced with the downloaded server copy:`);
    for (const entry of entries) log.plain(`    ${chalk.dim('•')} ${entry.rel}`);
    log.plain('');
    log.plain('  Your current versions stay in history and can always be recovered.');
    return;
  }

  const lock = await acquireLock(git, 'discard');
  const safepoint = await createSafepoint(git, config, 'discard');

  let stashed = false;
  let conflictReported = false;
  const switchSpinner = ora(`Switching to ${config.mainBranch}`);

  // Everything that touches the repository lives inside this try, so a failure
  // anywhere still releases the lock and still reports where the downloads are.
  try {
    /*
     * Keep the downloaded bytes inside .git before the working tree is touched:
     * between the restore below and the write onto main they would otherwise
     * exist only in memory.
     */
    await stageIncoming(git, safepoint, entries);

    /*
     * The current files are the newly downloaded server copies. Their bytes
     * are already stored in memory, so restore the work-tree paths before
     * switching branches.
     */
    for (const entry of entries) {
      await git.discardChanges(entry.rel);
    }

    /*
     * Preserve unrelated in-progress work. The downloaded target files were
     * restored above, so they will not be included in this stash.
     */
    if (await git.isDirty()) {
      const stashSpinner = ora('Stashing unrelated uncommitted changes').start();
      await git.stashPush('worklog: auto-stash before discard');
      stashed = true;
      const hash = await git.resolve('refs/stash');
      if (hash) await pinStash(git, safepoint, hash);
      stashSpinner.succeed('Stashed unrelated uncommitted changes');
    }

    switchSpinner.start();
    await git.checkout(config.mainBranch);
    switchSpinner.succeed(`Switched to ${config.mainBranch}`);

    /*
     * First, record the downloaded files as the latest authoritative
     * server snapshot on main.
     */
    const changed: DiscardEntry[] = [];

    for (const entry of entries) {
      await mkdir(path.dirname(entry.abs), { recursive: true });
      await writeFile(entry.abs, entry.content);

      const info = await stat(entry.abs);
      if (info.size !== entry.content.byteLength) {
        throw new WorklogError(
          `${entry.rel} was not written completely (${info.size} of ${entry.content.byteLength} bytes).`,
          'Nothing was committed. Check disk space and any process locking the file, then retry.',
        );
      }

      await git.add([entry.rel]);

      if (!(await git.hasStagedChanges(entry.rel))) {
        log.warn(`${entry.rel} is identical to the current server snapshot on ${config.mainBranch}`);
        continue;
      }
      changed.push(entry);
    }

    let snapshotCommits = 0;
    if (changed.length > 0) {
      const subject =
        changed.length === 1
          ? `${config.syncCommitPrefix} update ${path.basename(changed[0]!.rel)}`
          : `${config.syncCommitPrefix} update ${changed.length} files`;
      const body = changed.map((e) => `- ${e.rel}`).join('\n');
      const hash = await git.addAndCommit(
        `${subject}\n\n${body}`,
        changed.map((e) => e.rel),
      );
      if (hash) {
        snapshotCommits = 1;
        log.success(`${subject} ${chalk.dim(`(${hash})`)}`);
      }
    }

    /*
     * Move back to work and replace its version with the exact version now
     * stored on main. This creates a normal commit instead of rewriting or
     * deleting the earlier development history.
     */
    await git.checkout(config.workBranch);
    log.success(`Switched to ${config.workBranch}`);

    const replaced: DiscardEntry[] = [];
    for (const entry of entries) {
      await git.restoreFrom(config.mainBranch, [entry.rel]);
      if (!(await git.hasStagedChanges(entry.rel))) {
        log.warn(`${entry.rel} already matches the downloaded server version`);
        continue;
      }
      replaced.push(entry);
    }

    let replacementCommits = 0;
    if (replaced.length > 0) {
      const message =
        options.message?.trim() ||
        (replaced.length === 1
          ? `Accept server version of ${path.basename(replaced[0]!.rel)}`
          : `Accept server version of ${replaced.length} files`);
      const hash = await git.addAndCommit(
        message,
        replaced.map((e) => e.rel),
      );
      if (hash) {
        replacementCommits = 1;
        log.success(`${message} ${chalk.dim(`(${hash})`)}`);
      }
    }

    /*
     * The named files now contain identical content on both branches, so
     * merging main cannot reintroduce the discarded work for those files.
     *
     * This runs even when nothing changed. A run where every file already
     * matched is a success, not a failure, and skipping the merge and the
     * stash pop used to leave the repository half-finished.
     */
    const mergeSpinner = ora(`Merging ${config.mainBranch} into ${config.workBranch}`).start();

    try {
      await git.merge(config.mainBranch);
      mergeSpinner.succeed(`Merged ${config.mainBranch} into ${config.workBranch}`);
    } catch (error) {
      mergeSpinner.fail('Merge produced conflicts');
      const state = await git.mergeState();
      if (state.inProgress) {
        await reportConflict(git, {
          conflicted: state.conflicted,
          branch: config.workBranch,
          stashed,
          safepointId: safepoint.id,
          error: error as Error,
        });
        await updateJournal(git, safepoint, { status: 'conflict' });
        conflictReported = true;
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    if (stashed) {
      try {
        await git.stashPop();
        stashed = false;
        log.success('Restored unrelated stashed changes');
      } catch {
        log.warn('Could not automatically restore the stash — recover it with "git stash pop".');
        log.dim('  "worklog doctor" will show you exactly what it holds.');
      }
    }

    await updateJournal(git, safepoint, { status: 'ok' });

    log.plain('');
    if (snapshotCommits === 0 && replacementCommits === 0) {
      log.success('Nothing to do: every file already matched the downloaded server version.');
    } else {
      log.success(
        `Discard complete: ${snapshotCommits} server snapshot commit${
          snapshotCommits === 1 ? '' : 's'
        } on ${config.mainBranch}, ${replacementCommits} replacement commit${
          replacementCommits === 1 ? '' : 's'
        } on ${config.workBranch}.`,
      );
    }
  } catch (error) {
    switchSpinner.isSpinning && switchSpinner.fail();

    if (!conflictReported) {
      // The downloaded copies were restored away from the working tree early
      // on, so say where the only remaining copy of them lives.
      try {
        const dir = await incomingDir(git, safepoint.id);
        log.plain('');
        log.warn(`The ${entries.length} downloaded file(s) were not applied, but they are not lost:`);
        log.dim(`  ${dir}`);
        log.dim('  Copy them back into place and run worklog discard again.');
      } catch {
        // Reporting the rescue path must never mask the original failure.
      }

      // Do not strand the user on the snapshot branch mid-operation.
      try {
        const current = await git.currentBranchOrNull();
        if (current === config.mainBranch && current !== config.workBranch) {
          await git.checkout(config.workBranch);
          log.info(`Returned to ${config.workBranch}`);
        }
      } catch {
        log.warn(`Could not return to ${config.workBranch} — run "git checkout ${config.workBranch}".`);
      }

      if (stashed) {
        try {
          await git.stashPop();
          stashed = false;
          log.success('Restored unrelated stashed changes');
        } catch {
          log.warn('Your unrelated changes are stashed — run "worklog doctor --pop-stash".');
        }
      }
    }
    await updateJournal(git, safepoint, { status: 'failed', note: (error as Error).message });

    throw error;
  } finally {
    await lock.release();
  }
}

async function resolveEntries(files: string[], root: string): Promise<DiscardEntry[]> {
  const entries: DiscardEntry[] = [];

  for (const file of files) {
    const abs = path.resolve(process.cwd(), file);
    const rel = toRepoRelative(file, root);

    let content: Buffer;

    try {
      content = await readFile(abs);
    } catch {
      throw new WorklogError(
        `Cannot read ${file}.`,
        'Download the server copy over your local file first, then run worklog discard.',
      );
    }

    entries.push({
      abs,
      rel,
      content,
    });
  }

  return entries;
}
