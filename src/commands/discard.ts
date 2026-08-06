import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { loadConfig } from '../config/config.js';
import { GitService } from '../git/repo.js';
import { WorklogError } from '../utils/errors.js';
import { log, runAction } from '../utils/logger.js';
import { toRepoRelative } from '../utils/paths.js';

interface DiscardOptions {
  message?: string;
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
    .argument(
      '<files...>',
      'existing tracked file(s) that were just downloaded from the server',
    )
    .option(
      '-m, --message <message>',
      'message for the replacement commit on the work branch',
    )
    .action(runAction(discardAction));
}

async function discardAction(
  files: string[],
  options: DiscardOptions,
): Promise<void> {
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
  let stashed = false;

  if (await git.isDirty()) {
    const stashSpinner = ora('Stashing unrelated uncommitted changes').start();
    await git.stashPush('worklog: auto-stash before discard');
    stashed = true;
    stashSpinner.succeed('Stashed unrelated uncommitted changes');
  }

  const switchSpinner = ora(`Switching to ${config.mainBranch}`).start();

  try {
    await git.checkout(config.mainBranch);
    switchSpinner.succeed(`Switched to ${config.mainBranch}`);

    /*
     * First, record the downloaded files as the latest authoritative
     * server snapshot on main.
     */
    let snapshotCommits = 0;

    for (const entry of entries) {
      await mkdir(path.dirname(entry.abs), { recursive: true });
      await writeFile(entry.abs, entry.content);
      await git.add([entry.rel]);

      if (!(await git.hasStagedChanges(entry.rel))) {
        log.warn(
          `${entry.rel} is identical to the current server snapshot on ${config.mainBranch}`,
        );
        continue;
      }

      const subject =
        `${config.syncCommitPrefix} update ${path.basename(entry.rel)}`;

      const body =
        entry.rel === path.basename(entry.rel)
          ? ''
          : `\n\n${entry.rel}`;

      const hash = await git.commitPaths(
        subject + body,
        [entry.rel],
      );

      snapshotCommits += 1;
      log.success(`${subject} ${chalk.dim(`(${hash})`)}`);
    }

    /*
     * Move back to work and replace its version with the exact version now
     * stored on main. This creates a normal commit instead of rewriting or
     * deleting the earlier development history.
     */
    await git.checkout(config.workBranch);
    log.success(`Switched to ${config.workBranch}`);

    let replacementCommits = 0;

    for (const entry of entries) {
      await git.restoreFrom(config.mainBranch, [entry.rel]);

      if (!(await git.hasStagedChanges(entry.rel))) {
        log.warn(
          `${entry.rel} already matches the downloaded server version`,
        );
        continue;
      }

      const message =
        options.message?.trim() ||
        `Accept server version of ${path.basename(entry.rel)}`;

      const hash = await git.commitPaths(message, [entry.rel]);

      replacementCommits += 1;
      log.success(`${message} ${chalk.dim(`(${hash})`)}`);
    }

    /*
     * The named files now contain identical content on both branches, so
     * merging main cannot reintroduce the discarded work for those files.
     */
    const mergeSpinner = ora(
      `Merging ${config.mainBranch} into ${config.workBranch}`,
    ).start();

    try {
      await git.merge(config.mainBranch);
      mergeSpinner.succeed(
        `Merged ${config.mainBranch} into ${config.workBranch}`,
      );
    } catch (error) {
      mergeSpinner.fail('Merge produced conflicts');
      log.plain('');
      log.error((error as Error).message);
      log.plain('');
      log.info('Resolve the conflicts, then run: git add <files> && git commit');

      if (stashed) {
        log.warn(
          'Your unrelated changes remain stashed — run "git stash pop" after resolving the merge.',
        );
      }

      process.exitCode = 1;
      return;
    }

    if (stashed) {
      try {
        await git.stashPop();
        log.success('Restored unrelated stashed changes');
      } catch {
        log.warn(
          'Could not automatically restore the stash — recover it with "git stash pop".',
        );
      }
    }

    log.plain('');
    log.success(
      `Discard complete: ${snapshotCommits} server snapshot commit${
        snapshotCommits === 1 ? '' : 's'
      } on ${config.mainBranch}, ${replacementCommits} replacement commit${
        replacementCommits === 1 ? '' : 's'
      } on ${config.workBranch}.`,
    );
  } catch (error) {
    switchSpinner.isSpinning && switchSpinner.fail();

    if (stashed) {
      log.warn(
        'Your unrelated changes are stashed — run "git stash pop" after returning to the work branch.',
      );
    }

    throw error;
  }
}

async function resolveEntries(
  files: string[],
  root: string,
): Promise<DiscardEntry[]> {
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
