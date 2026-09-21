import type { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import { GitService } from '../git/repo.js';
import { flattenAreaFiles, lineStats } from '../report/render/shared.js';
import { log, runAction } from '../utils/logger.js';
import { loadReport, renderOptions, type ReportOptions } from './report.js';

/**
 * Just the list of files that changed — the question asked most often when
 * looking back at a day's work, without the rest of a full report.
 */
export function registerFilesCommand(program: Command): void {
  program
    .command('files')
    .description('List the files changed on a day, over a range, or in one commit')
    .option('-d, --date <date>', 'a single day, YYYY-MM-DD (defaults to today)')
    .option('--since <date>', 'start of a range, YYYY-MM-DD')
    .option('--until <date>', 'end of a range, YYYY-MM-DD')
    .option('--last <days>', 'the last N days, ending today')
    .option('--commit <ref>', 'one specific commit')
    .option('--stats', 'show the +N -M line counts next to each file')
    .option('--group <mode>', 'group by dir or none (default dir)')
    .option('--paths', 'print bare repo-relative paths, one per line')
    .action(runAction(filesAction));
}

async function filesAction(options: ReportOptions & { paths?: boolean }): Promise<void> {
  const git = new GitService();
  git.setReadOnly(true);
  const root = await git.ensureRepo();
  const config = await loadConfig(root);

  const data = await loadReport(options, config, git);
  const opts = renderOptions(options);

  if (options.paths) {
    for (const file of data.filesModified) log.plain(file.path);
    return;
  }

  log.heading(`Files changed — ${data.spec.label}`);
  if (data.filesModified.length === 0) {
    log.plain(chalk.dim('  (none)'));
    return;
  }

  if (opts.group === 'dir') {
    for (const file of flattenAreaFiles(data.areas)) {
      const stats = opts.stats ? chalk.dim(` (${lineStats(file)})`) : '';
      const where = file.commits?.length ? chalk.dim(` [${file.commits.join(', ')}]`) : '';
      log.plain(`  ${chalk.dim('•')} ${chalk.cyan(file.path)}${stats}${where}`);
    }
  } else {
    for (const file of data.filesModified) {
      const stats = opts.stats ? chalk.dim(` (${lineStats(file)})`) : '';
      log.plain(`  ${chalk.dim('•')} ${file.path}${stats}`);
    }
  }

  log.plain('');
  log.plain(
    chalk.dim(
      `  ${data.filesModified.length} file(s)${
        opts.stats ? '' : ' — line counts hidden, rerun with --stats'
      }`,
    ),
  );
  log.dim('  See the changed lines with: worklog report --code');
}
