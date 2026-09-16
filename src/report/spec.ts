import type { ReportSpec } from '../types/index.js';
import { WorklogError } from '../utils/errors.js';
import { shiftDays, todayISO, validateDate } from '../utils/dates.js';

export interface SpecInput {
  date?: string;
  since?: string;
  until?: string;
  last?: string;
  commit?: string;
}

/**
 * Work out which commits a report covers. The four selectors are mutually
 * exclusive so a report can never silently answer a different question than
 * the one that was asked.
 */
export function resolveSpec(input: SpecInput): ReportSpec {
  const given = [
    input.date ? 'date' : null,
    input.since || input.until ? 'since/until' : null,
    input.last ? 'last' : null,
    input.commit ? 'commit' : null,
  ].filter(Boolean) as string[];

  if (given.length > 1) {
    throw new WorklogError(
      `Pick one range: ${given.join(', ')} were all given.`,
      'Use -d for one day, --since/--until for a range, --last <n> for recent days, or --commit <ref>.',
    );
  }

  if (input.commit) {
    return { kind: 'commit', ref: input.commit, label: input.commit };
  }

  if (input.last) {
    const days = Number.parseInt(input.last, 10);
    if (!Number.isFinite(days) || days < 1) {
      throw new WorklogError(`--last needs a positive number of days, got "${input.last}".`);
    }
    const until = todayISO();
    const since = shiftDays(until, -(days - 1));
    return { kind: 'range', since, until, label: `${since} .. ${until}` };
  }

  if (input.since || input.until) {
    const since = input.since ? validateDate(input.since) : validateDate(input.until!);
    const until = input.until ? validateDate(input.until) : todayISO();
    if (since > until) {
      throw new WorklogError(`--since ${since} is after --until ${until}.`);
    }
    return { kind: 'range', since, until, label: `${since} .. ${until}` };
  }

  const day = input.date ? validateDate(input.date) : todayISO();
  return { kind: 'day', since: day, until: day, label: day };
}
