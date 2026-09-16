/** A single file touched by a commit, with line stats from --numstat. */
export interface FileChange {
  path: string;
  /** null for binary files (git reports "-") */
  insertions: number | null;
  deletions: number | null;
  /** True when git reported "-" for both counts. */
  binary?: boolean;
  /** Short hashes of the commits that touched this file, in report order. */
  commits?: string[];
}

/** A parsed Git commit with per-file stats. */
export interface CommitInfo {
  hash: string;
  shortHash: string;
  /** ISO 8601 author date */
  date: string;
  /** Local calendar day (YYYY-MM-DD) as git formatted it — never re-parsed. */
  day: string;
  /** Local wall clock (HH:MM) as git formatted it. */
  time: string;
  /** Human-relative date, e.g. "2 hours ago" */
  relDate: string;
  author: string;
  /** Subject line */
  message: string;
  files: FileChange[];
}

/** Which commits a report covers. Exactly one shape is active. */
export interface ReportSpec {
  kind: 'day' | 'range' | 'commit';
  /** Inclusive local-day bounds (YYYY-MM-DD). Absent for kind === 'commit'. */
  since?: string;
  until?: string;
  /** A user-supplied git ref, only for kind === 'commit'. */
  ref?: string;
  /** Human label for headings, e.g. "2026-09-16" or "2026-09-10 .. 2026-09-16". */
  label: string;
}

/** One directory-derived area: where the work happened. */
export interface AreaGroup {
  /** e.g. "uniprouniforms.com/web/html/catalog" */
  key: string;
  /** Vhost or "(repo)". */
  host: string;
  /** Directory beneath the host, or "(root)". */
  dir: string;
  commits: CommitInfo[];
  files: FileChange[];
}

/** One calendar day inside a range. */
export interface DayBucket {
  day: string;
  devCommits: CommitInfo[];
  syncCommits: CommitInfo[];
}

/** A cluster of commits separated by more than the session gap. */
export interface Burst {
  firstCommitAt: string;
  lastCommitAt: string;
  commitCount: number;
}

/** One file's rendered diff, already budgeted and truncated. */
export interface FileDiff {
  path: string;
  /** Short hash of the commit this hunk set came from. */
  commit: string;
  binary: boolean;
  /** Raw unified-diff lines, hunk headers included. Empty when binary. */
  lines: string[];
  /** Lines dropped by the per-file budget. */
  truncated: number;
}

/** Aggregated data behind `worklog report`, `files` and `log`. */
export interface ReportData {
  spec: ReportSpec;
  /** Legacy single-day label, kept so existing renderers/consumers still work. */
  date: string;
  devCommits: CommitInfo[];
  syncCommits: CommitInfo[];
  /** Unique files touched by development commits in range. */
  filesModified: FileChange[];
  /** Unique files imported from the server in range. */
  productionImports: string[];
  days: DayBucket[];
  areas: AreaGroup[];
  bursts: Burst[];
  /** Populated only when --code was requested. */
  diffs: FileDiff[];
  /** How many lines --code dropped, and how many files it never reached. */
  diffBudget: { linesDropped: number; filesOmitted: number } | null;
  /** What was deliberately left out of the numbers. */
  excluded: { merges: number; sync: number };
  totals: {
    insertions: number;
    deletions: number;
  };
}

/** One path's state in the working tree, as reported by `worklog review`. */
export interface PathFacts {
  path: string;
  state: 'modified' | 'untracked' | 'deleted' | 'staged' | 'conflicted';
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
  /** Content equals the last server snapshot on the main branch. */
  matchesServerSnapshot: boolean | null;
  /** False when the file contains CR bytes — it would deploy broken. */
  byteExact: boolean | null;
  /** Commits by the user (sync-prefixed subjects excluded) touching this path. */
  yourCommits: number;
  /** Snapshot commits carrying this path, on either branch. */
  snapshotCommits: number;
}
