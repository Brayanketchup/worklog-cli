import type { AreaGroup, CommitInfo, FileChange } from '../types/index.js';

/**
 * The area a file belongs to: its real directory, never anything inferred.
 *
 * Only two segments are folded away — the vhost, because every path in these
 * repositories starts with one, and the `up/` that every vhost repeats. What
 * remains is the actual directory, so `lib/requires` and `lib/modules` stay
 * distinct areas instead of collapsing into a single misleading bucket.
 */
export function areaKey(filePath: string): { key: string; host: string; dir: string } {
  const segs = filePath.split('/').filter(Boolean);
  let host = '(repo)';
  const first = segs[0] ?? '';
  if (/\.(com|net|org)$/.test(first) || first === 'globalTools') {
    host = first;
    segs.shift();
  }
  if (segs[0] === 'up') segs.shift();
  const dir = segs.slice(0, -1).join('/') || '(root)';
  return { key: `${host}/${dir}`, host, dir };
}

/** Group commits and files by the directory the work actually happened in. */
export function buildAreas(commits: CommitInfo[], files: FileChange[]): AreaGroup[] {
  const areas = new Map<string, AreaGroup>();

  const ensure = (path: string): AreaGroup => {
    const { key, host, dir } = areaKey(path);
    let area = areas.get(key);
    if (!area) {
      area = { key, host, dir, commits: [], files: [] };
      areas.set(key, area);
    }
    return area;
  };

  for (const file of files) ensure(file.path).files.push(file);

  // A commit belongs to whichever area most of its files sit in; ties go to
  // the alphabetically first key so the same input always groups the same way.
  for (const commit of commits) {
    const tally = new Map<string, number>();
    for (const file of commit.files) {
      const { key } = areaKey(file.path);
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    if (tally.size === 0) continue;
    const winner = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    const first = commit.files.find((f) => areaKey(f.path).key === winner[0]);
    if (first) ensure(first.path).commits.push(commit);
  }

  return [...areas.values()].sort(
    (a, b) => b.commits.length - a.commits.length || a.key.localeCompare(b.key),
  );
}

/**
 * Collapse the deepest path segment until the list fits. Purely a display
 * concern, applied after grouping, so the underlying data stays truthful.
 */
export function rollUp(areas: AreaGroup[], max: number): AreaGroup[] {
  let current = areas;
  let guard = 0;
  while (current.length > max && guard < 12) {
    guard += 1;
    const merged = new Map<string, AreaGroup>();
    let changed = false;
    for (const area of current) {
      const parts = area.dir === '(root)' ? [] : area.dir.split('/');
      if (parts.length > 1) {
        parts.pop();
        changed = true;
      }
      const dir = parts.join('/') || '(root)';
      const key = `${area.host}/${dir}`;
      const existing = merged.get(key);
      if (existing) {
        existing.commits.push(...area.commits);
        existing.files.push(...area.files);
      } else {
        merged.set(key, { key, host: area.host, dir, commits: [...area.commits], files: [...area.files] });
      }
    }
    if (!changed) break;
    current = [...merged.values()].sort(
      (a, b) => b.commits.length - a.commits.length || a.key.localeCompare(b.key),
    );
  }
  return current;
}
