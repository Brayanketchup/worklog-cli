import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { loadConfig } from '../config/config.js';
import { GitService } from '../git/repo.js';
import { WorklogError } from '../utils/errors.js';
import { log, runAction } from '../utils/logger.js';

interface SyncOptions {
  restore: boolean;
}

interface SyncEntry {
  /** Absolute path on disk */
  abs: string;
  /** Repo-relative path with forward slashes (what git sees) */
  rel: string;
  /** The downloaded SFTP content, captured before any branch switching */
  content: Buffer;
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description('Import downloaded SFTP file(s) into main and merge them into work')
    .argument('<files...>', 'file(s) that were just downloaded from the server')
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

  const previousBranch = await git.currentBranch();
  const entries = await resolveEntries(files, root);

  // The downloaded content is captured in memory, so remove it from the
  // working tree now. If it went into the stash instead, "git stash pop"
  // would refuse to restore it after the merge brings the same file back.
  for (const entry of entries) {
    if (await git.isTracked(entry.rel)) {
      await git.discardChanges(entry.rel);
    } else {
      await rm(entry.abs, { force: true });
    }
  }

  // Capture any in-progress work so branch switching is always safe.
  let stashed = false;
  if (await git.isDirty()) {
    const spinner = ora('Stashing uncommitted changes').start();
    await git.stashPush('worklog: auto-stash before sync');
    stashed = true;
    spinner.succeed('Stashed uncommitted changes');
  }

  const spinner = ora(`Switching to ${config.mainBranch}`).start();
  try {
    await git.checkout(config.mainBranch);
    spinner.succeed(`Switched to ${config.mainBranch}`);

    let commits = 0;
    for (const entry of entries) {
      const tracked = await git.isTracked(entry.rel);
      await mkdir(path.dirname(entry.abs), { recursive: true });
      await writeFile(entry.abs, entry.content);
      await git.add([entry.rel]);

      if (!(await git.hasStagedChanges(entry.rel))) {
        log.warn(
          `${entry.rel} is identical to the version already on ${config.mainBranch} — skipped`,
        );
        continue;
      }

      const verb = tracked ? 'update' : 'add';
      const subject = `${config.syncCommitPrefix} ${verb} ${path.basename(entry.rel)}`;
      const body = entry.rel === path.basename(entry.rel) ? '' : `\n\n${entry.rel}`;
      const hash = await git.commit(subject + body);
      commits += 1;
      log.success(`${subject} ${chalk.dim(`(${hash})`)}`);
    }

    const mergeSpinner = ora(`Merging ${config.mainBranch} into ${config.workBranch}`).start();
    await git.checkout(config.workBranch);
    try {
      await git.merge(config.mainBranch);
      mergeSpinner.succeed(`Merged ${config.mainBranch} into ${config.workBranch}`);
    } catch (err) {
      mergeSpinner.fail('Merge produced conflicts');
      log.plain('');
      log.error((err as Error).message);
      log.plain('');
      log.info('Resolve the conflicts, then run: git add <files> && git commit');
      if (stashed) {
        log.warn('Your uncommitted changes are still stashed — run "git stash pop" afterwards.');
      }
      process.exitCode = 1;
      return;
    }

    if (
      options.restore &&
      previousBranch !== config.workBranch &&
      previousBranch !== 'HEAD'
    ) {
      await git.checkout(previousBranch);
      log.info(`Restored branch ${previousBranch}`);
    }

    if (stashed) {
      try {
        await git.stashPop();
        log.success('Restored stashed changes');
      } catch {
        log.warn(
          'Could not automatically restore the stash — resolve manually with "git stash pop".',
        );
      }
    }

    log.plain('');
    log.success(
      `Sync complete: ${commits} import commit${commits === 1 ? '' : 's'} on ${config.mainBranch}, merged into ${config.workBranch}.`,
    );
  } catch (err) {
    spinner.isSpinning && spinner.fail();
    if (stashed) {
      log.warn('Your uncommitted changes are stashed — run "git stash pop" to recover them.');
    }
    throw err;
  }
}

async function resolveEntries(files: string[], root: string): Promise<SyncEntry[]> {
  const entries: SyncEntry[] = [];
  for (const file of files) {
    const abs = path.resolve(process.cwd(), file);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new WorklogError(`${file} is outside the repository (${root}).`);
    }
    let content: Buffer;
    try {
      content = await readFile(abs);
    } catch {
      throw new WorklogError(
        `Cannot read ${file}.`,
        'Copy the downloaded SFTP file over your local copy first, then run worklog sync.',
      );
    }
    entries.push({ abs, rel, content });
  }
  return entries;
}
