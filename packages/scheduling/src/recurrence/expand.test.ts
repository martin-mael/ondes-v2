import { addDays, localDateOf, zonedInstant, zonedParts } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import {
  type ExpandableSlot,
  expandSlots,
  findConflicts,
  occurrenceOn,
  type SlotException,
} from './expand.ts';
import { isOccurrenceDate, type SlotRule, toIcsLines, type Weekday } from './rule.ts';

const PARIS = 'Europe/Paris';
const H = 3600 * 1000;
// Europe/Paris in 2026: CET (+1) until the last Sunday of March, 29 March at 02:00 → 03:00
// CEST (+2); back at 03:00 → 02:00 on the last Sunday of October, 25 October.
const SPRING = '2026-03-29';
const FALL = '2026-10-25';

const iso = (d: Date) => d.toISOString();

/** `value`, failing the test when it's missing. */
function defined<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  if (value === undefined) throw new Error('expected a value');
  return value;
}
const range = (from: string, to: string) => ({ from: new Date(from), to: new Date(to) });

function weekly(
  time: string,
  byDay: Weekday[],
  options: { startDate?: string; until?: string | null; interval?: number } = {},
): SlotRule {
  return {
    freq: 'weekly',
    startDate: options.startDate ?? '2026-01-05',
    until: options.until ?? null,
    interval: options.interval ?? 1,
    byDay,
    time,
  };
}

function slot(
  rule: SlotRule,
  durationMs = 2 * H,
  exceptions: SlotException[] = [],
  id = 'slot-a',
): ExpandableSlot {
  return { id, rule, durationMs, exceptions };
}

describe('zonedInstant', () => {
  it('converts ordinary local times with the season offset', () => {
    expect(iso(zonedInstant('2026-01-15', '20:00', PARIS))).toBe('2026-01-15T19:00:00.000Z');
    expect(iso(zonedInstant('2026-07-15', '20:00', PARIS))).toBe('2026-07-15T18:00:00.000Z');
  });

  it('pushes a time in the spring-forward gap past it (02:30 → 03:30 CEST)', () => {
    const t = zonedInstant(SPRING, '02:30', PARIS);
    expect(iso(t)).toBe('2026-03-29T01:30:00.000Z');
    expect(zonedParts(t, PARIS)).toEqual({ date: SPRING, time: '03:30' });
    // The gap's edges.
    expect(iso(zonedInstant(SPRING, '02:00', PARIS))).toBe('2026-03-29T01:00:00.000Z');
    expect(iso(zonedInstant(SPRING, '01:59', PARIS))).toBe('2026-03-29T00:59:00.000Z');
    expect(iso(zonedInstant(SPRING, '03:00', PARIS))).toBe('2026-03-29T01:00:00.000Z');
  });

  it('keeps times just around the gap exact', () => {
    expect(iso(zonedInstant(SPRING, '01:30', PARIS))).toBe('2026-03-29T00:30:00.000Z');
    expect(iso(zonedInstant(SPRING, '03:30', PARIS))).toBe('2026-03-29T01:30:00.000Z');
  });

  it('takes the first of a repeated fall-back time (02:30 CEST, not CET)', () => {
    const t = zonedInstant(FALL, '02:30', PARIS);
    expect(iso(t)).toBe('2026-10-25T00:30:00.000Z');
    expect(iso(zonedInstant(FALL, '02:00', PARIS))).toBe('2026-10-25T00:00:00.000Z');
    expect(iso(zonedInstant(FALL, '01:30', PARIS))).toBe('2026-10-24T23:30:00.000Z');
    expect(iso(zonedInstant(FALL, '03:00', PARIS))).toBe('2026-10-25T02:00:00.000Z');
  });

  it('round-trips every quarter hour of 2026 outside the gap', () => {
    for (let day = '2026-01-01'; day < '2027-01-01'; day = addDays(day, 1)) {
      for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
        const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
        if (day === SPRING && time >= '02:00' && time < '03:00') continue;
        expect(zonedParts(zonedInstant(day, time, PARIS), PARIS)).toEqual({ date: day, time });
      }
    }
  });

  it('works in other zones (New York, Sydney, Kolkata)', () => {
    // America/New_York springs forward on 8 March 2026 at 02:00.
    expect(iso(zonedInstant('2026-03-08', '02:30', 'America/New_York'))).toBe(
      '2026-03-08T07:30:00.000Z',
    );
    // Australia/Sydney goes back on 5 April 2026 at 03:00 → 02:00 (AEDT +11 → AEST +10).
    expect(iso(zonedInstant('2026-04-05', '02:30', 'Australia/Sydney'))).toBe(
      '2026-04-04T15:30:00.000Z',
    );
    expect(iso(zonedInstant('2026-06-01', '10:00', 'Asia/Kolkata'))).toBe(
      '2026-06-01T04:30:00.000Z',
    );
  });
});

describe('isOccurrenceDate', () => {
  it('matches weekdays every N weeks from the start week', () => {
    // 2026-01-05 is a Monday; every 2 weeks on Monday and Thursday.
    const rule = weekly('20:00', ['mo', 'th'], { interval: 2 });
    expect(isOccurrenceDate(rule, '2026-01-05')).toBe(true);
    expect(isOccurrenceDate(rule, '2026-01-08')).toBe(true);
    expect(isOccurrenceDate(rule, '2026-01-12')).toBe(false);
    expect(isOccurrenceDate(rule, '2026-01-15')).toBe(false);
    expect(isOccurrenceDate(rule, '2026-01-19')).toBe(true);
    expect(isOccurrenceDate(rule, '2026-01-06')).toBe(false);
  });

  it('counts weeks from the start date week even when it starts mid-week', () => {
    // Starts on Wednesday 7 Jan: Monday 5 Jan is before the start, Monday 19 Jan is week 2.
    const rule = weekly('20:00', ['mo', 'fr'], { startDate: '2026-01-07', interval: 2 });
    expect(isOccurrenceDate(rule, '2026-01-05')).toBe(false);
    expect(isOccurrenceDate(rule, '2026-01-09')).toBe(true);
    expect(isOccurrenceDate(rule, '2026-01-12')).toBe(false);
    expect(isOccurrenceDate(rule, '2026-01-19')).toBe(true);
  });

  it('stops after until (inclusive) and handles one-offs', () => {
    const rule = weekly('20:00', ['mo'], { until: '2026-01-12' });
    expect(isOccurrenceDate(rule, '2026-01-12')).toBe(true);
    expect(isOccurrenceDate(rule, '2026-01-19')).toBe(false);
    const once: SlotRule = { freq: 'once', date: '2026-05-01', time: '12:00' };
    expect(isOccurrenceDate(once, '2026-05-01')).toBe(true);
    expect(isOccurrenceDate(once, '2026-05-08')).toBe(false);
  });
});

describe('expandSlots across DST (Europe/Paris)', () => {
  const sundays = (time: string) =>
    expandSlots(
      [slot(weekly(time, ['su']))],
      range('2026-03-21T00:00:00Z', '2026-04-06T00:00:00Z'),
      PARIS,
    ).map((o) => ({ date: o.date, start: iso(o.startsAt), end: iso(o.endsAt) }));

  it('a weekly 02:30 slot starts at 03:30 CEST on the spring-forward Sunday', () => {
    expect(sundays('02:30')).toEqual([
      { date: '2026-03-22', start: '2026-03-22T01:30:00.000Z', end: '2026-03-22T03:30:00.000Z' },
      { date: SPRING, start: '2026-03-29T01:30:00.000Z', end: '2026-03-29T03:30:00.000Z' },
      { date: '2026-04-05', start: '2026-04-05T00:30:00.000Z', end: '2026-04-05T02:30:00.000Z' },
    ]);
  });

  it('a weekly 01:30 slot keeps its time and its 2 h on the spring-forward Sunday', () => {
    const [, spring] = sundays('01:30');
    // 01:30 CET → 04:30 CEST: two hours of air, three on the wall clock.
    expect(spring).toEqual({
      date: SPRING,
      start: '2026-03-29T00:30:00.000Z',
      end: '2026-03-29T02:30:00.000Z',
    });
    expect(zonedParts(new Date(defined(spring).end), PARIS).time).toBe('04:30');
  });

  it('a weekly 02:30 slot airs once, at the first 02:30, on the fall-back Sunday', () => {
    const occurrences = expandSlots(
      [slot(weekly('02:30', ['su']))],
      range('2026-10-17T00:00:00Z', '2026-11-02T00:00:00Z'),
      PARIS,
    );
    expect(occurrences.map((o) => [o.date, iso(o.startsAt)])).toEqual([
      ['2026-10-18', '2026-10-18T00:30:00.000Z'],
      [FALL, '2026-10-25T00:30:00.000Z'],
      ['2026-11-01', '2026-11-01T01:30:00.000Z'],
    ]);
    // 02:30 CEST + 2 h = 03:30 CET: the wall clock shows one hour.
    expect(zonedParts(defined(occurrences[1]).endsAt, PARIS).time).toBe('03:30');
  });

  it('a weekly 01:30 slot on the fall-back Sunday starts before the change', () => {
    const occurrences = expandSlots(
      [slot(weekly('01:30', ['su']))],
      range('2026-10-24T22:00:00Z', '2026-10-26T00:00:00Z'),
      PARIS,
    );
    expect(occurrences).toHaveLength(1);
    const occurrence = defined(occurrences[0]);
    expect(iso(occurrence.startsAt)).toBe('2026-10-24T23:30:00.000Z');
    expect(occurrence.date).toBe(FALL);
  });

  it('keeps an evening show at its local time across both changes', () => {
    const occurrences = expandSlots(
      [slot(weekly('20:00', ['sa', 'su', 'mo']))],
      range('2026-03-27T00:00:00Z', '2026-10-27T00:00:00Z'),
      PARIS,
    );
    for (const o of occurrences) {
      expect(zonedParts(o.startsAt, PARIS)).toEqual({ date: o.date, time: '20:00' });
    }
    expect(occurrences.map((o) => o.date).slice(0, 3)).toEqual([
      '2026-03-28',
      SPRING,
      '2026-03-30',
    ]);
    expect(occurrences.at(-1)?.date).toBe('2026-10-26');
  });

  it('expands the 23 h and 25 h days fully', () => {
    const hourly = (['00', '04', '08', '12', '16', '20'] as const).map((h, i) =>
      slot(weekly(`${h}:00`, ['su']), H, [], `slot-${i}`),
    );
    const day = (date: string) => {
      const from = zonedInstant(date, '00:00', PARIS);
      const to = zonedInstant(addDays(date, 1), '00:00', PARIS);
      return {
        length: (to.getTime() - from.getTime()) / H,
        n: expandSlots(hourly, { from, to }, PARIS).length,
      };
    };
    expect(day(SPRING)).toEqual({ length: 23, n: 6 });
    expect(day(FALL)).toEqual({ length: 25, n: 6 });
  });
});

describe('expandSlots', () => {
  it('returns occurrences overlapping the range, including one that started before it', () => {
    const late = slot(weekly('23:00', ['mo']), 3 * H);
    // Monday 12 Jan 23:00 CET = 22:00Z, ends 01:00Z on the 13th.
    const out = expandSlots([late], range('2026-01-13T00:00:00Z', '2026-01-14T00:00:00Z'), PARIS);
    expect(out.map((o) => [o.date, iso(o.startsAt)])).toEqual([
      ['2026-01-12', '2026-01-12T22:00:00.000Z'],
    ]);
    // Touching the range's start is not overlapping it.
    expect(
      expandSlots([late], range('2026-01-13T01:00:00Z', '2026-01-14T00:00:00Z'), PARIS),
    ).toEqual([]);
  });

  it('skips cancelled occurrences and moves moved ones, keeping their original date', () => {
    const s = slot(weekly('20:00', ['mo']), 2 * H, [
      { date: '2026-01-12', kind: 'cancelled' },
      {
        date: '2026-01-19',
        kind: 'moved',
        startDate: '2026-01-21',
        startTime: '18:00',
        durationMs: H,
      },
    ]);
    const out = expandSlots([s], range('2026-01-05T00:00:00Z', '2026-01-27T00:00:00Z'), PARIS);
    expect(out.map((o) => [o.date, iso(o.startsAt), o.durationMs, o.moved])).toEqual([
      ['2026-01-05', '2026-01-05T19:00:00.000Z', 2 * H, false],
      ['2026-01-19', '2026-01-21T17:00:00.000Z', H, true],
      ['2026-01-26', '2026-01-26T19:00:00.000Z', 2 * H, false],
    ]);
  });

  it('finds an occurrence moved into the range from a date outside it', () => {
    const s = slot(weekly('20:00', ['mo']), 2 * H, [
      {
        date: '2026-01-05',
        kind: 'moved',
        startDate: '2026-01-11',
        startTime: '10:00',
        durationMs: null,
      },
    ]);
    const out = expandSlots([s], range('2026-01-10T00:00:00Z', '2026-01-12T00:00:00Z'), PARIS);
    expect(out.map((o) => [o.date, iso(o.startsAt)])).toEqual([
      ['2026-01-05', '2026-01-11T09:00:00.000Z'],
    ]);
  });

  it('ignores exceptions on dates that are not occurrences', () => {
    const s = slot(weekly('20:00', ['mo']), 2 * H, [
      {
        date: '2026-01-06',
        kind: 'moved',
        startDate: '2026-01-07',
        startTime: '10:00',
        durationMs: null,
      },
    ]);
    expect(occurrenceOn(s, '2026-01-06', PARIS)).toBeNull();
    expect(expandSlots([s], range('2026-01-06T00:00:00Z', '2026-01-08T00:00:00Z'), PARIS)).toEqual(
      [],
    );
  });

  it('expands one-offs and orders several slots by start', () => {
    const a = slot({ freq: 'once', date: '2026-05-01', time: '12:00' }, H, [], 'b');
    const b = slot(weekly('09:00', ['fr']), H, [], 'a');
    const out = expandSlots([a, b], range('2026-04-30T00:00:00Z', '2026-05-02T00:00:00Z'), PARIS);
    expect(out.map((o) => [o.slot.id, iso(o.startsAt)])).toEqual([
      ['a', '2026-05-01T07:00:00.000Z'],
      ['b', '2026-05-01T10:00:00.000Z'],
    ]);
  });

  it('respects interval, start and until across a long range', () => {
    const s = slot(
      weekly('20:00', ['we'], { startDate: '2026-02-04', until: '2026-03-18', interval: 2 }),
    );
    const out = expandSlots([s], range('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'), PARIS);
    expect(out.map((o) => o.date)).toEqual([
      '2026-02-04',
      '2026-02-18',
      '2026-03-04',
      '2026-03-18',
    ]);
  });

  it('returns nothing for an empty range', () => {
    const s = slot(weekly('20:00', ['mo']));
    expect(expandSlots([s], range('2026-01-05T20:00:00Z', '2026-01-05T20:00:00Z'), PARIS)).toEqual(
      [],
    );
  });
});

describe('findConflicts', () => {
  it('reports overlapping occurrences with the overlap length', () => {
    const a = slot(weekly('20:00', ['mo']), 2 * H, [], 'a');
    const b = slot(weekly('21:30', ['mo']), H, [], 'b');
    const c = slot(weekly('22:00', ['mo']), H, [], 'c');
    const occurrences = expandSlots(
      [a, b, c],
      range('2026-01-05T00:00:00Z', '2026-01-06T00:00:00Z'),
      PARIS,
    );
    const conflicts = findConflicts(occurrences);
    // a/b overlap 30 min; b/c overlap 30 min; a ends exactly when c starts.
    expect(conflicts.map((x) => [x.a.slot.id, x.b.slot.id, x.overlapMs, iso(x.from)])).toEqual([
      ['a', 'b', 30 * 60 * 1000, '2026-01-05T20:30:00.000Z'],
      ['b', 'c', 30 * 60 * 1000, '2026-01-05T21:00:00.000Z'],
    ]);
  });

  it('catches the overlap a DST night creates between back-to-back slots', () => {
    // 01:00–03:00 then 03:00 on the wall clock: adjacent most weeks; on the spring-forward
    // night the first runs 2 h of air until 04:00 CEST, an hour into the next.
    const a = slot(weekly('01:00', ['su']), 2 * H, [], 'a');
    const b = slot(weekly('03:00', ['su']), 2 * H, [], 'b');
    const week = (from: string) =>
      findConflicts(
        expandSlots(
          [a, b],
          { from: new Date(from), to: new Date(Date.parse(from) + 24 * H) },
          PARIS,
        ),
      );
    expect(week('2026-03-22T00:00:00Z')).toEqual([]);
    const [conflict] = week('2026-03-29T00:00:00Z');
    expect(conflict?.overlapMs).toBe(H);
    // And on the fall-back night they leave an hour of gap, not an overlap.
    expect(week('2026-10-24T22:00:00Z')).toEqual([]);
  });
});

describe('toIcsLines', () => {
  it('writes DTSTART with the zone and a weekly RRULE with a UTC UNTIL', () => {
    expect(
      toIcsLines(weekly('20:00', ['mo', 'th'], { interval: 2, until: '2026-07-02' }), PARIS),
    ).toEqual([
      'DTSTART;TZID=Europe/Paris:20260105T200000',
      'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;WKST=MO;UNTIL=20260702T180000Z',
    ]);
    expect(toIcsLines({ freq: 'once', date: '2026-05-01', time: '12:00' }, PARIS)).toEqual([
      'DTSTART;TZID=Europe/Paris:20260501T120000',
    ]);
  });
});

describe('localDateOf', () => {
  it('reads the station-local date of an instant', () => {
    expect(localDateOf(new Date('2026-03-28T23:30:00Z'), PARIS)).toBe(SPRING);
    expect(localDateOf(new Date('2026-03-28T22:59:00Z'), PARIS)).toBe('2026-03-28');
  });
});
