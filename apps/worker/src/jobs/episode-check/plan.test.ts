import { expandSlots } from '@ondes/scheduling';
import type { SlotRule } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { type CheckedOccurrence, dueSteps, nextStepAt } from './plan.ts';

const PARIS = 'Europe/Paris';
const HOUR = 3600 * 1000;

/** The station-local occurrence of a weekly slot on `date`, through the real expansion. */
function occurrence(date: string, time: string, hasAudio = false): CheckedOccurrence {
  const rule: SlotRule = {
    freq: 'weekly',
    startDate: '2026-01-05',
    until: null,
    interval: 1,
    byDay: ['su'],
    time,
  };
  const day = new Date(`${date}T00:00:00Z`);
  const [occ] = expandSlots(
    [{ id: 'slot', rule, durationMs: 2 * HOUR, exceptions: [] }],
    { from: new Date(day.getTime() - 12 * HOUR), to: new Date(day.getTime() + 36 * HOUR) },
    PARIS,
  ).filter((o) => o.date === date);
  if (!occ) throw new Error(`no occurrence on ${date}`);
  return { slotId: 'slot', date, startsAt: occ.startsAt, endsAt: occ.endsAt, hasAudio };
}

const at = (iso: string) => new Date(iso);
const ms = (d: Date | null) => d?.toISOString();

describe('dueSteps', () => {
  const occ = occurrence('2026-11-15', '20:00'); // CET: 19:00Z

  it('records nothing before T−48h or once the audio is there', () => {
    expect(dueSteps(occ, at('2026-11-13T18:59:59Z'))).toEqual([]);
    expect(dueSteps({ ...occ, hasAudio: true }, at('2026-11-15T18:30:00Z'))).toEqual([]);
  });

  it('records the 48 h alert, then the 6 h one, then the fallback', () => {
    expect(dueSteps(occ, at('2026-11-13T19:00:00Z'))).toEqual(['t48h']);
    expect(dueSteps(occ, at('2026-11-14T10:00:00Z'), new Set(['t48h']))).toEqual([]);
    expect(dueSteps(occ, at('2026-11-15T13:00:00Z'), new Set(['t48h']))).toEqual(['t6h']);
    expect(dueSteps(occ, at('2026-11-15T18:00:00Z'), new Set(['t48h', 't6h']))).toEqual([
      'fallback',
    ]);
  });

  it('skips the 48 h alert of an occurrence first seen less than 6 h ahead', () => {
    expect(dueSteps(occ, at('2026-11-15T15:00:00Z'))).toEqual(['t6h']);
    expect(dueSteps(occ, at('2026-11-15T15:00:00Z'), new Set(['t6h']))).toEqual([]);
    // Within the hour: the alert and the fallback together.
    expect(dueSteps(occ, at('2026-11-15T18:30:00Z'))).toEqual(['t6h', 'fallback']);
  });

  it('still applies a late fallback during the occurrence, never after it', () => {
    expect(dueSteps(occ, at('2026-11-15T19:30:00Z'))).toEqual(['fallback']);
    expect(dueSteps(occ, at('2026-11-15T21:00:00Z'))).toEqual([]);
  });
});

describe('thresholds across DST (Europe/Paris)', () => {
  it('spring forward: a Sunday 20:00 slot after the night of 29 March', () => {
    // 20:00 CEST = 18:00Z. 48 h before is Friday 18:00Z = 19:00 CET: 47 h of wall clock.
    const occ = occurrence('2026-03-29', '20:00');
    expect(ms(occ.startsAt)).toBe('2026-03-29T18:00:00.000Z');
    expect(ms(nextStepAt(occ, at('2026-03-20T00:00:00Z')))).toBe('2026-03-27T18:00:00.000Z');
    expect(dueSteps(occ, at('2026-03-27T17:59:59Z'))).toEqual([]);
    expect(dueSteps(occ, at('2026-03-27T18:00:00Z'))).toEqual(['t48h']);
    // 6 h before: 12:00Z = 14:00 CEST, the same day.
    expect(dueSteps(occ, at('2026-03-29T11:59:59Z'), new Set(['t48h']))).toEqual([]);
    expect(dueSteps(occ, at('2026-03-29T12:00:00Z'), new Set(['t48h']))).toEqual(['t6h']);
  });

  it('spring forward: a 02:30 slot that lands after the gap', () => {
    // 02:30 doesn't exist on 29 March: it airs at 03:30 CEST = 01:30Z (ADR 0014).
    const occ = occurrence('2026-03-29', '02:30');
    expect(ms(occ.startsAt)).toBe('2026-03-29T01:30:00.000Z');
    // 6 h before is 19:30Z on Saturday = 20:30 CET (the wall clock says 7 h).
    expect(dueSteps(occ, at('2026-03-28T19:29:59Z'), new Set(['t48h']))).toEqual([]);
    expect(dueSteps(occ, at('2026-03-28T19:30:00Z'), new Set(['t48h']))).toEqual(['t6h']);
    expect(dueSteps(occ, at('2026-03-27T01:30:00Z'))).toEqual(['t48h']);
  });

  it('fall back: a Sunday 20:00 slot after the night of 25 October', () => {
    // 20:00 CET = 19:00Z. 48 h before is Friday 19:00Z = 21:00 CEST: 49 h of wall clock.
    const occ = occurrence('2026-10-25', '20:00');
    expect(ms(occ.startsAt)).toBe('2026-10-25T19:00:00.000Z');
    expect(dueSteps(occ, at('2026-10-23T18:59:59Z'))).toEqual([]);
    expect(dueSteps(occ, at('2026-10-23T19:00:00Z'))).toEqual(['t48h']);
    expect(dueSteps(occ, at('2026-10-25T13:00:00Z'), new Set(['t48h']))).toEqual(['t6h']);
    expect(dueSteps(occ, at('2026-10-25T18:00:00Z'), new Set(['t48h', 't6h']))).toEqual([
      'fallback',
    ]);
  });

  it('fall back: a 02:30 slot airs at the first 02:30', () => {
    // 02:30 happens twice; the occurrence is the first one, CEST = 00:30Z.
    const occ = occurrence('2026-10-25', '02:30');
    expect(ms(occ.startsAt)).toBe('2026-10-25T00:30:00.000Z');
    // 6 h before: 18:30Z on Saturday = 20:30 CEST.
    expect(dueSteps(occ, at('2026-10-24T18:29:59Z'), new Set(['t48h']))).toEqual([]);
    expect(dueSteps(occ, at('2026-10-24T18:30:00Z'), new Set(['t48h']))).toEqual(['t6h']);
    expect(ms(nextStepAt(occ, at('2026-10-24T18:30:00Z')))).toBe('2026-10-24T23:30:00.000Z');
  });
});
