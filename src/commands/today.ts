import type { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import { GitService } from '../git/repo.js';
import { buildReport } from '../report/generator.js';
import { resolveSpec } from '../report/spec.js';
import { todayISO } from '../utils/dates.js';
import { log, runAction } from '../utils/logger.js';

export function registerTodayCommand(program: Command): void {
  program
    .command('today')
    .description('Quick overview: branch, working tree, stashes, pending merges and sync status')
    .action(runAction(todayAction));
}

async function todayAction(): Promise<void> {
  const git = new GitService();
  const root = await git.ensureRepo();
  const config = await loadConfig(root);

  const branch = await git.currentBranch();
  const status = await git.status();
  const stashes = await git.stashCount();

  log.heading(`Today — ${todayISO()}`);

  log.plain(`  Branch:        ${chalk.cyan(branch)}`);
  log.plain(
    `  Working tree:  ${status.isClean() ? chalk.green('clean') : describeTree(status.modified.length, status.staged.length, status.not_added.length)}`,
  );
  if (status.modified.length > 0) {
    log.plain(`  Modified:      ${status.modified.join(', ')}`);
  }
  if (status.staged.length > 0) {
    log.plain(`  Staged:        ${status.staged.join(', ')}`);
  }
  if (status.conflicted.length > 0) {
    log.plain(`  Conflicted:    ${chalk.red(status.conflicted.join(', '))}`);
  }
  log.plain(`  Stashes:       ${stashes}`);

  if ((await git.branchExists(config.mainBranch)) && (await git.branchExists(config.workBranch))) {
    const pending = await git.commitsAhead(config.workBranch, config.mainBranch);
    log.plain(
      `  Pending merge: ${
        pending === 0
          ? chalk.green(`${config.workBranch} is up to date with ${config.mainBranch}`)
          : chalk.yellow(
              `${config.mainBranch} has ${pending} commit${pending === 1 ? '' : 's'} not in ${config.workBranch} — run "git merge ${config.mainBranch}"`,
            )
      }`,
    );

    const lastSync = await git.lastCommitMatching(config.mainBranch, config.syncCommitPrefix);
    log.plain(
      `  Last sync:     ${
        lastSync
          ? `${lastSync.message} ${chalk.dim(`(${lastSync.relDate})`)}`
          : chalk.dim('no production imports yet')
      }`,
    );

    const report = await buildReport(git, config, resolveSpec({ date: todayISO() }));
    log.plain(
      `  Today so far:  ${report.devCommits.length} dev commit${report.devCommits.length === 1 ? '' : 's'}, ${report.productionImports.length} import${report.productionImports.length === 1 ? '' : 's'}`,
    );

    // Anything that needs a decision gets named here rather than left to be
    // discovered later, when the cause is no longer obvious.
    const merge = await git.mergeState();
    const strandedStashes = (await git.stashListDetailed()).filter((s) =>
      s.subject.includes('worklog: auto-stash'),
    );
    if (merge.inProgress || strandedStashes.length > 0) {
      log.plain('');
      if (merge.inProgress) log.warn('A merge is unfinished in this repository.');
      if (strandedStashes.length > 0) log.warn('worklog left a stash behind.');
      log.dim('  Run "worklog doctor" for the details and the way out.');
    }
  } else {
    log.warn(
      `Branches "${config.mainBranch}"/"${config.workBranch}" not found — sync status unavailable.`,
    );
  }
}

function describeTree(modified: number, staged: number, untracked: number): string {
  const parts: string[] = [];
  if (modified > 0) parts.push(chalk.yellow(`${modified} modified`));
  if (staged > 0) parts.push(chalk.green(`${staged} staged`));
  if (untracked > 0) parts.push(chalk.magenta(`${untracked} untracked`));
  return parts.join(', ') || 'clean';
}
