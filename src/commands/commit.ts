import path from 'node:path';
import type { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import { GitService } from '../git/repo.js';
import { WorklogError } from '../utils/errors.js';
import { log, runAction } from '../utils/logger.js';

interface CommitOptions {
  message: string;
  all?: boolean;
  anyBranch?: boolean;
}

export function registerCommitCommand(program: Command): void {
  program
    .command('commit')
    .description('Stage files and create a development commit on the work branch')
    .argument('[files...]', 'files to stage (omit and use --all to stage everything)')
    .requiredOption('-m, --message <message>', 'commit message')
    .option('-a, --all', 'stage all changes (including new and deleted files)')
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

  const message = options.message.trim();
  if (!message) {
    throw new WorklogError('Commit message cannot be empty.');
  }

  if (files.length > 0) {
    const rels = files.map((file) => {
      const abs = path.resolve(process.cwd(), file);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (rel.startsWith('..')) {
        throw new WorklogError(`${file} is outside the repository (${root}).`);
      }
      return rel;
    });
    await git.add(rels);
  } else if (options.all) {
    await git.addAll();
  }

  if (!(await git.hasStagedChanges())) {
    throw new WorklogError(
      'Nothing staged to commit.',
      'Pass the files to stage, use --all, or stage manually with git add.',
    );
  }

  const hash = await git.commit(message);
  log.success(`Committed on ${branch}: ${message} ${chalk.dim(`(${hash})`)}`);
}
