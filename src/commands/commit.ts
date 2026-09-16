import path from 'node:path';
import { toRepoRelative } from '../utils/paths.js';
import type { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import { GitService } from '../git/repo.js';
import { acquireLock } from '../safety/lock.js';
import { createSafepoint, updateJournal } from '../safety/safepoint.js';
import { WorklogError } from '../utils/errors.js';
import { log, runAction } from '../utils/logger.js';

interface CommitOptions {
  message: string;
  all?: boolean;
  anyBranch?: boolean;
  dir?: string;
  includeUntracked?: boolean;
  dryRun?: boolean;
}

export function registerCommitCommand(program: Command): void {
  program
    .command('commit')
    .description('Stage files and create a development commit on the work branch')
    .argument('[files...]', 'files to stage (omit and use --all or --dir to select them)')
    .requiredOption('-m, --message <message>', 'commit message')
    .option('-a, --all', 'stage all changes (including new and deleted files)')
    .option('--dir <path>', 'stage every changed file under this directory')
    .option('--include-untracked', 'with --dir, also stage new files')
    .option('-n, --dry-run', 'list what would be committed, then exit without changes')
    .option('--any-branch', 'allow committing on a branch other than the work branch')
    .action(runAction(commitAction));
}

async function commitAction(files: string[], options: CommitOptions): Promise<void> {
  const git = new GitService();
  const root = await git.ensureRepo();
  const config = await loadConfig(root);

  const branch = await git.currentBranch();
  if (branch !== config.workBranch && !options.anyBranch) {
    throw new WorklogError(
      `You are on "${branch}" but development commits belong on "${config.workBranch}".`,
      `Run "git checkout ${config.workBranch}" first, or pass --any-branch to override.`,
    );
  }

  // Committing mid-merge writes a merge commit with a message meant for
  // ordinary work, and silently sweeps in every file the merge touched.
  const merge = await git.mergeState();
  if (merge.inProgress) {
    throw new WorklogError(
      'A merge is in progress.',
      'Finish it (git add <files> && git commit) before making a development commit.',
    );
  }

  const message = options.message.trim();
  if (!message) {
    throw new WorklogError('Commit message cannot be empty.');
  }

  const selected = await selectPaths(git, root, files, options);

  if (options.dryRun) {
    git.setReadOnly(true);
    log.heading('Dry run — nothing has been changed');
    if (selected === null) {
      const staged = await git.stagedPaths();
      log.plain(`  Would commit ${staged.length} already-staged file(s):`);
      for (const file of staged) log.plain(`    ${chalk.dim('•')} ${file}`);
    } else {
      log.plain(`  Would stage and commit ${selected.length} file(s):`);
      for (const file of selected) log.plain(`    ${chalk.dim('•')} ${file}`);
    }
    log.plain('');
    log.plain(`  Message: ${chalk.bold(message)}`);
    return;
  }

  const lock = await acquireLock(git, 'commit');
  const safepoint = await createSafepoint(git, config, 'commit');

  try {
    if (selected !== null) {
      await warnAboutServerCopies(git, config.mainBranch, selected);
      const hash = await git.addAndCommit(message, selected);
      if (!hash) {
        throw new WorklogError(
          'Nothing to commit — those files match what is already committed.',
          'Check "worklog review" to see the current state of the working tree.',
        );
      }
      log.success(`Committed on ${branch}: ${message} ${chalk.dim(`(${hash})`)}`);
      for (const file of selected) log.plain(`  ${chalk.dim('•')} ${file}`);
    } else {
      if (!(await git.hasStagedChanges())) {
        throw new WorklogError(
          'Nothing staged to commit.',
          'Pass the files to stage, use --all or --dir, or stage manually with git add.',
        );
      }
      const staged = await git.stagedPaths();
      const hash = await git.commit(message);
      log.success(`Committed on ${branch}: ${message} ${chalk.dim(`(${hash})`)}`);
      for (const file of staged) log.plain(`  ${chalk.dim('•')} ${file}`);
    }
    await updateJournal(git, safepoint, { status: 'ok' });
  } catch (err) {
    await updateJournal(git, safepoint, { status: 'failed', note: (err as Error).message });
    throw err;
  } finally {
    await lock.release();
  }
}

/**
 * Which paths to stage. Returns null when the caller wants whatever is
 * already staged, which keeps the v0.2 behavior of a bare `worklog commit -m`.
 */
async function selectPaths(
  git: GitService,
  root: string,
  files: string[],
  options: CommitOptions,
): Promise<string[] | null> {
  if (files.length > 0) {
    if (options.dir) {
      throw new WorklogError('Pass either file paths or --dir, not both.');
    }
    return files.map((file) => toRepoRelative(file, root));
  }

  if (options.dir) {
    const rel = path.relative(root, path.resolve(process.cwd(), options.dir)).split(path.sep).join('/');
    if (rel.startsWith('..')) {
      throw new WorklogError(`${options.dir} is outside the repository.`);
    }
    const entries = await git.statusEntries(rel || undefined);
    const wanted = entries.filter((e) =>
      e.state === 'untracked' ? Boolean(options.includeUntracked) : e.state !== 'conflicted',
    );
    if (wanted.length === 0) {
      throw new WorklogError(
        `Nothing changed under ${options.dir}.`,
        options.includeUntracked
          ? 'Check the path, or run "worklog review" to see what is dirty.'
          : 'New files need --include-untracked.',
      );
    }
    return wanted.map((e) => e.path);
  }

  if (options.all) {
    await git.addAll();
    return null;
  }

  return null;
}

/**
 * A file identical to the server snapshot that the user has never edited is
 * usually a download, and committing it as development work puts it in the
 * wrong place. Warn, do not refuse: the signal is suggestive, not certain,
 * and a hard block would just train everyone to bypass it.
 */
async function warnAboutServerCopies(
  git: GitService,
  mainBranch: string,
  paths: string[],
): Promise<void> {
  const suspicious: string[] = [];
  for (const rel of paths) {
    const worktree = await git.hashObjectWorktree(rel);
    const snapshot = await git.blobHashInRef(mainBranch, rel);
    if (worktree && snapshot && worktree === snapshot) suspicious.push(rel);
  }
  if (suspicious.length === 0) return;

  log.warn(
    `${suspicious.length} file(s) are identical to the server snapshot on ${mainBranch}:`,
  );
  for (const file of suspicious.slice(0, 5)) log.plain(`    ${chalk.dim('•')} ${file}`);
  log.dim('  If these are downloads, "worklog sync" records them properly. Committing anyway.');
}
