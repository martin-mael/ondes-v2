import type { LocalDate } from '@ondes/shared';

// Station-local day ↔ UTC for the log, on Intl only. `packages/shared/src/time` is still empty;
// move these there when it lands and import them from it.

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

/** Wall-clock fields of `instant` in `timeZone`. */
export function zonedParts(instant: Date, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** UTC offset of `timeZone` at `instant`, in ms (Europe/Paris: +1 h in winter, +2 h in summer). */
function offsetMs(instant: number, timeZone: string): number {
  const p = zonedParts(new Date(instant), timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

/** The instant local midnight starts on `y-m-d` (days overflow like `Date.UTC`). */
function localMidnight(y: number, m: number, d: number, timeZone: string): Date {
  const wall = Date.UTC(y, m - 1, d);
  const first = wall - offsetMs(wall, timeZone);
  const second = wall - offsetMs(first, timeZone);
  return new Date(second);
}

/** A station-local date as its UTC range `[startsAt, endsAt)`: 23, 24 or 25 hours. */
export function localDayBounds(localDate: LocalDate, timeZone: string) {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  return {
    startsAt: localMidnight(y, m, d, timeZone),
    endsAt: localMidnight(y, m, d + 1, timeZone),
  };
}

/** The station-local date `instant` falls on. */
export function localDateOf(instant: Date, timeZone: string): LocalDate {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** `localDate` plus `days` (calendar arithmetic, no timezone involved). */
export function addDays(localDate: LocalDate, days: number): LocalDate {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
