import path from 'node:path';
import type { WorklogConfig } from '../config/config.js';
import type { GitService } from '../git/repo.js';
import type {
  CommitInfo,
  DayBucket,
  FileChange,
  ReportData,
  ReportSpec,
} from '../types/index.js';
import { rangeBounds } from '../utils/dates.js';
import { WorklogError } from '../utils/errors.js';
import { buildAreas } from './group.js';
import { buildBursts } from './bursts.js';
import { collectDiffs, type DiffOptions } from './diff.js';

export interface BuildOptions {
  /** Fetch the actual changed lines. Costs one git call per file. */
  code?: DiffOptions;
}

/** Collect everything the reporting commands need, for a day or a range. */
export async function buildReport(
  git: GitService,
  config: WorklogConfig,
  spec: ReportSpec,
  options: BuildOptions = {},
): Promise<ReportData> {
  const isSync = (c: CommitInfo) => c.message.startsWith(config.syncCommitPrefix);

  let devCommits: CommitInfo[] = [];
  let syncCommits: CommitInfo[] = [];
  let merges = 0;

  if (spec.kind === 'commit') {
    const commit = await git.commitWithStats(spec.ref!);
    if (!commit) {
      throw new WorklogError(`No commit matches "${spec.ref}".`, 'Pass a hash, tag or branch name.');
    }
    if (isSync(commit)) syncCommits = [commit];
    else devCommits = [commit];
  } else {
    const { since, until } = rangeBounds(spec.since!, spec.until!);

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
    const withMerges = await git.logWithStats({
      branch: `${config.mainBranch}..${config.workBranch}`,
      since,
      until,
    });

    // Snapshot commits reach the work branch through the merge, so they have
    // to be filtered by subject here as well as on main.
    devCommits = workLog.filter((c) => !isSync(c));
    syncCommits = mainLog.filter(isSync);
    merges = withMerges.length - workLog.length;
  }

  const excluded = { merges, sync: 0 };
  if (spec.kind !== 'commit') {
    excluded.sync = syncCommits.length;
  }

  const filesModified = mergeFileChanges(devCommits);
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

  const days = bucketByDay(spec, devCommits, syncCommits);
  const areas = buildAreas(devCommits, filesModified);
  const bursts = buildBursts(devCommits, config.sessionGapMinutes);

  let diffs: ReportData['diffs'] = [];
  let diffBudget: ReportData['diffBudget'] = null;
  if (options.code) {
    const collected = await collectDiffs(git, devCommits, options.code);
    diffs = collected.diffs;
    diffBudget = { linesDropped: collected.linesDropped, filesOmitted: collected.filesOmitted };
  }

  return {
    spec,
    date: spec.label,
    devCommits,
    syncCommits,
    filesModified,
    productionImports,
    days,
    areas,
    bursts,
    diffs,
    diffBudget,
    excluded,
    totals,
  };
}

/** One bucket per calendar day in range, using git's own date strings. */
function bucketByDay(
  spec: ReportSpec,
  devCommits: CommitInfo[],
  syncCommits: CommitInfo[],
): DayBucket[] {
  if (spec.kind === 'commit') {
    const all = [...devCommits, ...syncCommits];
    const day = all[0]?.day ?? spec.label;
    return [{ day, devCommits, syncCommits }];
  }

  // Buckets come from the commits themselves rather than from every date in
  // the range: empty days are filtered out below anyway, and an open-ended
  // `--until` would otherwise enumerate decades of them.
  const buckets = new Map<string, DayBucket>();
  const ensure = (day: string): DayBucket => {
    let bucket = buckets.get(day);
    if (!bucket) {
      bucket = { day, devCommits: [], syncCommits: [] };
      buckets.set(day, bucket);
    }
    return bucket;
  };
  for (const commit of devCommits) ensure(commit.day).devCommits.push(commit);
  for (const commit of syncCommits) ensure(commit.day).syncCommits.push(commit);

  return [...buckets.values()]
    .filter((b) => b.devCommits.length > 0 || b.syncCommits.length > 0)
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Combine per-commit stats into one entry per file. */
function mergeFileChanges(commits: CommitInfo[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const commit of commits) {
    for (const change of commit.files) {
      const existing = byPath.get(change.path);
      if (!existing) {
        byPath.set(change.path, { ...change, commits: [commit.shortHash] });
        continue;
      }
      if (change.insertions !== null) {
        existing.insertions = (existing.insertions ?? 0) + change.insertions;
      }
      if (change.deletions !== null) {
        existing.deletions = (existing.deletions ?? 0) + change.deletions;
      }
      if (change.binary) existing.binary = true;
      if (!existing.commits?.includes(commit.shortHash)) existing.commits?.push(commit.shortHash);
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export { mergeFileChanges };
