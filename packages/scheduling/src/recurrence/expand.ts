import { addDays, type LocalDate, type LocalTime, localDateOf, zonedInstant } from '@ondes/shared';
import { isOccurrenceDate, occurrenceDates, type SlotRule } from './rule.ts';

// Slot expansion (#44, ADR 0014): pure, station-local and DST-safe. The grid, the log generator
// (#50), missing-episode alerts (#47) and the ICS feed (#75) all read occurrences from here.
//
// An occurrence is identified by its slot and its *original* local date (RFC 5545's
// RECURRENCE-ID): a moved occurrence keeps the date it was moved from, so an episode planned
// for it stays attached. Its start is the rule's local time on that date, resolved by
// `zonedInstant` (spring-forward gap: pushed past it; fall-back overlap: the first one). Its
// duration is elapsed time, not wall-clock: a 2 h episode plays 2 h whatever the clocks do, so
// on a DST night it ends an hour later or earlier on the wall clock, and `findConflicts`
// reports any overlap that causes.

/** How far a moved occurrence may land from its original date, in days. */
export const MAX_MOVE_DAYS = 7;
/** Longest slot, in ms. */
export const MAX_SLOT_DURATION_MS = 24 * 3600 * 1000;

/** One changed occurrence of a slot, keyed by its original local date. */
export type SlotException =
  | { date: LocalDate; kind: 'cancelled' }
  | {
      date: LocalDate;
      kind: 'moved';
      /** New local start; at most `MAX_MOVE_DAYS` from `date`. */
      startDate: LocalDate;
      startTime: LocalTime;
      /** New duration, or null to keep the slot's. */
      durationMs: number | null;
    };

/** What expansion needs from a slot. Callers pass their own rows; occurrences carry them back. */
export interface ExpandableSlot {
  id: string;
  rule: SlotRule;
  durationMs: number;
  exceptions: readonly SlotException[];
}

export interface Occurrence<S extends ExpandableSlot = ExpandableSlot> {
  slot: S;
  /** The original local date: the occurrence's identity, even when moved. */
  date: LocalDate;
  startsAt: Date;
  endsAt: Date;
  durationMs: number;
  /** Moved by an exception. */
  moved: boolean;
}

/** A half-open UTC range `[from, to)`. */
export interface InstantRange {
  from: Date;
  to: Date;
}

const overlaps = (start: Date, end: Date, range: InstantRange) =>
  start < range.to && end > range.from;

/** The occurrence of `slot` on its original local `date`, or null if there is none. */
export function occurrenceOn<S extends ExpandableSlot>(
  slot: S,
  date: LocalDate,
  timeZone: string,
): Occurrence<S> | null {
  if (!isOccurrenceDate(slot.rule, date)) return null;
  const exception = slot.exceptions.find((e) => e.date === date);
  if (exception?.kind === 'cancelled') return null;
  const [startDate, startTime, durationMs] =
    exception?.kind === 'moved'
      ? [exception.startDate, exception.startTime, exception.durationMs ?? slot.durationMs]
      : [date, slot.rule.time, slot.durationMs];
  const startsAt = zonedInstant(startDate, startTime, timeZone);
  return {
    slot,
    date,
    startsAt,
    endsAt: new Date(startsAt.getTime() + durationMs),
    durationMs,
    moved: exception?.kind === 'moved',
  };
}

/**
 * Every occurrence of `slots` that overlaps `range` (`startsAt < to` and `endsAt > from`),
 * ordered by start, then slot id. Cancelled occurrences are left out; moved ones appear at their
 * new time.
 */
export function expandSlots<S extends ExpandableSlot>(
  slots: readonly S[],
  range: InstantRange,
  timeZone: string,
): Occurrence<S>[] {
  if (range.to <= range.from) return [];
  // A slot lasts at most 24 h (25 h of wall clock on a fall-back night), and a moved occurrence
  // lands at most MAX_MOVE_DAYS from its date: dates outside this window can't reach the range.
  const first = addDays(localDateOf(range.from, timeZone), -2 - MAX_MOVE_DAYS);
  const last = addDays(localDateOf(new Date(range.to.getTime() - 1), timeZone), MAX_MOVE_DAYS);
  const out: Occurrence<S>[] = [];
  for (const slot of slots) {
    for (const date of occurrenceDates(slot.rule, first, last)) {
      const occurrence = occurrenceOn(slot, date, timeZone);
      if (occurrence && overlaps(occurrence.startsAt, occurrence.endsAt, range)) {
        out.push(occurrence);
      }
    }
  }
  return out.sort(
    (a, b) =>
      a.startsAt.getTime() - b.startsAt.getTime() ||
      (a.slot.id < b.slot.id ? -1 : a.slot.id > b.slot.id ? 1 : 0),
  );
}

/** Two occurrences that overlap, `overlapMs` long. `a` starts first (or with `b`). */
export interface OccurrenceConflict<S extends ExpandableSlot = ExpandableSlot> {
  a: Occurrence<S>;
  b: Occurrence<S>;
  from: Date;
  to: Date;
  overlapMs: number;
}

/**
 * Every pair of overlapping occurrences (touching end to start is not an overlap), ordered by
 * the overlap's start. Shows can't share air time; the grid shows these and the log generator
 * refuses to place both.
 */
export function findConflicts<S extends ExpandableSlot>(
  occurrences: readonly Occurrence<S>[],
): OccurrenceConflict<S>[] {
  const sorted = [...occurrences].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const out: OccurrenceConflict<S>[] = [];
  let active: Occurrence<S>[] = [];
  for (const b of sorted) {
    active = active.filter((a) => a.endsAt > b.startsAt);
    for (const a of active) {
      const to = a.endsAt < b.endsAt ? a.endsAt : b.endsAt;
      out.push({ a, b, from: b.startsAt, to, overlapMs: to.getTime() - b.startsAt.getTime() });
    }
    active.push(b);
  }
  return out.sort((x, y) => x.from.getTime() - y.from.getTime());
}
