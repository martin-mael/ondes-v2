import { addDays, daysBetween, type LocalDate, localDateOf } from '@ondes/shared';

// The rolling horizon and the debounce of automatic regeneration (#101, ADR 0030). Dates are
// station-local calendar dates, so a DST day is one date like any other: the generator gives it
// 23 or 25 hours.

/** The horizon at `now`: `days` dates from the station's today. */
export function horizonDates(now: Date, timeZone: string, days: number): LocalDate[] {
  const today = localDateOf(now, timeZone);
  return Array.from({ length: Math.max(0, days) }, (_, i) => addDays(today, i));
}

/** Consecutive dates from `from` to `to`, both included; empty when `to` is before `from`. */
export function dateRange(from: LocalDate, to: LocalDate): LocalDate[] {
  const n = daysBetween(from, to);
  return Array.from({ length: Math.max(0, n + 1) }, (_, i) => addDays(from, i));
}

/** Splits sorted dates into runs of consecutive dates, at most `max` long (one job each). */
export function consecutiveChunks(dates: readonly LocalDate[], max: number): LocalDate[][] {
  const chunks: LocalDate[][] = [];
  for (const date of [...new Set(dates)].sort()) {
    const last = chunks.at(-1);
    const prev = last?.at(-1);
    if (last && prev && addDays(prev, 1) === date && last.length < max) last.push(date);
    else chunks.push([date]);
  }
  return chunks;
}

export interface HorizonWork {
  /** Days of the horizon that have no log yet. */
  missing: LocalDate[];
  /** Days to regenerate for a due schedule change (from its first date to the horizon's end). */
  regenerate: LocalDate[];
}

/**
 * What a horizon pass does: generate the horizon's missing days, and, when a schedule change
 * is due, regenerate every horizon day from the change's first date (today at the earliest).
 */
export function horizonWork(input: {
  horizon: readonly LocalDate[];
  existing: ReadonlySet<LocalDate>;
  /** A due change: its first date, null meaning today. Undefined: nothing due. */
  dueFrom?: LocalDate | null;
}): HorizonWork {
  const missing = input.horizon.filter((d) => !input.existing.has(d));
  const first = input.horizon[0];
  if (input.dueFrom === undefined || first === undefined) return { missing, regenerate: [] };
  const from = input.dueFrom === null || input.dueFrom < first ? first : input.dueFrom;
  return {
    missing,
    regenerate: input.horizon.filter((d) => d >= from && input.existing.has(d)),
  };
}

/** Quiet time after the last schedule change before regenerating. */
export const REGEN_DEBOUNCE_MS = 30_000;
/** A station edited without pause still regenerates this long after the first change. */
export const REGEN_MAX_WAIT_MS = 5 * 60_000;

/**
 * When a pending regeneration is due: `debounceMs` after the latest change, but no later than
 * `maxWaitMs` after the first one still pending (trailing debounce with a cap).
 */
export function regenDueAt(input: {
  firstRequestedAt: Date;
  lastRequestedAt: Date;
  debounceMs?: number;
  maxWaitMs?: number;
}): Date {
  const debounce = input.debounceMs ?? REGEN_DEBOUNCE_MS;
  const maxWait = input.maxWaitMs ?? REGEN_MAX_WAIT_MS;
  return new Date(
    Math.min(
      input.lastRequestedAt.getTime() + debounce,
      input.firstRequestedAt.getTime() + maxWait,
    ),
  );
}

/** The earlier of two "from" dates, null (today) winning. */
export function earlierFrom(a: LocalDate | null, b: LocalDate | null): LocalDate | null {
  if (a === null || b === null) return null;
  return a < b ? a : b;
}
