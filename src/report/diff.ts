import type { GitService } from '../git/repo.js';
import type { CommitInfo, FileDiff } from '../types/index.js';

export interface DiffOptions {
  context: number;
  maxFileLines: number;
  maxLines: number;
  /** Only include files whose path contains this substring. */
  only?: string;
}

/**
 * Collect the real changed lines for a set of commits, under a line budget.
 *
 * Diffs are fetched one file at a time with an explicit pathspec rather than
 * by parsing `diff --git` headers out of a combined patch: a filename with a
 * space in it makes those headers ambiguous, and this repository has some.
 * Binary files are known from numstat and never fetched at all.
 */
export async function collectDiffs(
  git: GitService,
  commits: CommitInfo[],
  opts: DiffOptions,
): Promise<{ diffs: FileDiff[]; linesDropped: number; filesOmitted: number }> {
  const diffs: FileDiff[] = [];
  let used = 0;
  let linesDropped = 0;
  let filesOmitted = 0;

  for (const commit of commits) {
    const files = [...commit.files].sort((a, b) => a.path.localeCompare(b.path));
    for (const file of files) {
      if (opts.only && !file.path.includes(opts.only)) continue;

      if (file.binary) {
        diffs.push({ path: file.path, commit: commit.shortHash, binary: true, lines: [], truncated: 0 });
        continue;
      }

      if (used >= opts.maxLines) {
        filesOmitted += 1;
        continue;
      }

      const raw = await git.diffForFile(commit.hash, file.path, { context: opts.context });
      const body = stripHeader(raw);
      if (body.length === 0) continue;

      let lines = body;
      let truncated = 0;
      if (lines.length > opts.maxFileLines) {
        lines = keepWholeHunks(lines, opts.maxFileLines);
        truncated = body.length - lines.length;
      }

      const remaining = opts.maxLines - used;
      if (lines.length > remaining) {
        lines = keepWholeHunks(lines, remaining);
        truncated = body.length - lines.length;
      }

      used += lines.length;
      linesDropped += truncated;
      diffs.push({
        path: file.path,
        commit: commit.shortHash,
        binary: false,
        lines,
        truncated,
      });
    }
  }

  return { diffs, linesDropped, filesOmitted };
}

/** Drop the `diff --git`/`index`/`---`/`+++` preamble, keep the hunks. */
function stripHeader(raw: string): string[] {
  const lines = raw.split('\n');
  const start = lines.findIndex((l) => l.startsWith('@@'));
  if (start === -1) return [];
  return lines.slice(start).filter((l, i, all) => !(i === all.length - 1 && l === ''));
}

/** Truncate at a hunk boundary so a partial hunk is never shown. */
function keepWholeHunks(lines: string[], budget: number): string[] {
  if (budget <= 0) return [];
  let lastBoundary = 0;
  for (let i = 0; i < lines.length && i < budget; i += 1) {
    if (lines[i]?.startsWith('@@') && i > 0) lastBoundary = i;
  }
  if (lines.length <= budget) return lines;
  return lines.slice(0, lastBoundary > 0 ? lastBoundary : budget);
}
