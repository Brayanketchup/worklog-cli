import path from 'node:path';
import type { SyncEntry } from './resolve.js';

/** Deepest directory shared by every path, or '' when they diverge at the root. */
export function commonParent(rels: string[]): string {
  if (rels.length === 0) return '';
  const split = rels.map((r) => r.split('/').slice(0, -1));
  const first = split[0] ?? [];
  const shared: string[] = [];
  for (let i = 0; i < first.length; i += 1) {
    const segment = first[i];
    if (split.every((parts) => parts[i] === segment)) shared.push(segment!);
    else break;
  }
  return shared.join('/');
}

/**
 * The subject line for a snapshot commit.
 *
 * A single file keeps v0.2's exact wording so existing history stays uniform;
 * a batch names the count and the folder the files came from, which is the
 * shape the user was already writing by hand.
 */
export function buildSubject(prefix: string, entries: SyncEntry[]): string {
  const added = entries.filter((e) => e.status === 'added');
  const verb = added.length === entries.length ? 'add' : 'update';

  if (entries.length === 1) {
    const only = entries[0]!;
    return `${prefix} ${only.status === 'added' ? 'add' : 'update'} ${path.basename(only.rel)}`;
  }

  const parent = commonParent(entries.map((e) => e.rel));
  const folder = parent.split('/').filter(Boolean).pop();
  return folder
    ? `${prefix} ${verb} ${entries.length} files in ${folder}/`
    : `${prefix} ${verb} ${entries.length} files`;
}

/** Bullet list of every path in the commit, grouped by added vs updated. */
export function buildBody(entries: SyncEntry[]): string {
  const sections: string[] = [];
  for (const [label, status] of [
    ['Added', 'added'],
    ['Updated', 'updated'],
  ] as const) {
    const group = entries.filter((e) => e.status === status);
    if (group.length === 0) continue;
    sections.push(`${label} (${group.length}):`);
    for (const entry of group) sections.push(`- ${entry.rel}`);
    sections.push('');
  }
  return sections.join('\n').trimEnd();
}

/** Apply the snapshot prefix to a user-supplied subject only if it is absent. */
export function applyPrefix(prefix: string, subject: string): string {
  const trimmed = subject.trim();
  return trimmed.startsWith(prefix) ? trimmed : `${prefix} ${trimmed}`;
}
