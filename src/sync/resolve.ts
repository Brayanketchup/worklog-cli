import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { WorklogError } from '../utils/errors.js';
import { toRepoRelative } from '../utils/paths.js';

/** One file to import, with the bytes captured before anything moved. */
export interface SyncEntry {
  /** Absolute path the file will occupy in the working tree. */
  abs: string;
  /** Repo-relative path with forward slashes (what git sees). */
  rel: string;
  /** Where the bytes were read from — differs from `abs` in drop-folder mode. */
  source: string;
  content: Buffer;
  /** Whether the snapshot branch already carries this path. */
  status: 'added' | 'updated';
}

/**
 * Turn explicit file arguments into repo-relative paths.
 *
 * Directories and globs are deliberately NOT accepted here. Sync's whole
 * safety model rests on every named path holding a fresh server download;
 * expanding a directory would sweep in the user's own uncommitted edits,
 * discard them from the working tree (unrecoverably — they are never stashed),
 * and then publish them on the snapshot branch as if the server had sent them.
 * The drop folder below gives the same convenience with none of the guessing.
 */
export async function resolveExplicitPaths(files: string[], root: string): Promise<string[]> {
  const rels: string[] = [];
  for (const file of files) {
    const abs = path.resolve(process.cwd(), file);
    let info;
    try {
      info = await stat(abs);
    } catch {
      throw new WorklogError(
        `Cannot find ${file}.`,
        'Copy the downloaded SFTP file over your local copy first, then run worklog sync.',
      );
    }
    if (info.isDirectory()) {
      throw new WorklogError(
        `${file} is a directory.`,
        'worklog sync takes explicit file paths. To import a whole download at once, put the files in a drop folder and run "worklog sync --from <folder>".',
      );
    }
    rels.push(toRepoRelative(file, root));
  }
  return rels;
}

/**
 * Every regular file under a drop folder, paired with the repo-relative
 * destination implied by its position inside that folder. Everything here is
 * a download by construction, so no classification is needed.
 */
export async function walkDropFolder(
  dropRoot: string,
): Promise<Array<{ source: string; rel: string }>> {
  const found: Array<{ source: string; rel: string }> = [];

  async function walk(dir: string): Promise<void> {
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      throw new WorklogError(
        `Cannot read the drop folder ${dropRoot}.`,
        'Create it and copy your SFTP downloads into it, mirroring their paths in the repository.',
      );
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full);
      } else if (item.isFile()) {
        const rel = path.relative(dropRoot, full).split(path.sep).join('/');
        found.push({ source: full, rel });
      }
    }
  }

  await walk(dropRoot);
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}
