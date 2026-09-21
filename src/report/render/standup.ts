import type { ReportData } from '../../types/index.js';
import { rollUp, shortLabel } from '../group.js';

/**
 * A short block to paste into a standup note or a timesheet comment.
 *
 * Deliberately mechanical: it restates commit subjects grouped by area and
 * nothing else. It does not summarize or paraphrase, because anything beyond
 * what the commits literally say would be invention.
 */
export function renderStandup(data: ReportData): string {
  const lines: string[] = [];
  lines.push(`Work — ${data.spec.label}`);

  if (data.devCommits.length === 0) {
    lines.push('  no development commits');
  } else {
    for (const area of rollUp(data.areas, 8)) {
      if (area.commits.length === 0) continue;
      const shown = area.commits.slice(0, 3).map((c) => c.message);
      const extra = area.commits.length - shown.length;
      const tail = extra > 0 ? ` (+${extra} more)` : '';
      lines.push(
        `  ${shortLabel(area.key)}: ${area.commits.length} commit${
          area.commits.length === 1 ? '' : 's'
        } — ${shown.join('; ')}${tail}`,
      );
    }
  }

  if (data.productionImports.length > 0) {
    lines.push(`  imported ${data.productionImports.length} file(s) from the server`);
  }

  return lines.join('\n');
}
