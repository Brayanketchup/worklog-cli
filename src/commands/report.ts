import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../config/config.js';
import { GitService } from '../git/repo.js';
import { buildReport, renderMarkdown, renderTerminal } from '../report/generator.js';
import { todayISO, validateDate } from '../utils/dates.js';
import { log, runAction } from '../utils/logger.js';

interface ReportOptions {
  date?: string;
  markdown?: boolean;
  output?: string;
}

export function registerReportCommand(program: Command): void {
  program
    .command('report')
    .description("Generate a report of the day's development commits and production imports")
    .option('-d, --date <date>', 'report date as YYYY-MM-DD (defaults to today)')
    .option('--markdown', 'print the report as Markdown instead of colored text')
    .option('-o, --output <file>', 'write the Markdown report to a file')
    .action(runAction(reportAction));
}

async function reportAction(options: ReportOptions): Promise<void> {
  const git = new GitService();
  const root = await git.ensureRepo();
  const config = await loadConfig(root);

  const date = options.date ? validateDate(options.date) : todayISO();
  const data = await buildReport(git, config, date);

  if (options.output) {
    const target = path.resolve(process.cwd(), options.output);
    await writeFile(target, renderMarkdown(data), 'utf8');
    log.success(`Report written to ${target}`);
    return;
  }

  log.plain(options.markdown ? renderMarkdown(data) : renderTerminal(data));
}
