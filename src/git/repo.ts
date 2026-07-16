import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git';
import type { CommitInfo, FileChange } from '../types/index.js';
import { WorklogError } from '../utils/errors.js';

/** Field separator for the custom git log format (ASCII unit separator). */
const SEP = '\x1f';
const LOG_FORMAT = `${SEP}%H${SEP}%h${SEP}%aI${SEP}%ar${SEP}%an${SEP}%s`;

export interface LogQuery {
  branch: string;
  since?: string;
  until?: string;
  noMerges?: boolean;
  maxCount?: number;
}

/**
 * All Git access goes through this class so commands never talk to
 * simple-git (or the git binary) directly.
 */
export class GitService {
  private git: SimpleGit;
  private repoRoot = '';

  constructor(cwd: string = process.cwd()) {
    this.git = simpleGit(cwd);
  }

  /** Verify we are inside a repo and re-anchor at its root. Returns the root. */
  async ensureRepo(): Promise<string> {
    let isRepo = false;
    try {
      isRepo = await this.git.checkIsRepo();
    } catch {
      isRepo = false;
    }
    if (!isRepo) {
      throw new WorklogError(
        'Not inside a Git repository.',
        'Run worklog from within the repository you want to manage.',
      );
    }
    this.repoRoot = (await this.git.revparse(['--show-toplevel'])).trim();
    this.git = simpleGit(this.repoRoot);
    return this.repoRoot;
  }

  get root(): string {
    return this.repoRoot;
  }

  async currentBranch(): Promise<string> {
    return (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  }

  async branchExists(name: string): Promise<boolean> {
    const branches = await this.git.branchLocal();
    return branches.all.includes(name);
  }

  async status(): Promise<StatusResult> {
    return this.git.status();
  }

  async isDirty(): Promise<boolean> {
    return !(await this.status()).isClean();
  }

  async checkout(branch: string): Promise<void> {
    await this.git.checkout(branch);
  }

  async add(paths: string[]): Promise<void> {
    await this.git.add(paths);
  }

  async addAll(): Promise<void> {
    await this.git.add(['-A']);
  }

  async commit(message: string): Promise<string> {
    const result = await this.git.commit(message);
    return result.commit;
  }

  async merge(branch: string): Promise<void> {
    await this.git.merge([branch]);
  }

  /** Reset a path in both index and working tree back to HEAD. */
  async discardChanges(relPath: string): Promise<void> {
    await this.git.raw(['checkout', 'HEAD', '--', relPath]);
  }

  async stashPush(message: string): Promise<void> {
    await this.git.stash(['push', '--include-untracked', '-m', message]);
  }

  async stashPop(): Promise<void> {
    await this.git.stash(['pop']);
  }

  async stashCount(): Promise<number> {
    return (await this.git.stashList()).total;
  }

  /** Is the path known to the index of the current branch? */
  async isTracked(relPath: string): Promise<boolean> {
    try {
      const out = await this.git.raw(['ls-files', '--error-unmatch', '--', relPath]);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** Does the index differ from HEAD for this path (i.e. is a commit needed)? */
  async hasStagedChanges(relPath?: string): Promise<boolean> {
    // Check by output, not exit code: `--quiet` exits 1 with no stderr,
    // which simple-git does not surface as an error.
    const args = ['diff', '--cached', '--name-only'];
    if (relPath) args.push('--', relPath);
    const out = await this.git.raw(args);
    return out.trim().length > 0;
  }

  /** Number of commits reachable from `target` but not from `base`. */
  async commitsAhead(base: string, target: string): Promise<number> {
    const out = await this.git.raw(['rev-list', '--count', `${base}..${target}`]);
    return Number.parseInt(out.trim(), 10);
  }

  /** Most recent commit on a branch whose subject contains `needle` (fixed string). */
  async lastCommitMatching(branch: string, needle: string): Promise<CommitInfo | null> {
    const out = await this.git.raw([
      'log',
      branch,
      '-1',
      '--fixed-strings',
      `--grep=${needle}`,
      `--pretty=format:${LOG_FORMAT}`,
    ]);
    const commits = parseLog(out);
    return commits[0] ?? null;
  }

  /**
   * Structured log with per-file line stats.
   * Uses a custom format plus --numstat and parses the result.
   */
  async logWithStats(query: LogQuery): Promise<CommitInfo[]> {
    const args = ['log', query.branch, `--pretty=format:${LOG_FORMAT}`, '--numstat'];
    if (query.since) args.push(`--since=${query.since}`);
    if (query.until) args.push(`--until=${query.until}`);
    if (query.noMerges) args.push('--no-merges');
    if (query.maxCount) args.push(`--max-count=${query.maxCount}`);
    let out: string;
    try {
      out = await this.git.raw(args);
    } catch (err) {
      // A branch with no commits yet makes git log fail; treat as empty.
      if ((err as Error).message.includes('does not have any commits')) return [];
      throw err;
    }
    return parseLog(out);
  }
}

/** Parse output of `git log --pretty=format:<LOG_FORMAT> --numstat`. */
function parseLog(raw: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  let current: CommitInfo | null = null;

  for (const line of raw.split('\n')) {
    if (line.startsWith(SEP)) {
      const [, hash = '', shortHash = '', date = '', relDate = '', author = '', ...rest] =
        line.split(SEP);
      current = {
        hash,
        shortHash,
        date,
        relDate,
        author,
        message: rest.join(SEP),
        files: [],
      };
      commits.push(current);
      continue;
    }
    const stat = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (stat && current) {
      current.files.push(toFileChange(stat[1]!, stat[2]!, stat[3]!));
    }
  }
  return commits;
}

function toFileChange(ins: string, del: string, path: string): FileChange {
  return {
    path,
    insertions: ins === '-' ? null : Number.parseInt(ins, 10),
    deletions: del === '-' ? null : Number.parseInt(del, 10),
  };
}
