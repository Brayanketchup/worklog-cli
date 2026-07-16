import { WorklogError } from './errors.js';

/** Local date as YYYY-MM-DD. */
export function todayISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function validateDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new WorklogError(`Invalid date "${value}" — expected YYYY-MM-DD.`);
  }
  return value;
}

/** Boundaries for filtering a git log to a single local day. */
export function dayRange(date: string): { since: string; until: string } {
  return {
    since: `${date} 00:00:00`,
    until: `${date} 23:59:59`,
  };
}
