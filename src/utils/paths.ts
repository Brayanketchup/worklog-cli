import path from 'node:path';
import { WorklogError } from './errors.js';

/** Convert an absolute or relative input path into a repo-relative Git path. */
export function toRepoRelative(file: string, root: string): string {
  const abs = path.resolve(process.cwd(), file);
  const rel = path.relative(root, abs).split(path.sep).join('/');

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new WorklogError(`${file} is outside the repository (${root}).`);
  }

  return rel;
}