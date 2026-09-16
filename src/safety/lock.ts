import path from 'node:path';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import type { GitService } from '../git/repo.js';
import { WorklogError } from '../utils/errors.js';

/**
 * Advisory lock for mutating commands. Two worklog runs interleaving their
 * checkouts and stashes in one working tree corrupts both, and more than one
 * assistant session may share this tree.
 */
export interface Lock {
  path: string;
  release: () => Promise<void>;
}

interface LockFile {
  pid: number;
  command: string;
  startedAt: string;
}

/** A lock older than this whose owner is gone is treated as abandoned. */
const STALE_AFTER_MS = 60 * 60 * 1000;

async function lockPath(git: GitService): Promise<string> {
  return git.gitCommonPath('worklog/lock');
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function readLock(
  git: GitService,
): Promise<{ file: LockFile; stale: boolean } | null> {
  const target = await lockPath(git);
  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch {
    return null;
  }
  let file: LockFile;
  try {
    file = JSON.parse(raw) as LockFile;
  } catch {
    return { file: { pid: 0, command: 'unknown', startedAt: '' }, stale: true };
  }
  const age = Date.now() - Date.parse(file.startedAt || '');
  const stale = !processAlive(file.pid) && (Number.isNaN(age) || age > STALE_AFTER_MS);
  return { file, stale };
}

export async function clearLock(git: GitService): Promise<void> {
  try {
    await unlink(await lockPath(git));
  } catch {
    // Already gone.
  }
}

/**
 * Take the lock, or explain who holds it. A stale lock is reported, never
 * silently stolen — `worklog doctor --fix` clears those deliberately.
 */
export async function acquireLock(git: GitService, command: string): Promise<Lock> {
  const target = await lockPath(git);
  await mkdir(path.dirname(target), { recursive: true });

  const existing = await readLock(git);
  if (existing && !existing.stale) {
    throw new WorklogError(
      `Another worklog command is running (pid ${existing.file.pid}: ${existing.file.command}).`,
      'Wait for it to finish. If it crashed, run "worklog doctor" to inspect the lock.',
    );
  }

  try {
    const handle = await open(target, 'wx');
    const body: LockFile = { pid: process.pid, command, startedAt: new Date().toISOString() };
    await handle.writeFile(JSON.stringify(body, null, 2), 'utf8');
    await handle.close();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      if (existing?.stale) {
        // The holder is provably gone; replace the abandoned file.
        await clearLock(git);
        return acquireLock(git, command);
      }
      throw new WorklogError(
        'Another worklog command holds the lock.',
        'Run "worklog doctor" to inspect it.',
      );
    }
    throw err;
  }

  return { path: target, release: () => clearLock(git) };
}
