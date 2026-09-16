import chalk from 'chalk';
import type { ReportData } from '../../types/index.js';
import { rollUp } from '../group.js';
import { burstSummary, excludedNote, lineStats, statsHint, type RenderOptions } from './shared.js';

/** Render a report for the terminal. Files are always bullets. */
export function renderTerminal(data: ReportData, opts: RenderOptions): string {
  const lines: string[] = [];
  const push = (s = '') => lines.push(s);

  push(chalk.bold.underline(`Work Report — ${data.spec.label}`));
  const summary = burstSummary(data);
  if (summary) push(chalk.dim(`  ${summary}`));

  push('');
  push(chalk.bold('Development Commits'));
  if (data.devCommits.length === 0) push(chalk.dim('  (none)'));
  for (const commit of data.devCommits) {
    const when = data.spec.kind === 'day' ? commit.time : `${commit.day} ${commit.time}`;
    push(`  ${chalk.green('•')} ${commit.message} ${chalk.dim(`(${commit.shortHash}, ${when})`)}`);
  }

  push('');
  push(chalk.bold('Files Modified'));
  if (data.filesModified.length === 0) push(chalk.dim('  (none)'));
  else if (opts.group === 'dir') {
    for (const area of rollUp(data.areas, 12)) {
      if (area.files.length === 0) continue;
      push(`  ${chalk.cyan(area.key)}`);
      for (const file of area.files) {
        const name = file.path.split('/').pop() ?? file.path;
        push(`    ${chalk.dim('•')} ${name}${opts.stats ? chalk.dim(` (${lineStats(file)})`) : ''}`);
      }
    }
  } else {
    for (const file of data.filesModified) {
      push(`  ${chalk.dim('•')} ${file.path}${opts.stats ? chalk.dim(` (${lineStats(file)})`) : ''}`);
    }
  }
  const hint = statsHint(opts);
  if (hint && data.filesModified.length > 0) push(chalk.dim(`  ${hint}`));

  if (opts.code && data.diffs.length > 0) {
    push('');
    push(chalk.bold('Changed Lines'));
    for (const diff of data.diffs) {
      push('');
      push(`  ${chalk.cyan(diff.path)} ${chalk.dim(`(${diff.commit})`)}`);
      if (diff.binary) {
        push(chalk.dim('    (binary file)'));
        continue;
      }
      for (const line of diff.lines) push(`    ${colorize(line)}`);
      if (diff.truncated > 0) {
        push(chalk.dim(`    … ${diff.truncated} more lines — raise --max-file-lines to see them`));
      }
    }
    if (data.diffBudget && data.diffBudget.filesOmitted > 0) {
      push('');
      push(
        chalk.dim(
          `  ${data.diffBudget.filesOmitted} more file(s) not shown — raise --max-lines to include them`,
        ),
      );
    }
  }

  push('');
  push(chalk.bold('Production Imports'));
  if (data.productionImports.length === 0) push(chalk.dim('  (none)'));
  for (const name of data.productionImports) push(`  ${chalk.yellow('•')} ${name}`);

  push('');
  push(chalk.bold('Summary'));
  push(`  Development commits: ${data.devCommits.length}`);
  push(`  Production imports:  ${data.productionImports.length}`);
  push(`  Files touched:       ${data.filesModified.length + data.productionImports.length}`);
  push(
    `  Lines:               ${chalk.green(`+${data.totals.insertions}`)} ${chalk.red(
      `-${data.totals.deletions}`,
    )}`,
  );
  push(chalk.dim(`  ${excludedNote(data)}`));

  return lines.join('\n');
}

function colorize(line: string): string {
  if (line.startsWith('@@')) return chalk.cyan(line);
  if (line.startsWith('+')) return chalk.green(line);
  if (line.startsWith('-')) return chalk.red(line);
  return chalk.dim(line);
}
