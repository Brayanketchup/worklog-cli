import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorklogError } from '../utils/errors.js';

export interface WorklogConfig {
  /** Branch that mirrors the server state (SFTP snapshots). */
  mainBranch: string;
  /** Branch that holds your own development commits. */
  workBranch: string;
  /** Subject prefix used for production import commits. */
  syncCommitPrefix: string;
}

export const DEFAULT_CONFIG: WorklogConfig = {
  mainBranch: 'main',
  workBranch: 'work',
  syncCommitPrefix: 'SFTP sync:',
};

const CONFIG_FILENAME = 'worklog.config.json';

/**
 * Load worklog.config.json from the repository root, falling back to
 * defaults for any missing key. A missing file is fine; a broken one is not.
 */
export async function loadConfig(repoRoot: string): Promise<WorklogConfig> {
  const configPath = join(repoRoot, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...DEFAULT_CONFIG };
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WorklogConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (err) {
    throw new WorklogError(
      `Could not parse ${CONFIG_FILENAME}: ${(err as Error).message}`,
      `Fix or delete ${configPath}`,
    );
  }
}
