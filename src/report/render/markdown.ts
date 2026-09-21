import type { ReportData } from '../../types/index.js';
import {
  burstSummary,
  excludedNote,
  flattenAreaFiles,
  lineStats,
  statsHint,
  type RenderOptions,
} from './shared.js';

/** Render a report as Markdown. Files are always bullets. */
export function renderMarkdown(data: ReportData, opts: RenderOptions): string {
  const lines: string[] = [];
  const push = (s = '') => lines.push(s);

  push(`# Work Report — ${data.spec.label}`);
  const summary = burstSummary(data);
  if (summary) {
    push('');
    push(`_${summary}_`);
  }

  push('');
  push('## Development Commits');
  push('');
  if (data.devCommits.length === 0) push('_(none)_');
  for (const commit of data.devCommits) {
    push(`- ${commit.message} (\`${commit.shortHash}\`, ${commit.day} ${commit.time})`);
  }

  push('');
  push('## Files Modified');
  push('');
  if (data.filesModified.length === 0) push('_(none)_');
  else if (opts.group === 'dir') {
    for (const file of flattenAreaFiles(data.areas)) {
      push(`- \`${file.path}\`${opts.stats ? ` (${lineStats(file)})` : ''}`);
    }
  } else {
    for (const file of data.filesModified) {
      push(`- \`${file.path}\`${opts.stats ? ` (${lineStats(file)})` : ''}`);
    }
  }
  const hint = statsHint(opts);
  if (hint && data.filesModified.length > 0) {
    push('');
    push(`_${hint}_`);
  }

  if (opts.code && data.diffs.length > 0) {
    push('');
    push('## Changed Lines');
    for (const diff of data.diffs) {
      push('');
      push(`### ${diff.path} (\`${diff.commit}\`)`);
      push('');
      if (diff.binary) {
        push('_(binary file)_');
        continue;
      }
      push('```diff');
      for (const line of diff.lines) push(line);
      push('```');
      if (diff.truncated > 0) push(`_… ${diff.truncated} more lines omitted_`);
    }
    if (data.diffBudget && data.diffBudget.filesOmitted > 0) {
      push('');
      push(`_${data.diffBudget.filesOmitted} more file(s) not shown — raise --max-lines_`);
    }
  }

  push('');
  push('## Production Imports');
  push('');
  if (data.productionImports.length === 0) push('_(none)_');
  for (const name of data.productionImports) push(`- \`${name}\``);

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
  push(`_${excludedNote(data)}_`);
  push('');
  return lines.join('\n');
}
