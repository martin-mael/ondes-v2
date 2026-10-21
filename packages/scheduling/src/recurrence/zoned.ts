// Station-local wall clock ↔ UTC on Intl only, with RFC 5545's rules for the two DST traps.
// `packages/shared/src/time` is still empty (the log keeps its own copy in
// apps/api/src/modules/log/time.ts); move these there when it lands.

/** `YYYY-MM-DD`, a station-local calendar date. */
export type LocalDate = string;
/** `HH:MM`, a station-local wall-clock time. */
export type LocalTime = string;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall clock of `instant` in `timeZone`, as if it were UTC (ms, seconds precision). */
function wallMs(instant: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return Date.UTC(
    p.year ?? 0,
    (p.month ?? 1) - 1,
    p.day ?? 1,
    p.hour ?? 0,
    p.minute ?? 0,
    p.second ?? 0,
  );
}

/** UTC offset of `timeZone` at `instant`, in ms (Europe/Paris: +1 h in winter, +2 h in summer). */
function offsetMs(instant: number, timeZone: string): number {
  return wallMs(instant, timeZone) - Math.floor(instant / 1000) * 1000;
}

const DAY_MS = 24 * 3600 * 1000;

function parseDate(date: LocalDate): [number, number, number] {
  return date.split('-').map(Number) as [number, number, number];
}

function parseTime(time: LocalTime): [number, number] {
  return time.split(':').map(Number) as [number, number];
}

/**
 * The instant a station-local date and time happen, following RFC 5545 (3.3.5):
 * - a time that doesn't exist (in the spring-forward gap, 02:30 on the last Sunday of March in
 *   Europe/Paris) is read with the offset before the gap, so it lands as far after the gap as
 *   it was into it: 02:30 → 03:30 CEST;
 * - a time that happens twice (in the fall-back overlap, 02:30 on the last Sunday of October)
 *   is its first occurrence, the one before the clocks go back: 02:30 CEST.
 */
export function zonedInstant(date: LocalDate, time: LocalTime, timeZone: string): Date {
  const [y, m, d] = parseDate(date);
  const [hh, mm] = parseTime(time);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  // Zone transitions are more than two days apart, so the offsets a day before and a day after
  // are the only two in play around `wall`.
  const before = offsetMs(wall - DAY_MS, timeZone);
  const after = offsetMs(wall + DAY_MS, timeZone);
  const candidates = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((t) => wallMs(t, timeZone) === wall)
    .sort((a, b) => a - b);
  // No candidate: the gap. The offset before it pushes the time past it.
  return new Date(candidates[0] ?? wall - before);
}

/** The station-local date and time of `instant` (seconds dropped). */
export function zonedParts(instant: Date, timeZone: string): { date: LocalDate; time: LocalTime } {
  const iso = new Date(wallMs(instant.getTime(), timeZone)).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** The station-local date `instant` falls on. */
export function localDateOf(instant: Date, timeZone: string): LocalDate {
  return zonedParts(instant, timeZone).date;
}

/** `date` plus `days` (calendar arithmetic, no timezone involved). */
export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Calendar days from `a` to `b`. */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  const [ay, am, ad] = parseDate(a);
  const [by, bm, bd] = parseDate(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS);
}

/** ISO weekday of a calendar date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: LocalDate): number {
  const [y, m, d] = parseDate(date);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

/** The Monday of `date`'s week (weeks start on Monday, RFC 5545 `WKST=MO`). */
export function weekStart(date: LocalDate): LocalDate {
  return addDays(date, 1 - isoWeekday(date));
}
