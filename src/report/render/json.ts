import type { ReportData } from '../../types/index.js';
import { lineStats, statsHint, type RenderOptions } from './shared.js';

/** Machine-readable report, for an assistant or a script to consume. */
export function renderJson(data: ReportData, opts: RenderOptions): string {
  const payload = {
    schemaVersion: 1,
    range: data.spec,
    summary: {
      devCommits: data.devCommits.length,
      productionImports: data.productionImports.length,
      filesTouched: data.filesModified.length + data.productionImports.length,
      insertions: data.totals.insertions,
      deletions: data.totals.deletions,
      excluded: data.excluded,
      statsHidden: !opts.stats,
      note: statsHint(opts),
    },
    bursts: data.bursts,
    days: data.days.map((d) => ({
      day: d.day,
      devCommits: d.devCommits.length,
      syncCommits: d.syncCommits.length,
    })),
    commits: data.devCommits.map((c) => ({
      hash: c.shortHash,
      day: c.day,
      time: c.time,
      message: c.message,
      files: c.files.map((f) => f.path),
    })),
    areas: data.areas.map((a) => ({
      key: a.key,
      host: a.host,
      dir: a.dir,
      commits: a.commits.length,
      files: a.files.map((f) => f.path),
    })),
    files: data.filesModified.map((f) => ({
      path: f.path,
      binary: Boolean(f.binary),
      commits: f.commits ?? [],
      ...(opts.stats
        ? { insertions: f.insertions, deletions: f.deletions, stats: lineStats(f) }
        : {}),
    })),
    productionImports: data.productionImports,
    ...(opts.code ? { diffs: data.diffs, diffBudget: data.diffBudget } : {}),
  };
  return JSON.stringify(payload, null, 2);
}
