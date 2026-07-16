import path from 'node:path';
import chalk from 'chalk';
import type { WorklogConfig } from '../config/config.js';
import type { GitService } from '../git/repo.js';
import type { CommitInfo, FileChange, ReportData } from '../types/index.js';
import { dayRange } from '../utils/dates.js';

/** Collect everything `worklog report` needs for a given day. */
export async function buildReport(
  git: GitService,
  config: WorklogConfig,
  date: string,
): Promise<ReportData> {
  const { since, until } = dayRange(date);

  // Development work is exactly what exists on work but not on main:
  // merged-in snapshots and pre-existing main history drop out of the range.
  const workLog = await git.logWithStats({
    branch: `${config.mainBranch}..${config.workBranch}`,
    since,
    until,
    noMerges: true,
  });
  const mainLog = await git.logWithStats({
    branch: config.mainBranch,
    since,
    until,
    noMerges: true,
  });

  const isSync = (c: CommitInfo) => c.message.startsWith(config.syncCommitPrefix);

  const devCommits = workLog.filter((c) => !isSync(c));
  const syncCommits = mainLog.filter(isSync);

  const filesModified = mergeFileChanges(devCommits.flatMap((c) => c.files));
  const productionImports = [
    ...new Set(syncCommits.flatMap((c) => c.files.map((f) => path.basename(f.path)))),
  ];

  const totals = filesModified.reduce(
    (acc, f) => ({
      insertions: acc.insertions + (f.insertions ?? 0),
      deletions: acc.deletions + (f.deletions ?? 0),
    }),
    { insertions: 0, deletions: 0 },
  );

  return { date, devCommits, syncCommits, filesModified, productionImports, totals };
}

/** Combine per-commit stats into one entry per file. */
function mergeFileChanges(changes: FileChange[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const change of changes) {
    const existing = byPath.get(change.path);
    if (!existing) {
      byPath.set(change.path, { ...change });
      continue;
    }
    if (change.insertions !== null) {
      existing.insertions = (existing.insertions ?? 0) + change.insertions;
    }
    if (change.deletions !== null) {
      existing.deletions = (existing.deletions ?? 0) + change.deletions;
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function lineStats(file: FileChange): string {
  if (file.insertions === null && file.deletions === null) return 'binary';
  return `+${file.insertions ?? 0} -${file.deletions ?? 0}`;
}

/** Render the report for the terminal (chalk-colored). */
export function renderTerminal(data: ReportData): string {
  const lines: string[] = [];
  const push = (s = '') => lines.push(s);

  push(chalk.bold.underline(`Work Report — ${data.date}`));

  push('');
  push(chalk.bold('Development Commits'));
  if (data.devCommits.length === 0) {
    push(chalk.dim('  (none)'));
  }
  for (const commit of data.devCommits) {
    push(`  ${chalk.green('•')} ${commit.message} ${chalk.dim(`(${commit.shortHash})`)}`);
  }

  push('');
  push(chalk.bold('Files Modified'));
  if (data.filesModified.length === 0) {
    push(chalk.dim('  (none)'));
  }
  for (const file of data.filesModified) {
    push(`  ${file.path} ${chalk.dim(`(${lineStats(file)})`)}`);
  }

  push('');
  push(chalk.bold('Production Imports'));
  if (data.productionImports.length === 0) {
    push(chalk.dim('  (none)'));
  }
  for (const name of data.productionImports) {
    push(`  ${chalk.yellow('•')} ${name}`);
  }

  push('');
  push(chalk.bold('Summary'));
  push(`  Development commits: ${data.devCommits.length}`);
  push(`  Production imports:  ${data.productionImports.length}`);
  push(`  Files touched:       ${data.filesModified.length + data.productionImports.length}`);
  push(`  Lines:               ${chalk.green(`+${data.totals.insertions}`)} ${chalk.red(`-${data.totals.deletions}`)}`);

  return lines.join('\n');
}

/** Render the report as Markdown (for --markdown / --output). */
export function renderMarkdown(data: ReportData): string {
  const lines: string[] = [];
  const push = (s = '') => lines.push(s);

  push(`# Work Report — ${data.date}`);
  push('');
  push('## Development Commits');
  push('');
  if (data.devCommits.length === 0) push('_(none)_');
  for (const commit of data.devCommits) {
    push(`- ${commit.message} (\`${commit.shortHash}\`)`);
  }
  push('');
  push('## Files Modified');
  push('');
  if (data.filesModified.length === 0) push('_(none)_');
  for (const file of data.filesModified) {
    push(`- \`${file.path}\` (${lineStats(file)})`);
  }
  push('');
  push('## Production Imports');
  push('');
  if (data.productionImports.length === 0) push('_(none)_');
  for (const name of data.productionImports) {
    push(`- \`${name}\``);
  }
  push('');
  push('## Summary');
  push('');
  push('| Metric | Value |');
  push('| --- | --- |');
  push(`| Development commits | ${data.devCommits.length} |`);
  push(`| Production imports | ${data.productionImports.length} |`);
  push(`| Files touched | ${data.filesModified.length + data.productionImports.length} |`);
  push(`| Lines added | ${data.totals.insertions} |`);
  push(`| Lines removed | ${data.totals.deletions} |`);
  push('');
  return lines.join('\n');
}
