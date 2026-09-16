import type { Burst, CommitInfo } from '../types/index.js';

/**
 * Cluster commits into bursts of activity separated by a quiet gap.
 *
 * Deliberately reports only what git actually recorded — when the first and
 * last commit of each burst landed, and how many there were. No "active
 * minutes" or "estimated hours": a commit timestamp says when work was
 * saved, not how long it took, and a number invented here would end up in
 * someone's timesheet.
 */
export function buildBursts(commits: CommitInfo[], gapMinutes: number): Burst[] {
  const stamps = commits
    .map((c) => ({ day: c.day, time: c.time, minutes: toMinutes(c.day, c.time) }))
    .filter((s) => s.minutes !== null)
    .sort((a, b) => (a.minutes ?? 0) - (b.minutes ?? 0));

  const bursts: Burst[] = [];
  let current: { first: string; last: string; count: number; lastAt: number } | null = null;

  for (const stamp of stamps) {
    const at = stamp.minutes!;
    const label = `${stamp.day} ${stamp.time}`;
    if (current && at - current.lastAt <= gapMinutes) {
      current.last = label;
      current.count += 1;
      current.lastAt = at;
      continue;
    }
    if (current) {
      bursts.push({
        firstCommitAt: current.first,
        lastCommitAt: current.last,
        commitCount: current.count,
      });
    }
    current = { first: label, last: label, count: 1, lastAt: at };
  }

  if (current) {
    bursts.push({
      firstCommitAt: current.first,
      lastCommitAt: current.last,
      commitCount: current.count,
    });
  }

  return bursts;
}

/** Minutes since epoch-day, from the strings git already formatted for us. */
function toMinutes(day: string, time: string): number | null {
  const dayMatch = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = time.match(/^(\d{2}):(\d{2})$/);
  if (!dayMatch || !timeMatch) return null;
  const [, y = '0', m = '0', d = '0'] = dayMatch;
  const [, hh = '0', mm = '0'] = timeMatch;
  const days = Date.UTC(Number(y), Number(m) - 1, Number(d)) / 86_400_000;
  return days * 1440 + Number(hh) * 60 + Number(mm);
}
