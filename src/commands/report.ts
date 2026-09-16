import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { loadConfig, type WorklogConfig } from '../config/config.js';
import { GitService } from '../git/repo.js';
import { buildReport } from '../report/generator.js';
import { resolveSpec } from '../report/spec.js';
import { renderJson } from '../report/render/json.js';
import { renderMarkdown } from '../report/render/markdown.js';
import { renderStandup } from '../report/render/standup.js';
import { renderTerminal } from '../report/render/terminal.js';
import type { RenderOptions } from '../report/render/shared.js';
import type { ReportData } from '../types/index.js';
import { WorklogError } from '../utils/errors.js';
import { log, runAction } from '../utils/logger.js';

export interface ReportOptions {
  date?: string;
  since?: string;
  until?: string;
  last?: string;
  commit?: string;
  stats?: boolean;
  code?: boolean;
  context?: string;
  maxLines?: string;
  maxFileLines?: string;
  only?: string;
  group?: string;
  format?: string;
  markdown?: boolean;
  output?: string;
}

export function registerReportCommand(program: Command): void {
  program
    .command('report')
    .description("Report the day's (or a range's) development commits and production imports")
    .option('-d, --date <date>', 'a single day, YYYY-MM-DD (defaults to today)')
    .option('--since <date>', 'start of a range, YYYY-MM-DD')
    .option('--until <date>', 'end of a range, YYYY-MM-DD (defaults to today)')
    .option('--last <days>', 'the last N days, ending today')
    .option('--commit <ref>', 'one specific commit')
    .option('--stats', 'show the +N -M line counts next to each file')
    .option('--code', 'show the actual changed lines')
    .option('--context <n>', 'lines of context around each change (default 3)')
    .option('--max-lines <n>', 'total diff lines to print (default 400)')
    .option('--max-file-lines <n>', 'diff lines per file (default 80)')
    .option('--only <text>', 'with --code, only files whose path contains this text')
    .option('--group <mode>', 'group files by dir or none (default dir)')
    .option('--format <fmt>', 'terminal, markdown, json or standup')
    .option('--markdown', 'alias for --format markdown')
    .option('-o, --output <file>', 'write the report to a file (.md, .txt or .json)')
    .action(runAction(reportAction));
}

/** Shared by report/files/log: build the data for whatever range was asked for. */
export async function loadReport(
  options: ReportOptions,
  config: WorklogConfig,
  git: GitService,
): Promise<ReportData> {
  const spec = resolveSpec(options);
  const code = options.code
    ? {
        context: intOption(options.context, config.diffContext, '--context'),
        maxFileLines: intOption(options.maxFileLines, config.diffMaxFileLines, '--max-file-lines'),
        maxLines: intOption(options.maxLines, config.diffMaxLines, '--max-lines'),
        only: options.only,
      }
    : undefined;
  return buildReport(git, config, spec, { code });
}

export function renderOptions(options: ReportOptions): RenderOptions {
  const group = options.group ?? 'dir';
  if (!['dir', 'day', 'none'].includes(group)) {
    throw new WorklogError(`Unknown --group "${group}".`, 'Use dir or none.');
  }
  return {
    stats: Boolean(options.stats),
    code: Boolean(options.code),
    group: group as RenderOptions['group'],
  };
}

async function reportAction(options: ReportOptions): Promise<void> {
  const git = new GitService();
  git.setReadOnly(true);
  const root = await git.ensureRepo();
  const config = await loadConfig(root);

  const data = await loadReport(options, config, git);
  const opts = renderOptions(options);
  const format = resolveFormat(options);

  const text =
    format === 'markdown'
      ? renderMarkdown(data, opts)
      : format === 'json'
        ? renderJson(data, opts)
        : format === 'standup'
          ? renderStandup(data)
          : renderTerminal(data, opts);

  if (options.output) {
    const target = await safeOutputPath(options.output, root, git);
    const body = format === 'terminal' ? renderMarkdown(data, opts) : text;
    await writeFile(target, body, 'utf8');
    log.success(`Report written to ${target}`);
    return;
  }

  log.plain(text);
}

function resolveFormat(options: ReportOptions): string {
  if (options.format) {
    if (!['terminal', 'markdown', 'json', 'standup'].includes(options.format)) {
      throw new WorklogError(
        `Unknown --format "${options.format}".`,
        'Use terminal, markdown, json or standup.',
      );
    }
    return options.format;
  }
  if (options.markdown) return 'markdown';
  if (options.output) return 'markdown';
  return 'terminal';
}

function intOption(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new WorklogError(`${flag} needs a non-negative number, got "${raw}".`);
  }
  return value;
}

/**
 * Decide where a report may be written.
 *
 * The working tree of these repositories *is* the deployment payload, so a
 * report accidentally written over a source file would be uploaded to the
 * server. A tracked file is therefore never a valid target, with no override.
 */
async function safeOutputPath(output: string, root: string, git: GitService): Promise<string> {
  const target = path.resolve(process.cwd(), output);
  const ext = path.extname(target).toLowerCase();
  if (!['.md', '.txt', '.json'].includes(ext)) {
    throw new WorklogError(
      `Refusing to write a report to "${output}".`,
      'Use a .md, .txt or .json file name.',
    );
  }

  const rel = path.relative(root, target).split(path.sep).join('/');
  const insideRepo = !rel.startsWith('..') && !path.isAbsolute(rel);

  // The one hard rule: never write over a file git is tracking. This working
  // tree is the deploy payload, so a report landing on a source file would be
  // uploaded to the server. There is no --force for this.
  if (insideRepo && (await git.isTracked(rel))) {
    throw new WorklogError(
      `${rel} is a tracked file in this repository.`,
      'Reports must never overwrite source: this working tree is what gets deployed.',
    );
  }

  // Writing an untracked report inside the repo is allowed — a reports/ folder
  // in the repo is a documented habit — but it is worth saying out loud, since
  // an untracked file here can still be swept up by "worklog commit --all".
  if (insideRepo) {
    log.warn(`${rel} is inside the repository; it could be committed by "commit --all".`);
  }

  return target;
}
