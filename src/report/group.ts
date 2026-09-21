import type { AreaGroup, CommitInfo, FileChange } from '../types/index.js';

/**
 * The area a file belongs to: its real directory, exactly as it sits on disk
 * and on the server.
 *
 * Nothing is folded away and nothing is invented. The first segment is the
 * vhost when it looks like one, so reports can be read website by website,
 * but it stays in the key — `uniprouniforms.com/up/lib/modules` is the path a
 * reader can paste into an SFTP client, which `lib/modules` was not. Files
 * sitting directly in the repo root get an empty directory rather than a
 * placeholder like `(root)`.
 */
export function areaKey(filePath: string): { key: string; host: string; dir: string } {
  const segs = filePath.split('/').filter(Boolean);
  let host = '';
  const first = segs[0] ?? '';
  if (/\.(com|net|org)$/.test(first) || first === 'globalTools') {
    host = first;
    segs.shift();
  }
  const dir = segs.slice(0, -1).join('/');
  const key = [host, dir].filter(Boolean).join('/');
  return { key: key || ROOT_KEY, host, dir };
}

/** What a file sitting directly in the repository root is filed under. */
export const ROOT_KEY = 'repository root';

/**
 * A shortened form of a key, for places that need a headline rather than a
 * path — the standup block, where a full path per line would bury the commit
 * subjects it exists to show.
 */
export function shortLabel(key: string, maxSegments = 3): string {
  const segs = key.split('/').filter(Boolean);
  if (segs.length <= maxSegments) return key;
  return `${segs[0]}/…/${segs.slice(-(maxSegments - 1)).join('/')}`;
}

/**
 * Sort areas by website, then by directory, both alphabetically. Paths with no
 * vhost — repo-level notes, shared tool folders — sort after the websites
 * rather than jumping to the top on an empty host string.
 */
function byPath(a: AreaGroup, b: AreaGroup): number {
  if (!a.host !== !b.host) return a.host ? -1 : 1;
  return a.host.localeCompare(b.host) || a.dir.localeCompare(b.dir) || a.key.localeCompare(b.key);
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

  for (const area of areas.values()) {
    area.files.sort((a, b) => a.path.localeCompare(b.path));
  }

  return [...areas.values()].sort(byPath);
}

/**
 * Collapse the deepest path segment until the list fits. Purely a display
 * concern for summaries that must stay short; the file listings do not use it,
 * because merging `lib/modules` into `lib` would report a directory the work
 * never touched.
 */
export function rollUp(areas: AreaGroup[], max: number): AreaGroup[] {
  let current = areas;
  let guard = 0;
  while (current.length > max && guard < 12) {
    guard += 1;
    const merged = new Map<string, AreaGroup>();
    let changed = false;
    for (const area of current) {
      const parts = area.dir ? area.dir.split('/') : [];
      if (parts.length > 1) {
        parts.pop();
        changed = true;
      }
      const dir = parts.join('/');
      const key = [area.host, dir].filter(Boolean).join('/') || ROOT_KEY;
      const existing = merged.get(key);
      if (existing) {
        existing.commits.push(...area.commits);
        existing.files.push(...area.files);
      } else {
        merged.set(key, { key, host: area.host, dir, commits: [...area.commits], files: [...area.files] });
      }
    }
    if (!changed) break;
    current = [...merged.values()].sort(byPath);
  }
  return current;
}
