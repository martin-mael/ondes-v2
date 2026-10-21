import type { LocalDate, SlotRule, Weekday } from '@ondes/shared';
import type { Locale } from '../../app/i18n/messages.ts';
import type { ShowT } from './messages.ts';

// Formatting for the shows pages. Instants are shown on the station's wall clock; local dates
// (`YYYY-MM-DD`) are calendar dates, formatted without any timezone shift.

export const weekdays: readonly Weekday[] = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];

/** A calendar date as a UTC instant at noon, for `Intl` with `timeZone: 'UTC'`. */
const noon = (date: LocalDate) => new Date(`${date}T12:00:00Z`);

/** `20:00` on the station's clock. */
export function formatTime(instant: Date, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
}

/** `Tue 21 Oct` (or with the year when asked). */
export function formatDay(
  date: LocalDate,
  locale: Locale,
  options: Intl.DateTimeFormatOptions = {},
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...options,
  }).format(noon(date));
}

/** `October 2026` */
export function formatMonth(date: LocalDate, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(noon(date));
}

/** Short weekday name: `Mon`, `lun.`. */
export function weekdayName(day: Weekday, locale: Locale, width: 'short' | 'long' = 'short') {
  // 2024-01-01 is a Monday.
  const date = `2024-01-0${weekdays.indexOf(day) + 1}`;
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: width }).format(noon(date));
}

/** `2 h`, `1 h 30`, `45 min`. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
}

/** "Every Tuesday at 20:00", "Every 2 weeks on Tue, Thu at 20:00", "Once, Tue 21 Oct at 20:00". */
export function ruleSummary(rule: SlotRule, t: ShowT, locale: Locale): string {
  if (rule.freq === 'once') {
    return t('rule.once', {
      date: formatDay(rule.date, locale, { year: 'numeric' }),
      time: rule.time,
    });
  }
  const sorted = [...rule.byDay].sort((a, b) => weekdays.indexOf(a) - weekdays.indexOf(b));
  const days = sorted
    .map((d) => weekdayName(d, locale, sorted.length === 1 ? 'long' : 'short'))
    .join(', ');
  const base =
    rule.interval === 1
      ? t('rule.weekly', { days, time: rule.time })
      : t('rule.everyN', { n: rule.interval, days, time: rule.time });
  return rule.until ? `${base} ${t('rule.until', { date: formatDay(rule.until, locale) })}` : base;
}
