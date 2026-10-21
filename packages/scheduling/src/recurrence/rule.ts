import {
  addDays,
  daysBetween,
  isoWeekday,
  type LocalDate,
  type LocalTime,
  weekStart,
  zonedInstant,
} from '@ondes/shared';

// Show slot recurrence (#44, ADR 0014): a structured subset of RFC 5545 RRULE, in the
// station's timezone. Validation lives in the contract (packages/shared/src/contracts/shows.ts);
// these functions assume a valid rule.

export const WEEKDAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * When a slot happens, in station-local wall-clock time.
 * - `once`: a one-off on `date` at `time`.
 * - `weekly`: every `interval` weeks on `byDay`, at `time`, from `startDate` (the first
 *   possible occurrence) to `until` (the last possible one, inclusive; null: no end). Weeks
 *   start on Monday and are counted from `startDate`'s week: `RRULE:FREQ=WEEKLY;WKST=MO`.
 */
export type SlotRule =
  | { freq: 'once'; date: LocalDate; time: LocalTime }
  | {
      freq: 'weekly';
      startDate: LocalDate;
      until: LocalDate | null;
      interval: number;
      byDay: readonly Weekday[];
      time: LocalTime;
    };

/** The first local date the rule can happen on. */
export function ruleStartDate(rule: SlotRule): LocalDate {
  return rule.freq === 'once' ? rule.date : rule.startDate;
}

/** The last local date the rule can happen on, or null when it never ends. */
export function ruleEndDate(rule: SlotRule): LocalDate | null {
  return rule.freq === 'once' ? rule.date : rule.until;
}

/** Whether the rule has an occurrence on station-local `date`. */
export function isOccurrenceDate(rule: SlotRule, date: LocalDate): boolean {
  if (rule.freq === 'once') return date === rule.date;
  if (date < rule.startDate || (rule.until !== null && date > rule.until)) return false;
  if (!rule.byDay.includes(WEEKDAYS[isoWeekday(date) - 1] as Weekday)) return false;
  const weeks = daysBetween(weekStart(rule.startDate), weekStart(date)) / 7;
  return weeks % Math.max(1, rule.interval) === 0;
}

/** The rule's occurrence dates in `[from, to]` (local dates, inclusive), in order. */
export function occurrenceDates(rule: SlotRule, from: LocalDate, to: LocalDate): LocalDate[] {
  const start = from > ruleStartDate(rule) ? from : ruleStartDate(rule);
  const endDate = ruleEndDate(rule);
  const end = endDate !== null && endDate < to ? endDate : to;
  const out: LocalDate[] = [];
  const days = daysBetween(start, end);
  for (let i = 0; i <= days; i++) {
    const date = addDays(start, i);
    if (isOccurrenceDate(rule, date)) out.push(date);
  }
  return out;
}

const icsDate = (date: LocalDate, time: LocalTime) =>
  `${date.replaceAll('-', '')}T${time.replace(':', '')}00`;
const icsUtc = (d: Date) => `${d.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;

/**
 * The rule as iCalendar lines (for the ICS feed, #75): `DTSTART;TZID=…` and, for a weekly rule,
 * its `RRULE`. `UNTIL` is UTC, as RFC 5545 requires with a `TZID` start. Exceptions become
 * `EXDATE`/`RECURRENCE-ID` entries, which are the feed's to write.
 */
export function toIcsLines(rule: SlotRule, timeZone: string): string[] {
  const dtstart = `DTSTART;TZID=${timeZone}:${icsDate(ruleStartDate(rule), rule.time)}`;
  if (rule.freq === 'once') return [dtstart];
  const parts = [
    'FREQ=WEEKLY',
    `INTERVAL=${rule.interval}`,
    `BYDAY=${rule.byDay.map((d) => d.toUpperCase()).join(',')}`,
    'WKST=MO',
  ];
  if (rule.until !== null)
    parts.push(`UNTIL=${icsUtc(zonedInstant(rule.until, rule.time, timeZone))}`);
  return [dtstart, `RRULE:${parts.join(';')}`];
}
