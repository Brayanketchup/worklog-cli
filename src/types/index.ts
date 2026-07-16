/** A single file touched by a commit, with line stats from --numstat. */
export interface FileChange {
  path: string;
  /** null for binary files (git reports "-") */
  insertions: number | null;
  deletions: number | null;
}

/** A parsed Git commit with per-file stats. */
export interface CommitInfo {
  hash: string;
  shortHash: string;
  /** ISO 8601 author date */
  date: string;
  /** Human-relative date, e.g. "2 hours ago" */
  relDate: string;
  author: string;
  /** Subject line */
  message: string;
  files: FileChange[];
}

/** Aggregated data behind `worklog report`. */
export interface ReportData {
  date: string;
  devCommits: CommitInfo[];
  syncCommits: CommitInfo[];
  /** Unique files touched by today's development commits. */
  filesModified: FileChange[];
  /** Unique files imported from the server today. */
  productionImports: string[];
  totals: {
    insertions: number;
    deletions: number;
  };
}
