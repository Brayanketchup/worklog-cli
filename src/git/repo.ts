import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git';
import type { CommitInfo, FileChange } from '../types/index.js';
import { WorklogError } from '../utils/errors.js';

/** Field separator for the custom git log format (ASCII unit separator). */
const SEP = '\x1f';
const LOG_FORMAT = `${SEP}%H${SEP}%h${SEP}%aI${SEP}%ad${SEP}%ar${SEP}%an${SEP}%s`;
/** Author date rendered by git itself, so no Date parsing is ever needed. */
const DATE_FORMAT = '--date=format:%Y-%m-%d %H:%M';

export interface LogQuery {
  branch: string;
  since?: string;
  until?: string;
  noMerges?: boolean;
  maxCount?: number;
}

/** One entry of `git status --porcelain=v2 -z`. */
export interface StatusEntry {
  path: string;
  state: 'modified' | 'untracked' | 'deleted' | 'staged' | 'conflicted';
}

export interface MergeState {
  inProgress: boolean;
  conflicted: string[];
}

/**
 * All Git access goes through this class so commands never talk to
 * simple-git (or the git binary) directly.
 */
export class GitService {
  private git: SimpleGit;
  private repoRoot = '';
  private readOnly = false;

  constructor(cwd: string = process.cwd()) {
    this.git = simpleGit(cwd);
  }

  /**
   * Block every mutating method. Used by --dry-run so a forgotten code path
   * throws instead of quietly changing the repository.
   */
  setReadOnly(on: boolean): void {
    this.readOnly = on;
  }

  private assertWritable(op: string): void {
    if (this.readOnly) {
      throw new WorklogError(
        `Refusing to ${op} during a dry run.`,
        'This is a bug: a dry run must not reach a mutating code path.',
      );
    }
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

  /** Absolute path inside this worktree's .git directory. */
  async gitPath(rel: string): Promise<string> {
    return (await this.git.raw(['rev-parse', '--git-path', rel])).trim();
  }

  /** Absolute path inside the shared .git directory (worktree-safe). */
  async gitCommonPath(rel: string): Promise<string> {
    const common = (await this.git.raw(['rev-parse', '--git-common-dir'])).trim();
    return `${common}/${rel}`;
  }

  async currentBranch(): Promise<string> {
    return (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  }

  /** null when HEAD is detached, unlike currentBranch() which returns "HEAD". */
  async currentBranchOrNull(): Promise<string | null> {
    try {
      const out = await this.git.raw(['symbolic-ref', '-q', '--short', 'HEAD']);
      const name = out.trim();
      return name.length > 0 ? name : null;
    } catch {
      return null;
    }
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

  /** Resolve a ref to a full hash, or null when it does not exist. */
  async resolve(ref: string): Promise<string | null> {
    try {
      const out = await this.git.raw(['rev-parse', '-q', '--verify', `${ref}^{commit}`]);
      const hash = out.trim();
      return hash.length > 0 ? hash : null;
    } catch {
      return null;
    }
  }

  /**
   * Is a merge underway, and which paths conflict?
   * Detected by output, never by exit code: `rev-parse -q --verify` exits 1
   * with empty stderr, which simple-git does not surface as an error.
   */
  async mergeState(): Promise<MergeState> {
    const head = await this.resolve('MERGE_HEAD');
    const conflicted = await this.conflictedPaths();
    return { inProgress: head !== null, conflicted };
  }

  async conflictedPaths(): Promise<string[]> {
    const out = await this.git.raw(['diff', '--name-only', '--diff-filter=U']);
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  async isRebasing(): Promise<boolean> {
    const { access } = await import('node:fs/promises');
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      const path = await this.gitPath(dir);
      try {
        await access(path);
        return true;
      } catch {
        // not present
      }
    }
    return false;
  }

  async checkout(branch: string): Promise<void> {
    this.assertWritable(`check out ${branch}`);
    await this.git.checkout(branch);
  }

  async add(paths: string[]): Promise<void> {
    this.assertWritable('stage files');
    if (paths.length === 0) return;
    await this.git.raw(['add', '--', ...paths]);
  }

  async addAll(): Promise<void> {
    this.assertWritable('stage all files');
    await this.git.add(['-A']);
  }

  async commit(message: string): Promise<string> {
    this.assertWritable('commit');
    const result = await this.git.commit(message);
    return result.commit;
  }

  /**
   * Stage exactly these paths, prove the index holds exactly them, and commit.
   *
   * Never `git commit -- <paths>`: that form commits the WORKING TREE for
   * those paths and ignores what was staged, and it refuses outright during a
   * merge. Asserting the index instead makes the commit's contents provable.
   * Returns null when nothing differed, which is a success, not a failure.
   */
  async addAndCommit(message: string, relPaths: string[]): Promise<string | null> {
    this.assertWritable('commit');
    if (relPaths.length === 0) {
      throw new WorklogError(
        'Refusing to commit an empty file list.',
        'This is a bug: an empty pathspec would commit everything already staged.',
      );
    }
    await this.add(relPaths);
    const staged = await this.stagedPaths();
    if (staged.length === 0) return null;
    const expected = new Set(relPaths);
    const extra = staged.filter((p) => !expected.has(p));
    if (extra.length > 0) {
      throw new WorklogError(
        `The index holds files that were not part of this operation: ${extra.join(', ')}`,
        'Commit or unstage them (git restore --staged <file>), then run worklog again.',
      );
    }
    const result = await this.git.commit(message);
    return result.commit;
  }

  /** Commit only the specified paths, leaving unrelated staged files untouched. */
  async commitPaths(message: string, relPaths: string[]): Promise<string> {
    this.assertWritable('commit');
    if (relPaths.length === 0) {
      throw new WorklogError(
        'Refusing to commit an empty file list.',
        'This is a bug: an empty pathspec would commit everything already staged.',
      );
    }
    const result = await this.git.commit(message, relPaths);
    return result.commit;
  }

  /** Restore paths in both the index and working tree from a Git reference. */
  async restoreFrom(ref: string, relPaths: string[]): Promise<void> {
    this.assertWritable('restore files');
    await this.git.raw(['checkout', ref, '--', ...relPaths]);
  }

  /** Check whether a path exists in a branch, commit, or other Git reference. */
  async existsInRef(ref: string, relPath: string): Promise<boolean> {
    try {
      const out = await this.git.raw(['ls-tree', '--name-only', ref, '--', relPath]);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  async merge(branch: string): Promise<void> {
    this.assertWritable(`merge ${branch}`);
    await this.git.merge([branch]);
  }

  /** The only merge `doctor --fix` may run: it can never create a conflict. */
  async mergeFastForwardOnly(branch: string): Promise<boolean> {
    this.assertWritable(`merge ${branch}`);
    try {
      await this.git.raw(['merge', '--ff-only', branch]);
      return true;
    } catch {
      return false;
    }
  }

  /** Is `maybeAncestor` reachable from `descendant`? */
  async isAncestor(maybeAncestor: string, descendant: string): Promise<boolean> {
    try {
      await this.git.raw(['merge-base', '--is-ancestor', maybeAncestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  /** Reset a path in both index and working tree back to HEAD. */
  async discardChanges(relPath: string): Promise<void> {
    this.assertWritable(`discard changes to ${relPath}`);
    await this.restoreFrom('HEAD', [relPath]);
  }

  async stashPush(message: string): Promise<void> {
    this.assertWritable('stash changes');
    await this.git.stash(['push', '--include-untracked', '-m', message]);
  }

  async stashPop(): Promise<void> {
    this.assertWritable('pop the stash');
    await this.git.stash(['pop']);
  }

  async stashCount(): Promise<number> {
    return (await this.git.stashList()).total;
  }

  /**
   * Stash entries with their selector, commit hash and full subject.
   * `%gs` renders as "On <branch>: <message>", so the branch a stash was
   * taken on is recoverable — never assume stash@{0} is ours.
   */
  async stashListDetailed(): Promise<
    Array<{ selector: string; hash: string; subject: string; branch: string | null }>
  > {
    const out = await this.git.raw(['stash', 'list', `--format=%gd${SEP}%H${SEP}%gs`]);
    const rows: Array<{ selector: string; hash: string; subject: string; branch: string | null }> =
      [];
    for (const line of out.split('\n')) {
      if (line.trim().length === 0) continue;
      const [selector = '', hash = '', subject = ''] = line.split(SEP);
      const match = subject.match(/^On ([^:]+): /);
      rows.push({ selector, hash, subject, branch: match?.[1] ?? null });
    }
    return rows;
  }

  /**
   * Files carried by a stash commit. A stash with three parents stores
   * untracked files in its third parent — the reason work can vanish from a
   * working tree with no trace in `git stash list`.
   */
  async stashContents(stashHash: string): Promise<{ tracked: string[]; untracked: string[] }> {
    const parentsRaw = await this.git.raw(['rev-list', '--parents', '-n1', stashHash]);
    const parents = parentsRaw.trim().split(/\s+/).slice(1);
    const tracked = (await this.git.raw(['show', '--name-only', '--format=', stashHash]))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    let untracked: string[] = [];
    if (parents.length >= 3) {
      untracked = (await this.git.raw(['show', '--name-only', '--format=', `${stashHash}^3`]))
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    }
    return { tracked, untracked: untracked.filter((p) => !tracked.includes(p)) };
  }

  /** Re-register a pinned stash commit on refs/stash. */
  async stashStore(commitHash: string, message: string): Promise<void> {
    this.assertWritable('store a stash');
    await this.git.raw(['stash', 'store', '-m', message, commitHash]);
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

  /** Paths whose index entry differs from HEAD. */
  async stagedPaths(): Promise<string[]> {
    const out = await this.git.raw(['diff', '--cached', '--name-only']);
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
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

  /** Create or move a ref. The 3-argument form is a compare-and-swap. */
  async updateRef(ref: string, hash: string, expectedOld?: string): Promise<void> {
    this.assertWritable(`update ${ref}`);
    const args = ['update-ref', ref, hash];
    if (expectedOld !== undefined) args.push(expectedOld);
    await this.git.raw(args);
  }

  async listRefs(prefix: string): Promise<Array<{ ref: string; hash: string }>> {
    const out = await this.git.raw([
      'for-each-ref',
      `--format=%(refname)${SEP}%(objectname)`,
      prefix,
    ]);
    const rows: Array<{ ref: string; hash: string }> = [];
    for (const line of out.split('\n')) {
      if (line.trim().length === 0) continue;
      const [ref = '', hash = ''] = line.split(SEP);
      rows.push({ ref, hash });
    }
    return rows;
  }

  /** Commits pinned by the given refs that no branch can reach any more. */
  async commitsNotOnAnyBranch(refs: string[]): Promise<CommitInfo[]> {
    if (refs.length === 0) return [];
    try {
      const out = await this.git.raw([
        'rev-list',
        ...refs,
        '--not',
        '--branches',
        `--pretty=format:${LOG_FORMAT}`,
        DATE_FORMAT,
      ]);
      return parseLog(out);
    } catch {
      return [];
    }
  }

  /** Branch names that contain the given commit. */
  async branchesContaining(hash: string): Promise<string[]> {
    try {
      const out = await this.git.raw(['branch', '--contains', hash, '--format=%(refname:short)']);
      return out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  /** Files whose index or worktree copy carries CRLF, which must never deploy. */
  async eolAudit(): Promise<Array<{ path: string; index: string; worktree: string }>> {
    const out = await this.git.raw(['ls-files', '--eol']);
    const rows: Array<{ path: string; index: string; worktree: string }> = [];
    for (const line of out.split('\n')) {
      const match = line.match(/^i\/(\S+)\s+w\/(\S+)\s+attr\/\S*\s+(.+)$/);
      if (!match) continue;
      const [, index = '', worktree = '', path = ''] = match;
      if (index.includes('crlf') || worktree.includes('crlf')) {
        rows.push({ path: path.trim(), index, worktree });
      }
    }
    return rows;
  }

  /** Working-tree state per path, NUL-separated so spaces are safe. */
  async statusEntries(pathspec?: string): Promise<StatusEntry[]> {
    const args = ['status', '--porcelain=v2', '-z', '--untracked-files=all'];
    if (pathspec) args.push('--', pathspec);
    const out = await this.git.raw(args);
    const fields = out.split('\0');
    const entries: StatusEntry[] = [];
    for (let i = 0; i < fields.length; i += 1) {
      const line = fields[i];
      if (!line || line.length === 0) continue;
      const kind = line[0];
      if (kind === '?') {
        entries.push({ path: line.slice(2), state: 'untracked' });
      } else if (kind === '1') {
        const parts = line.split(' ');
        const xy = parts[1] ?? '..';
        const path = parts.slice(8).join(' ');
        if (!path) continue;
        if (xy.includes('D')) entries.push({ path, state: 'deleted' });
        else if (xy[0] !== '.') entries.push({ path, state: 'staged' });
        else entries.push({ path, state: 'modified' });
      } else if (kind === '2') {
        // Rename/copy: the following NUL-separated field is the original path.
        const parts = line.split(' ');
        const path = parts.slice(9).join(' ');
        if (path) entries.push({ path, state: 'staged' });
        i += 1;
      } else if (kind === 'u') {
        const parts = line.split(' ');
        const path = parts.slice(10).join(' ');
        if (path) entries.push({ path, state: 'conflicted' });
      }
    }
    return entries;
  }

  /** Hash the working-tree copy of a path as git would store it. */
  async hashObjectWorktree(relPath: string): Promise<string | null> {
    try {
      const out = await this.git.raw(['hash-object', '--path', relPath, '--', relPath]);
      const hash = out.trim();
      return hash.length > 0 ? hash : null;
    } catch {
      return null;
    }
  }

  /** The blob hash a ref stores for a path, or null when absent. */
  async blobHashInRef(ref: string, relPath: string): Promise<string | null> {
    try {
      const out = await this.git.raw(['rev-parse', `${ref}:${relPath}`]);
      const hash = out.trim();
      return /^[0-9a-f]{40}$/.test(hash) ? hash : null;
    } catch {
      return null;
    }
  }

  /** Line stats for every dirty path against a ref. */
  async numstatAgainst(ref: string): Promise<FileChange[]> {
    const out = await this.git.raw(['diff', '--numstat', ref]);
    const changes: FileChange[] = [];
    for (const line of out.split('\n')) {
      const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (match) changes.push(toFileChange(match[1]!, match[2]!, match[3]!));
    }
    return changes;
  }

  /**
   * How many of a branch's commits touched each path, split by whether the
   * subject marks it a server snapshot. One pass, because snapshot commits
   * also live on the work branch once main has been merged in.
   */
  async pathHistoryMap(
    branch: string,
    syncPrefix: string,
  ): Promise<Map<string, { own: number; sync: number }>> {
    const map = new Map<string, { own: number; sync: number }>();
    let out: string;
    try {
      out = await this.git.raw([
        'log',
        branch,
        '--no-merges',
        '--name-only',
        `--pretty=format:${SEP}%s`,
      ]);
    } catch {
      return map;
    }
    let isSync = false;
    for (const line of out.split('\n')) {
      if (line.startsWith(SEP)) {
        isSync = line.slice(1).startsWith(syncPrefix);
        continue;
      }
      const path = line.trim();
      if (path.length === 0) continue;
      const entry = map.get(path) ?? { own: 0, sync: 0 };
      if (isSync) entry.sync += 1;
      else entry.own += 1;
      map.set(path, entry);
    }
    return map;
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
      DATE_FORMAT,
    ]);
    const commits = parseLog(out);
    return commits[0] ?? null;
  }

  /** A single commit by ref, with per-file stats. Merges included. */
  async commitWithStats(ref: string): Promise<CommitInfo | null> {
    try {
      const out = await this.git.raw([
        'log',
        ref,
        '-1',
        `--pretty=format:${LOG_FORMAT}`,
        DATE_FORMAT,
        '--numstat',
      ]);
      return parseLog(out)[0] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * One file's patch from one commit. Driven by an explicit pathspec, so a
   * filename containing a space can never be mis-parsed out of a diff header.
   */
  async diffForFile(
    hash: string,
    relPath: string,
    opts: { context: number; ignoreWhitespace?: boolean },
  ): Promise<string> {
    const args = [
      '-c',
      'core.quotepath=false',
      'show',
      '--format=',
      `--unified=${opts.context}`,
      '--no-color',
      '--no-ext-diff',
    ];
    if (opts.ignoreWhitespace) args.push('--ignore-all-space');
    args.push(hash, '--', relPath);
    try {
      return await this.git.raw(args);
    } catch {
      return '';
    }
  }

  /**
   * Structured log with per-file line stats.
   * Uses a custom format plus --numstat and parses the result.
   */
  async logWithStats(query: LogQuery): Promise<CommitInfo[]> {
    const args = ['log', query.branch, `--pretty=format:${LOG_FORMAT}`, DATE_FORMAT, '--numstat'];
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
      const [
        ,
        hash = '',
        shortHash = '',
        date = '',
        authored = '',
        relDate = '',
        author = '',
        ...rest
      ] = line.split(SEP);
      const [day = '', time = ''] = authored.split(' ');
      current = {
        hash,
        shortHash,
        date,
        day,
        time,
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
  const binary = ins === '-' && del === '-';
  return {
    path,
    insertions: ins === '-' ? null : Number.parseInt(ins, 10),
    deletions: del === '-' ? null : Number.parseInt(del, 10),
    binary,
  };
}
