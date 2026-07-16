import type { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import { GitService } from '../git/repo.js';
import { log, runAction } from '../utils/logger.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Richer git status tailored to the main/work snapshot workflow')
    .action(runAction(statusAction));
}

async function statusAction(): Promise<void> {
  const git = new GitService();
  const root = await git.ensureRepo();
  const config = await loadConfig(root);

  const branch = await git.currentBranch();
  const status = await git.status();

  log.heading('Repository');
  log.plain(`  Root:   ${root}`);
  log.plain(`  Branch: ${chalk.cyan(branch)}`);

  log.heading('Working Tree');
  if (status.isClean()) {
    log.plain(chalk.green('  clean'));
  } else {
    for (const file of status.staged) log.plain(`  ${chalk.green('staged   ')} ${file}`);
    for (const file of status.created) {
      if (!status.staged.includes(file)) log.plain(`  ${chalk.green('new      ')} ${file}`);
    }
    for (const file of status.modified) {
      if (!status.staged.includes(file)) log.plain(`  ${chalk.yellow('modified ')} ${file}`);
    }
    for (const file of status.deleted) log.plain(`  ${chalk.red('deleted  ')} ${file}`);
    for (const file of status.not_added) log.plain(`  ${chalk.magenta('untracked')} ${file}`);
    for (const file of status.conflicted) log.plain(`  ${chalk.red('conflict ')} ${file}`);
  }

  const hasMain = await git.branchExists(config.mainBranch);
  const hasWork = await git.branchExists(config.workBranch);

  log.heading('Branches');
  if (hasMain && hasWork) {
    const mainAhead = await git.commitsAhead(config.workBranch, config.mainBranch);
    const workAhead = await git.commitsAhead(config.mainBranch, config.workBranch);
    log.plain(
      `  ${config.mainBranch} (snapshots): ${
        mainAhead === 0
          ? chalk.green(`fully merged into ${config.workBranch}`)
          : chalk.yellow(`${mainAhead} commit${mainAhead === 1 ? '' : 's'} waiting to merge into ${config.workBranch}`)
      }`,
    );
    log.plain(
      `  ${config.workBranch} (development): ${chalk.cyan(`${workAhead} commit${workAhead === 1 ? '' : 's'} ahead of ${config.mainBranch}`)}`,
    );

    const lastSync = await git.lastCommitMatching(config.mainBranch, config.syncCommitPrefix);
    log.plain(
      `  Last production sync: ${
        lastSync ? `${lastSync.message} ${chalk.dim(`(${lastSync.relDate})`)}` : chalk.dim('none')
      }`,
    );
  } else {
    if (!hasMain) log.warn(`Snapshot branch "${config.mainBranch}" not found.`);
    if (!hasWork) log.warn(`Development branch "${config.workBranch}" not found.`);
  }

  log.heading('Recent Commits');
  const recent = await git.logWithStats({ branch: 'HEAD', maxCount: 5 });
  if (recent.length === 0) {
    log.plain(chalk.dim('  (no commits yet)'));
  }
  for (const commit of recent) {
    log.plain(`  ${chalk.dim(commit.shortHash)} ${commit.message} ${chalk.dim(`(${commit.relDate})`)}`);
  }
}
