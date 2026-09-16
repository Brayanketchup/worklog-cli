import type { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import { GitService } from '../git/repo.js';
import { buildReport } from '../report/generator.js';
import { resolveSpec } from '../report/spec.js';
import { log, runAction } from '../utils/logger.js';

interface LogOptions {
  last?: string;
}

/**
 * An index of recent working days — the way back into older reports.
 *
 * Each row names a date that can be handed straight to `worklog report -d`
 * or `worklog files -d`, so finding what was done three weeks ago does not
 * require guessing which days had activity.
 */
export function registerLogCommand(program: Command): void {
  program
    .command('log')
    .description('List recent days that have work, as a way back into their reports')
    .option('--last <days>', 'how many days back to scan (default 30)')
    .action(runAction(logAction));
}

async function logAction(options: LogOptions): Promise<void> {
  const git = new GitService();
  git.setReadOnly(true);
  const root = await git.ensureRepo();
  const config = await loadConfig(root);

  const days = options.last ?? '30';
  const spec = resolveSpec({ last: days });
  const data = await buildReport(git, config, spec);

  log.heading(`Work log — ${spec.label}`);

  if (data.days.length === 0) {
    log.plain(chalk.dim('  no activity in this range'));
    return;
  }

  log.plain('');
  for (const day of [...data.days].reverse()) {
    const dev = day.devCommits.length;
    const imports = day.syncCommits.length;
    const parts: string[] = [];
    if (dev > 0) parts.push(chalk.green(`${dev} commit${dev === 1 ? '' : 's'}`));
    if (imports > 0) parts.push(chalk.yellow(`${imports} import${imports === 1 ? '' : 's'}`));

    const first = day.devCommits[0];
    const headline = first ? chalk.dim(` ${first.message}`) : '';
    log.plain(`  ${chalk.cyan(day.day)}  ${parts.join(', ').padEnd(30)}${headline}`);
  }

  log.plain('');
  log.dim('  worklog report -d <date>     full report for that day');
  log.dim('  worklog files  -d <date>     just the files that changed');
  log.dim('  worklog report -d <date> --code   the actual lines changed');
}
