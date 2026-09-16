import path from 'node:path';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import type { WorklogConfig } from '../config/config.js';
import type { GitService } from '../git/repo.js';

/**
 * A safepoint pins every branch tip and stash that existed before a mutating
 * command ran, using real refs under `refs/worklog/`.
 *
 * Refs are used rather than the reflog because these repositories have no
 * remote: `gc.reflogExpireUnreachable` defaults to 30 days and `git gc --auto`
 * runs implicitly, so a commit that falls off a branch tip is genuinely
 * destroyed. A ref never expires, is invisible to `git branch`, and pins a
 * stash commit together with all three of its parents — including the third,
 * which is where `--include-untracked` hides files that vanished from disk.
 */
export interface Safepoint {
  id: string;
  /** Refs created, so they can be reported later. */
  refs: string[];
  /** Branch tips as they were before the operation. */
  pre: { head: string | null; branches: Record<string, string>; stash: string | null };
  journalPath: string;
}

export interface JournalEntry {
  id: string;
  command: string;
  startedAt: string;
  status: 'running' | 'ok' | 'conflict' | 'failed';
  pid: number;
  pre: Safepoint['pre'];
  refs: string[];
  /** Files captured into the incoming staging area, repo-relative. */
  incoming: string[];
  note?: string;
}

const REF_ROOT = 'refs/worklog';

/**
 * A sortable, filesystem-safe id. Uses the process start time rather than
 * Date.now() so two safepoints in one run cannot collide.
 */
function makeId(seq: number): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return `${stamp}-${String(process.pid).padStart(5, '0')}-${seq}`;
}

let sequence = 0;

/**
 * Pin the current state before mutating anything. Never throws on a pinning
 * failure that would block real work: a safepoint is protection, and refusing
 * to run because protection could not be written would be its own failure.
 */
export async function createSafepoint(
  git: GitService,
  config: WorklogConfig,
  command: string,
): Promise<Safepoint> {
  sequence += 1;
  const id = makeId(sequence);
  const refs: string[] = [];
  const branches: Record<string, string> = {};

  const head = await git.resolve('HEAD');
  for (const branch of [config.mainBranch, config.workBranch]) {
    const hash = await git.resolve(branch);
    if (!hash) continue;
    branches[branch] = hash;
    const ref = `${REF_ROOT}/undo/${id}/${branch}`;
    await git.updateRef(ref, hash);
    refs.push(ref);
  }

  const stash = await git.resolve('refs/stash');
  if (stash) {
    const ref = `${REF_ROOT}/undo/${id}/stash`;
    await git.updateRef(ref, stash);
    refs.push(ref);
  }

  if (head) {
    const ref = `${REF_ROOT}/undo/${id}/head`;
    await git.updateRef(ref, head);
    refs.push(ref);
  }

  const journalPath = await writeJournal(git, {
    id,
    command,
    startedAt: new Date().toISOString(),
    status: 'running',
    pid: process.pid,
    pre: { head, branches, stash },
    refs,
    incoming: [],
  });

  return { id, refs, pre: { head, branches, stash }, journalPath };
}

/** Pin a stash that was created *after* the safepoint (the auto-stash). */
export async function pinStash(
  git: GitService,
  safepoint: Safepoint,
  hash: string,
  label = 'stash',
): Promise<string> {
  const ref = `${REF_ROOT}/undo/${safepoint.id}/${label}`;
  await git.updateRef(ref, hash);
  safepoint.refs.push(ref);
  return ref;
}

export async function journalDir(git: GitService): Promise<string> {
  return git.gitCommonPath('worklog/journal');
}

async function writeJournal(git: GitService, entry: JournalEntry): Promise<string> {
  const dir = await journalDir(git);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${entry.id}.json`);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(entry, null, 2), 'utf8');
  await rename(tmp, target);
  return target;
}

export async function updateJournal(
  git: GitService,
  safepoint: Safepoint,
  patch: Partial<JournalEntry>,
): Promise<void> {
  try {
    const raw = await readFile(safepoint.journalPath, 'utf8');
    const entry = JSON.parse(raw) as JournalEntry;
    await writeJournal(git, { ...entry, ...patch });
  } catch {
    // The journal is an aid, never a gate: a write failure must not abort work.
  }
}

export async function readJournal(git: GitService): Promise<JournalEntry[]> {
  const dir = await journalDir(git);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const entries: JournalEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      entries.push(JSON.parse(await readFile(path.join(dir, name), 'utf8')) as JournalEntry);
    } catch {
      // Skip an unreadable entry rather than failing the whole listing.
    }
  }
  return entries.sort((a, b) => b.id.localeCompare(a.id));
}

/**
 * Copy captured bytes into `.git/worklog/incoming/<id>/` before the working
 * tree is disturbed. Without this, a downloaded file exists only in a Buffer
 * in memory between the moment it is removed from the tree and the moment it
 * is written onto the snapshot branch — a window a killed process turns into
 * permanent loss.
 */
export async function stageIncoming(
  git: GitService,
  safepoint: Safepoint,
  entries: Array<{ rel: string; content: Buffer }>,
): Promise<string[]> {
  if (entries.length === 0) return [];
  const base = await git.gitCommonPath(`worklog/incoming/${safepoint.id}`);
  const written: string[] = [];
  for (const entry of entries) {
    const target = path.join(base, entry.rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.content);
    written.push(entry.rel);
  }
  await updateJournal(git, safepoint, { incoming: written });
  return written;
}

export async function incomingDir(git: GitService, id: string): Promise<string> {
  return git.gitCommonPath(`worklog/incoming/${id}`);
}

export { REF_ROOT };
