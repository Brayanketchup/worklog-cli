import type { FileChange, ReportData } from '../../types/index.js';

export interface RenderOptions {
  /** Show the +N -M counts next to each file. Hidden unless asked for. */
  stats: boolean;
  /** Include the actual changed lines. */
  code: boolean;
  /** Group files by directory rather than listing them flat. */
  group: 'dir' | 'day' | 'none';
}

export const DEFAULT_RENDER: RenderOptions = { stats: false, code: false, group: 'dir' };

export function lineStats(file: FileChange): string {
  if (file.binary) return 'binary';
  return `+${file.insertions ?? 0} -${file.deletions ?? 0}`;
}

/** The note that tells the reader how to see what is being withheld. */
export function statsHint(opts: RenderOptions): string | null {
  return opts.stats ? null : 'line counts hidden — rerun with --stats';
}

export function excludedNote(data: ReportData): string {
  const parts: string[] = [];
  parts.push(`${data.excluded.merges} merge commit${data.excluded.merges === 1 ? '' : 's'}`);
  parts.push(`${data.excluded.sync} sync commit${data.excluded.sync === 1 ? '' : 's'}`);
  return `excluded: ${parts.join(', ')}`;
}

export function burstSummary(data: ReportData): string | null {
  if (data.bursts.length === 0) return null;
  const first = data.bursts[0]!;
  const last = data.bursts[data.bursts.length - 1]!;
  const count = data.devCommits.length;
  return `${count} commit${count === 1 ? '' : 's'} · first ${time(first.firstCommitAt)}, last ${time(
    last.lastCommitAt,
  )} · ${data.bursts.length} burst${data.bursts.length === 1 ? '' : 's'}`;
}

function time(stamp: string): string {
  return stamp.split(' ')[1] ?? stamp;
}
