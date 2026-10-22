import { addDays, daypartCells, zonedInstant } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import {
  type ClockGrid,
  type ClockGridOverride,
  expandGrid,
  resolveClock,
  resolveClockAt,
  unassignedHours,
} from './resolve.ts';

const PARIS = 'Europe/Paris';
// Europe/Paris in 2026: 29 March 02:00 CET → 03:00 CEST; 25 October 03:00 CEST → 02:00 CET.
// Both are Sundays (weekday 7).
const SPRING = '2026-03-29';
const FALL = '2026-10-25';

const MUSIC = '00000000-0000-7000-8000-000000000001';
const NIGHT = '00000000-0000-7000-8000-000000000002';
const MORNING = '00000000-0000-7000-8000-000000000003';
const XMAS = '00000000-0000-7000-8000-000000000004';
const SPECIAL = '00000000-0000-7000-8000-000000000005';

function grid(partial: Partial<ClockGrid> = {}): ClockGrid {
  return { defaultClockId: MUSIC, cells: [], overrides: [], ...partial };
}

function override(partial: Partial<ClockGridOverride> & { id: string }): ClockGridOverride {
  return {
    startsOn: '2026-12-24',
    endsOn: '2026-12-26',
    startHour: 0,
    endHour: 24,
    clockId: XMAS,
    ...partial,
  };
}

const day = (date: string, timeZone = PARIS) => ({
  from: zonedInstant(date, '00:00', timeZone),
  to: zonedInstant(addDays(date, 1), '00:00', timeZone),
});

describe('resolveClock', () => {
  const g = grid({
    cells: [
      { weekday: 1, hour: 7, clockId: MORNING },
      { weekday: 7, hour: 2, clockId: NIGHT },
    ],
  });

  it('gives every hour of the week exactly one clock when a default is set', () => {
    // 2026-10-19 is a Monday.
    for (let d = 19; d <= 25; d++) {
      for (let hour = 0; hour < 24; hour++) {
        const r = resolveClock(g, { date: `2026-10-${d}`, hour });
        expect(r.clockId).not.toBeNull();
        expect(r.source).not.toBe('none');
      }
    }
    expect(unassignedHours(g)).toEqual([]);
  });

  it('reads the weekly cell, then the default', () => {
    expect(resolveClock(g, { date: '2026-10-19', hour: 7 })).toEqual({
      clockId: MORNING,
      source: 'grid',
      overrideId: null,
    });
    expect(resolveClock(g, { date: '2026-10-19', hour: 8 })).toEqual({
      clockId: MUSIC,
      source: 'default',
      overrideId: null,
    });
    // Same weekday, another week.
    expect(resolveClock(g, { date: '2026-10-26', hour: 7 }).clockId).toBe(MORNING);
  });

  it('resolves to none without a cell or a default, and lists those hours', () => {
    const bare = grid({ defaultClockId: null, cells: [{ weekday: 1, hour: 0, clockId: NIGHT }] });
    expect(resolveClock(bare, { date: '2026-10-19', hour: 1 })).toEqual({
      clockId: null,
      source: 'none',
      overrideId: null,
    });
    expect(unassignedHours(bare)).toHaveLength(7 * 24 - 1);
  });

  it('lets overrides win on their dates and hours only', () => {
    const withXmas = grid({
      ...g,
      overrides: [override({ id: 'o1', startsOn: '2026-12-21', endsOn: '2026-12-27' })],
    });
    // Monday 21 December 07:00: the override beats the weekly cell.
    expect(resolveClock(withXmas, { date: '2026-12-21', hour: 7 })).toEqual({
      clockId: XMAS,
      source: 'override',
      overrideId: 'o1',
    });
    // The day after it ends, the grid is back.
    expect(resolveClock(withXmas, { date: '2026-12-28', hour: 7 }).clockId).toBe(MORNING);
    expect(resolveClock(withXmas, { date: '2026-12-20', hour: 7 }).clockId).toBe(MUSIC);

    const evenings = grid({
      overrides: [
        override({ id: 'o2', startsOn: '2026-06-21', endsOn: '2026-06-21', startHour: 18 }),
      ],
    });
    expect(resolveClock(evenings, { date: '2026-06-21', hour: 17 }).source).toBe('default');
    expect(resolveClock(evenings, { date: '2026-06-21', hour: 18 }).source).toBe('override');
    expect(resolveClock(evenings, { date: '2026-06-21', hour: 23 }).source).toBe('override');
  });

  it('picks the override with the fewest days, then the later start, then the newest', () => {
    const week = override({ id: 'a-week', startsOn: '2026-12-21', endsOn: '2026-12-27' });
    const oneDay = override({
      id: 'b-day',
      startsOn: '2026-12-24',
      endsOn: '2026-12-24',
      clockId: SPECIAL,
    });
    const both = grid({ overrides: [oneDay, week] });
    expect(resolveClock(both, { date: '2026-12-24', hour: 10 }).overrideId).toBe('b-day');
    expect(resolveClock(both, { date: '2026-12-23', hour: 10 }).overrideId).toBe('a-week');

    const early = override({ id: 'z', startsOn: '2026-12-20', endsOn: '2026-12-22' });
    const late = override({ id: 'a', startsOn: '2026-12-22', endsOn: '2026-12-24' });
    expect(
      resolveClock(grid({ overrides: [early, late] }), { date: '2026-12-22', hour: 0 }).overrideId,
    ).toBe('a');

    const older = override({ id: '0190', clockId: SPECIAL });
    const newer = override({ id: '0191' });
    expect(
      resolveClock(grid({ overrides: [newer, older] }), { date: '2026-12-25', hour: 0 }).clockId,
    ).toBe(XMAS);
  });

  it('ignores an override whose clock was deleted', () => {
    const g2 = grid({ overrides: [override({ id: 'o', clockId: null })] });
    expect(resolveClock(g2, { date: '2026-12-25', hour: 9 }).source).toBe('default');
  });
});

describe('expandGrid', () => {
  it('tiles an ordinary day with 24 one-hour blocks', () => {
    const hours = expandGrid(grid(), day('2026-10-19'), PARIS);
    expect(hours).toHaveLength(24);
    expect(hours[0]?.startsAt.toISOString()).toBe('2026-10-18T22:00:00.000Z');
    for (const [i, h] of hours.entries()) {
      expect(h.hour).toBe(i);
      expect(h.endsAt.getTime() - h.startsAt.getTime()).toBe(3_600_000);
      expect(h.repeated).toBe(false);
    }
  });

  it('skips the 02:00 hour the night clocks go forward (23 hours)', () => {
    const g = grid({
      cells: [
        { weekday: 7, hour: 1, clockId: MORNING },
        { weekday: 7, hour: 2, clockId: NIGHT },
        { weekday: 7, hour: 3, clockId: SPECIAL },
      ],
    });
    const hours = expandGrid(g, day(SPRING), PARIS);
    expect(hours).toHaveLength(23);
    expect(hours.map((h) => h.hour)).not.toContain(2);
    expect(hours.some((h) => h.clockId === NIGHT)).toBe(false);
    const one = hours.find((h) => h.hour === 1);
    const three = hours.find((h) => h.hour === 3);
    // 01:00 CET is 00:00Z and lasts one real hour; 03:00 CEST is 01:00Z.
    expect(one?.startsAt.toISOString()).toBe('2026-03-29T00:00:00.000Z');
    expect(one?.endsAt.toISOString()).toBe('2026-03-29T01:00:00.000Z');
    expect(one?.clockId).toBe(MORNING);
    expect(three?.startsAt.toISOString()).toBe('2026-03-29T01:00:00.000Z');
    expect(three?.clockId).toBe(SPECIAL);
    // A week later the 02 cell airs again.
    expect(expandGrid(g, day('2026-04-05'), PARIS)[2]?.clockId).toBe(NIGHT);
  });

  it('airs the 02:00 hour twice the night clocks go back (25 hours)', () => {
    const g = grid({ cells: [{ weekday: 7, hour: 2, clockId: NIGHT }] });
    const hours = expandGrid(g, day(FALL), PARIS);
    expect(hours).toHaveLength(25);
    const twos = hours.filter((h) => h.hour === 2);
    expect(twos).toHaveLength(2);
    expect(twos.map((h) => [h.startsAt.toISOString(), h.repeated, h.clockId])).toEqual([
      ['2026-10-25T00:00:00.000Z', false, NIGHT], // 02:00 CEST
      ['2026-10-25T01:00:00.000Z', true, NIGHT], // 02:00 CET
    ]);
    expect(hours.find((h) => h.hour === 3)?.startsAt.toISOString()).toBe(
      '2026-10-25T02:00:00.000Z',
    );
    // Contiguous: every hour ends where the next starts.
    for (let i = 1; i < hours.length; i++) {
      expect(hours[i]?.startsAt.getTime()).toBe(hours[i - 1]?.endsAt.getTime());
    }
  });

  it('applies overrides on DST nights by local date', () => {
    const g = grid({
      overrides: [override({ id: 'o', startsOn: FALL, endsOn: FALL, startHour: 2, endHour: 3 })],
    });
    const twos = expandGrid(g, day(FALL), PARIS).filter((h) => h.hour === 2);
    expect(twos.map((h) => h.source)).toEqual(['override', 'override']);
  });

  it('cuts to the range and tiles a whole week', () => {
    const from = new Date('2026-10-19T10:30:00Z');
    const to = new Date('2026-10-19T12:00:00Z');
    const hours = expandGrid(grid(), { from, to }, PARIS);
    // 12:00–13:00 CEST (straddles `from`) and 13:00–14:00.
    expect(hours.map((h) => h.hour)).toEqual([12, 13]);
    const week = expandGrid(
      grid(),
      { from: day('2026-10-19').from, to: day('2026-10-25').to },
      PARIS,
    );
    expect(week).toHaveLength(7 * 24 + 1);
  });

  it('works in zones with half-hour offsets', () => {
    const hours = expandGrid(grid(), day('2026-10-19', 'Asia/Kolkata'), 'Asia/Kolkata');
    expect(hours).toHaveLength(24);
    expect(hours[0]?.startsAt.toISOString()).toBe('2026-10-18T18:30:00.000Z');
  });
});

describe('resolveClockAt', () => {
  const g = grid({ cells: [{ weekday: 7, hour: 2, clockId: NIGHT }] });

  it('finds both runs of the repeated hour', () => {
    const first = resolveClockAt(g, new Date('2026-10-25T00:30:00Z'), PARIS);
    const second = resolveClockAt(g, new Date('2026-10-25T01:30:00Z'), PARIS);
    expect([first.hour, first.repeated, first.clockId]).toEqual([2, false, NIGHT]);
    expect([second.hour, second.repeated, second.clockId]).toEqual([2, true, NIGHT]);
  });

  it('never lands in the skipped hour', () => {
    const at = resolveClockAt(g, new Date('2026-03-29T01:00:00Z'), PARIS);
    expect([at.date, at.hour, at.source]).toEqual([SPRING, 3, 'default']);
  });
});

describe('daypartCells', () => {
  it('covers a daytime range on each weekday', () => {
    const cells = daypartCells({ weekdays: [1, 2], startHour: 6, endHour: 10 });
    expect(cells).toHaveLength(8);
    expect(cells[0]).toEqual({ weekday: 1, hour: 6 });
    expect(cells[7]).toEqual({ weekday: 2, hour: 9 });
  });

  it('runs past midnight into the next day, Sunday into Monday', () => {
    const cells = daypartCells({ weekdays: [7], startHour: 22, endHour: 2 });
    expect(cells).toEqual([
      { weekday: 1, hour: 0 },
      { weekday: 1, hour: 1 },
      { weekday: 7, hour: 22 },
      { weekday: 7, hour: 23 },
    ]);
  });

  it('reads 0–24 and equal ends as the whole day', () => {
    expect(daypartCells({ weekdays: [3], startHour: 0, endHour: 24 })).toHaveLength(24);
    expect(daypartCells({ weekdays: [3], startHour: 5, endHour: 5 })).toHaveLength(24);
    expect(
      daypartCells({ weekdays: [1, 2, 3, 4, 5, 6, 7], startHour: 0, endHour: 24 }),
    ).toHaveLength(168);
  });
});
