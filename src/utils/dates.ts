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
  return rangeBounds(date, date);
}

/** Boundaries for filtering a git log to an inclusive span of local days. */
export function rangeBounds(since: string, until: string): { since: string; until: string } {
  return {
    since: `${since} 00:00:00`,
    until: `${until} 23:59:59`,
  };
}

/** Move a YYYY-MM-DD date by a whole number of days, staying calendar-correct. */
export function shiftDays(date: string, delta: number): string {
  const [y = '1970', m = '01', d = '01'] = date.split('-');
  const shifted = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + delta));
  const yy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Every calendar day from `since` to `until`, inclusive. */
export function daysBetween(since: string, until: string): string[] {
  const days: string[] = [];
  let cursor = since;
  let guard = 0;
  while (cursor <= until && guard < 4000) {
    days.push(cursor);
    cursor = shiftDays(cursor, 1);
    guard += 1;
  }
  return days;
}
