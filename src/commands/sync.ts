import path from 'node:path';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { loadConfig } from '../config/config.js';
import { GitService } from '../git/repo.js';
import { WorklogError } from '../utils/errors.js';
import { log, runAction } from '../utils/logger.js';
import { reportConflict } from '../safety/conflict.js';
import { acquireLock } from '../safety/lock.js';
import {
  createSafepoint,
  incomingDir,
  pinStash,
  stageIncoming,
  updateJournal,
} from '../safety/safepoint.js';
import { applyPrefix, buildBody, buildSubject } from '../sync/message.js';
import { resolveExplicitPaths, walkDropFolder, type SyncEntry } from '../sync/resolve.js';

interface SyncOptions {
  restore: boolean;
  from?: string;
  message?: string;
  perFile?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description('Import downloaded SFTP file(s) into main as one snapshot, then merge into work')
    .argument('[files...]', 'file(s) that were just downloaded from the server')
    .option('--from <dir>', 'import every file under a drop folder instead of naming each one')
    .option('-m, --message <message>', 'override the generated snapshot subject')
    .option('--per-file', 'make one commit per file instead of a single batched commit')
    .option('-n, --dry-run', 'show exactly what would be committed, then exit without changes')
    .option('--yes', 'proceed even though the batch is larger than the configured limit')
    .option('--no-restore', 'stay on the work branch instead of restoring the previous branch')
    .action(runAction(syncAction));
}

async function syncAction(files: string[], options: SyncOptions): Promise<void> {
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

  // A merge already underway makes branch switching impossible; starting here
  // would strand the run halfway through with no way back.
  const merge = await git.mergeState();
  if (merge.inProgress) {
    throw new WorklogError(
      'A merge is already in progress.',
      'Finish it (git add <files> && git commit) or abort it (git merge --abort), then run worklog sync again.',
    );
  }

  const preStaged = await git.stagedPaths();
  if (preStaged.length > 0) {
    throw new WorklogError(
      `Files are already staged: ${preStaged.join(', ')}`,
      'Commit them or unstage them (git restore --staged <file>) — sync needs sole control of the index.',
    );
  }

  const previousBranch = await git.currentBranch();
  const sources = await collectSources(root, files, options);

  if (sources.length === 0) {
    throw new WorklogError(
      'No files to sync.',
      options.from
        ? `The drop folder ${options.from} is empty.`
        : 'Name the file(s) you downloaded, or use --from <folder>.',
    );
  }
  if (sources.length > config.syncBatchLimit && !options.yes && !options.dryRun) {
    throw new WorklogError(
      `That is ${sources.length} files, above the limit of ${config.syncBatchLimit}.`,
      'Inspect it with --dry-run, or confirm with --yes.',
    );
  }

  // Classify against the snapshot branch: "added" or "updated" is a fact about
  // main, not about whichever branch happens to be checked out right now.
  const entries: SyncEntry[] = [];
  for (const source of sources) {
    const content = await readFile(source.source);
    const exists = await git.existsInRef(config.mainBranch, source.rel);
    entries.push({
      abs: path.join(root, source.rel),
      rel: source.rel,
      source: source.source,
      content,
      status: exists ? 'updated' : 'added',
    });
  }
  entries.sort((a, b) => a.rel.localeCompare(b.rel));

  const subject = options.message
    ? applyPrefix(config.syncCommitPrefix, options.message)
    : buildSubject(config.syncCommitPrefix, entries);
  const body = buildBody(entries);

  if (options.dryRun) {
    git.setReadOnly(true);
    printPlan(
      entries,
      subject,
      body,
      config.mainBranch,
      config.workBranch,
      Boolean(options.perFile),
    );
    return;
  }

  const lock = await acquireLock(git, 'sync');
  const safepoint = await createSafepoint(git, config, 'sync');
  let stashed = false;
  let conflictReported = false;

  try {
    // Keep a copy inside .git before the working tree is disturbed: until the
    // bytes land on main they would otherwise exist only in memory.
    await stageIncoming(git, safepoint, entries);

    // Take the download out of the tree so it cannot collide with the stash,
    // and so the merge can bring the same path back without a conflict.
    //
    // Only in-tree downloads need this. A drop folder sits outside the
    // repository, so it cannot collide with anything — emptying it now would
    // mean a later failure (a read-only destination, a locked file) left the
    // user with nothing where they put their download.
    for (const entry of entries) {
      if (entry.source !== entry.abs) continue;
      if (await git.isTracked(entry.rel)) await git.discardChanges(entry.rel);
      else await rm(entry.abs, { force: true });
    }

    if (await git.isDirty()) {
      const spinner = ora('Stashing uncommitted changes').start();
      await git.stashPush('worklog: auto-stash before sync');
      stashed = true;
      const hash = await git.resolve('refs/stash');
      if (hash) await pinStash(git, safepoint, hash);
      spinner.succeed('Stashed uncommitted changes');
    }

    const spinner = ora(`Switching to ${config.mainBranch}`).start();
    await git.checkout(config.mainBranch);
    spinner.succeed(`Switched to ${config.mainBranch}`);

    const written: SyncEntry[] = [];
    const skipped: SyncEntry[] = [];
    for (const entry of entries) {
      await mkdir(path.dirname(entry.abs), { recursive: true });
      await writeFile(entry.abs, entry.content);

      // Prove the bytes survived the write before staging them: a truncated
      // file would otherwise become the authoritative server snapshot.
      const info = await stat(entry.abs);
      if (info.size !== entry.content.byteLength) {
        throw new WorklogError(
          `${entry.rel} was not written completely (${info.size} of ${entry.content.byteLength} bytes).`,
          'Nothing was committed. Check disk space and any process locking the file, then retry.',
        );
      }

      await git.add([entry.rel]);
      if (await git.hasStagedChanges(entry.rel)) written.push(entry);
      else {
        skipped.push(entry);
        log.warn(
          `${entry.rel} is identical to the version already on ${config.mainBranch} — skipped`,
        );
      }
    }

    let commits = 0;
    if (written.length > 0) {
      if (options.perFile) {
        // Every file is already staged and the index was proved to hold only
        // these paths, so each commit is scoped by pathspec rather than by
        // re-staging — the remaining files stay staged for their own commit.
        for (const entry of written) {
          const single = buildSubject(config.syncCommitPrefix, [entry]);
          const hash = await git.commitPaths(single, [entry.rel]);
          commits += 1;
          log.success(`${single} ${chalk.dim(`(${hash})`)}`);
        }
      } else {
        const message = body.length > 0 ? `${subject}\n\n${body}` : subject;
        const hash = await git.addAndCommit(
          message,
          written.map((e) => e.rel),
        );
        if (hash) {
          commits = 1;
          log.success(`${subject} ${chalk.dim(`(${hash})`)}`);
        }
      }
    } else {
      log.info(`Already up to date with ${config.mainBranch} — nothing to snapshot.`);
    }

    await git.checkout(config.workBranch);

    // Pop before merging. A conflicted merge cannot be left (git refuses to
    // check out another branch), so a stash popped afterwards would be
    // stranded — which is exactly how uncommitted work used to disappear.
    if (stashed && previousBranch === config.workBranch) {
      try {
        await git.stashPop();
        stashed = false;
        log.success('Restored stashed changes');
      } catch (err) {
        log.warn(`Could not restore the stash automatically: ${(err as Error).message}`);
        log.dim('  Recover it with "git stash pop", or "worklog doctor" to inspect it.');
      }
    }

    const mergeSpinner = ora(`Merging ${config.mainBranch} into ${config.workBranch}`).start();
    try {
      await git.merge(config.mainBranch);
      mergeSpinner.succeed(`Merged ${config.mainBranch} into ${config.workBranch}`);
    } catch (err) {
      mergeSpinner.fail('Merge produced conflicts');
      const state = await git.mergeState();
      if (state.inProgress) {
        await reportConflict(git, {
          conflicted: state.conflicted,
          branch: config.workBranch,
          stashed,
          safepointId: safepoint.id,
          error: err as Error,
        });
        await updateJournal(git, safepoint, { status: 'conflict' });
        conflictReported = true;
        process.exitCode = 1;
        return;
      }
      throw err;
    }

    if (options.restore && previousBranch !== config.workBranch && previousBranch !== 'HEAD') {
      await git.checkout(previousBranch);
      log.info(`Restored branch ${previousBranch}`);
    }

    if (stashed) {
      try {
        await git.stashPop();
        stashed = false;
        log.success('Restored stashed changes');
      } catch {
        log.warn('Could not automatically restore the stash — recover it with "git stash pop".');
      }
    }

    // The import is complete, so the drop folder can be cleared. This happens
    // last — after any stash pop, which would otherwise restore a drop file
    // deleted earlier — so a failure anywhere above leaves the downloads
    // exactly where the user put them.
    for (const entry of entries) {
      if (entry.source !== entry.abs) await rm(entry.source, { force: true });
    }

    await updateJournal(git, safepoint, { status: 'ok' });

    log.plain('');
    const parts = [`${commits} snapshot commit${commits === 1 ? '' : 's'} on ${config.mainBranch}`];
    if (skipped.length > 0) parts.push(`${skipped.length} already up to date`);
    log.success(`Sync complete: ${parts.join(', ')}, merged into ${config.workBranch}.`);
  } catch (err) {
    if (!conflictReported) {
      // The downloads were taken out of the working tree (and out of the drop
      // folder) early on, so say plainly where the only remaining copy lives.
      await reportIncoming(git, safepoint.id, entries.length);

      // Do not strand the user on the snapshot branch mid-operation.
      try {
        const current = await git.currentBranchOrNull();
        if (current === config.mainBranch && current !== previousBranch) {
          await git.checkout(previousBranch);
          log.info(`Returned to ${previousBranch}`);
        }
      } catch {
        log.warn(`Could not return to ${previousBranch} — run "git checkout ${previousBranch}".`);
      }

      if (stashed) {
        try {
          await git.stashPop();
          stashed = false;
          log.success('Restored stashed changes');
        } catch {
          log.warn('Your uncommitted changes are stashed — run "worklog doctor --pop-stash".');
        }
      }
    }
    await updateJournal(git, safepoint, { status: 'failed', note: (err as Error).message });
    throw err;
  } finally {
    await lock.release();
  }
}

/** Point at the captured downloads after a failure, so nothing looks lost. */
async function reportIncoming(git: GitService, id: string, count: number): Promise<void> {
  if (count === 0) return;
  try {
    const dir = await incomingDir(git, id);
    log.plain('');
    log.warn(`The ${count} downloaded file(s) were not imported, but they are not lost:`);
    log.dim(`  ${dir}`);
    log.dim('  Copy them back into place (or into a drop folder) and run worklog sync again.');
  } catch {
    // Reporting the rescue path must never mask the original failure.
  }
}

/** Where the bytes come from, and where they belong in the repository. */
async function collectSources(
  root: string,
  files: string[],
  options: SyncOptions,
): Promise<Array<{ source: string; rel: string }>> {
  if (options.from) {
    if (files.length > 0) {
      throw new WorklogError(
        'Pass either --from <dir> or explicit file paths, not both.',
        'The drop folder already determines which files are imported.',
      );
    }
    const dropRoot = path.resolve(process.cwd(), options.from);
    return walkDropFolder(dropRoot);
  }

  if (files.length === 0) {
    throw new WorklogError(
      'No files given.',
      'Name the file(s) you downloaded, or use --from <folder> to import a whole drop folder.',
    );
  }

  const rels = await resolveExplicitPaths(files, root);
  const seen = new Set<string>();
  const sources: Array<{ source: string; rel: string }> = [];
  for (const rel of rels) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    sources.push({ source: path.join(root, rel), rel });
  }
  return sources;
}

function printPlan(
  entries: SyncEntry[],
  subject: string,
  body: string,
  mainBranch: string,
  workBranch: string,
  perFile: boolean,
): void {
  log.heading('Dry run — nothing has been changed');
  log.plain(`  ${entries.length} file${entries.length === 1 ? '' : 's'} would be imported:`);
  for (const entry of entries) {
    const tag = entry.status === 'added' ? chalk.green('add   ') : chalk.yellow('update');
    log.plain(`    ${tag} ${entry.rel}`);
  }
  log.plain('');
  if (perFile) {
    log.plain(`  ${entries.length} separate commits on ${mainBranch} (--per-file).`);
  } else {
    log.plain(`  One commit on ${mainBranch}:`);
    log.plain(`    ${chalk.bold(subject)}`);
    for (const line of body.split('\n')) if (line) log.plain(`    ${chalk.dim(line)}`);
  }
  log.plain('');
  log.plain(`  Then ${mainBranch} would be merged into ${workBranch}.`);
}
