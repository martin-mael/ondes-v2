import { type LocalDate, localDateOf, localDayBounds } from '@ondes/shared';

// Station-local time for the timeline (#51). Every instant is UTC (ms or ISO); labels are the
// station's wall clock (its IANA timezone, not the browser's). Hours are real hours from local
// midnight, so a DST day has 23 or 25 of them: on the last Sunday of October, Europe/Paris
// shows 02:00 twice, told apart by their UTC offset.

export const HOUR_MS = 3_600_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', ...options });
    formatters.set(key, f);
  }
  return f;
}

const toDate = (at: Date | string | number) => (at instanceof Date ? at : new Date(at));

/** `14:05` or `14:05:09`, in the station's timezone. */
export function formatClock(at: Date | string | number, timeZone: string, seconds = true): string {
  return formatter(timeZone, {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  }).format(toDate(at));
}

/** The station's UTC offset at `at`: `UTC+2`. */
export function formatOffset(at: Date | string | number, timeZone: string): string {
  const part = formatter(timeZone, { timeZoneName: 'shortOffset' })
    .formatToParts(toDate(at))
    .find((p) => p.type === 'timeZoneName');
  return (part?.value ?? 'UTC').replace('GMT', 'UTC');
}

/** `3:25`, `1:02:03`; negative values get a minus sign. Rounded to the second. */
export function formatDuration(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const total = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${sign}${h}:${String(m).padStart(2, '0')}:${ss}` : `${sign}${m}:${ss}`;
}

/** `+3 s`, `-1:20`: a drift or a delta, signed. */
export function formatSigned(ms: number): string {
  if (Math.abs(ms) < 60_000) {
    const s = Math.round(ms / 1000);
    return `${s > 0 ? '+' : s < 0 ? '-' : '±'}${Math.abs(s)} s`;
  }
  return ms > 0 ? `+${formatDuration(ms)}` : formatDuration(ms);
}

/** The local day as UTC ms, `[start, end)`: 23, 24 or 25 hours. */
export function dayBounds(date: LocalDate, timeZone: string): { start: number; end: number } {
  const { startsAt, endsAt } = localDayBounds(date, timeZone);
  return { start: startsAt.getTime(), end: endsAt.getTime() };
}

/** The station-local date `at` falls on. */
export function stationDate(at: Date | number, timeZone: string): LocalDate {
  return localDateOf(toDate(at), timeZone);
}

export interface HourSlot {
  /** UTC ms, `[start, end)`. */
  start: number;
  end: number;
  /** `14:00`, with the offset when the label happens twice in the day (`02:00 UTC+1`). */
  label: string;
}

/** The real hours of a local day, from local midnight. */
export function dayHours(date: LocalDate, timeZone: string): HourSlot[] {
  const { start, end } = dayBounds(date, timeZone);
  const hours: HourSlot[] = [];
  for (let at = start; at < end; at += HOUR_MS) {
    hours.push({
      start: at,
      end: Math.min(at + HOUR_MS, end),
      label: formatClock(at, timeZone, false),
    });
  }
  const seen = new Map<string, number>();
  for (const h of hours) seen.set(h.label, (seen.get(h.label) ?? 0) + 1);
  for (const h of hours) {
    if ((seen.get(h.label) ?? 0) > 1) h.label = `${h.label} ${formatOffset(h.start, timeZone)}`;
  }
  return hours;
}
