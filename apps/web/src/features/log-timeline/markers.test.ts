import { describe, expect, it } from 'vitest';
import {
  markerAnchor,
  markerInput,
  markerOutcome,
  markerPlacement,
  markerTarget,
  parseMinSec,
} from './markers.ts';
import { logItem } from './testing.ts';
import { dayHours } from './time.ts';

// The timeline's marker helpers (#52): which item a marker times, how it aired, where a new
// marker goes, and its time from a real hour of the day (DST included).

const T = '2026-10-21T11:00:00.000Z';
const marker = (timing: 'hard' | 'soft' | 'not_before', capMs: number | null = null) =>
  logItem({ kind: 'marker', title: 'Top', timing, anchorAt: T, capMs, plannedStart: T });

describe('markerTarget', () => {
  it('is the next pushed item, unless something anchored or a live slot comes first', () => {
    const m = marker('hard');
    const jingle = logItem({ kind: 'jingle', plannedStart: T });
    expect(markerTarget([m, jingle], 0)).toBe(jingle);
    expect(markerTarget([m, logItem({ kind: 'live_slot' }), jingle], 0)).toBeNull();
    expect(markerTarget([m, marker('soft'), jingle], 0)).toBeNull();
    const show = logItem({ kind: 'episode', timing: 'hard', anchorAt: T });
    expect(markerTarget([m, show], 0)).toBeNull();
    expect(markerTarget([m], 0)).toBeNull();
    expect(markerTarget([jingle, m], 0)).toBeNull();
  });
});

describe('markerOutcome', () => {
  const at = (deltaMs: number) => ({
    startedAt: new Date(Date.parse(T) + deltaMs).toISOString(),
  });
  it('hard: on time within a second', () => {
    expect(markerOutcome(marker('hard'), at(400))).toEqual({ deltaMs: 400, met: true });
    expect(markerOutcome(marker('hard'), at(2_000))?.met).toBe(false);
    expect(markerOutcome(marker('hard'), at(-2_000))?.met).toBe(false);
  });
  it('soft: not early, at most its cap late', () => {
    expect(markerOutcome(marker('soft', 30_000), at(25_000))?.met).toBe(true);
    expect(markerOutcome(marker('soft', 30_000), at(35_000))?.met).toBe(false);
    expect(markerOutcome(marker('soft', 30_000), at(-3_000))?.met).toBe(false);
  });
  it('not before: never early, late is fine', () => {
    expect(markerOutcome(marker('not_before'), at(120_000))?.met).toBe(true);
    expect(markerOutcome(marker('not_before'), at(-3_000))?.met).toBe(false);
  });
  it('nothing until the item aired', () => {
    expect(markerOutcome(marker('hard'), undefined)).toBeNull();
  });
});

describe('markerPlacement', () => {
  const a = logItem({ plannedStart: '2026-10-21T10:55:00.000Z' });
  const b = logItem({ plannedStart: '2026-10-21T11:00:00.000Z' });
  const c = logItem({ plannedStart: '2026-10-21T11:03:00.000Z' });
  const at = Date.parse(T);
  it('goes before the first item at or after its time, else at the end', () => {
    expect(markerPlacement([a, b, c], at, '2026-10-21')).toEqual({ before: b.id });
    expect(markerPlacement([a], at, '2026-10-21')).toEqual({ after: a.id });
    expect(markerPlacement([], at, '2026-10-21')).toEqual({ localDate: '2026-10-21' });
  });
  it('an edited marker already in place stays; moved, it goes before its new item', () => {
    const m = marker('hard');
    expect(markerPlacement([a, m, b, c], at, '2026-10-21', m)).toBeNull();
    expect(markerPlacement([a, m, b, c], at + 60_000, '2026-10-21', m)).toEqual({ before: c.id });
  });
});

describe('the marker time', () => {
  it('parses minutes and seconds within the hour', () => {
    expect(parseMinSec('30:00')).toBe(1_800_000);
    expect(parseMinSec('5')).toBe(300_000);
    expect(parseMinSec('59:59')).toBe(3_599_000);
    expect(parseMinSec('60:00')).toBeNull();
    expect(parseMinSec('ab')).toBeNull();
  });

  it('uses the real hours of the 23-hour day (2026-03-29, Europe/Paris)', () => {
    const hours = dayHours('2026-03-29', 'Europe/Paris');
    expect(hours.map((h) => h.label).slice(0, 3)).toEqual(['00:00', '01:00', '03:00']);
    expect(new Date(markerAnchor(hours[2], '30:00') ?? 0).toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    );
  });

  it('tells the two 02:00 of the 25-hour day apart (2026-10-25, Europe/Paris)', () => {
    const hours = dayHours('2026-10-25', 'Europe/Paris');
    expect(hours).toHaveLength(25);
    expect([hours[2]?.label, hours[3]?.label]).toEqual(['02:00 UTC+2', '02:00 UTC+1']);
    expect(new Date(markerAnchor(hours[2], '30:00') ?? 0).toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
    expect(new Date(markerAnchor(hours[3], '30:00') ?? 0).toISOString()).toBe(
      '2026-10-25T01:30:00.000Z',
    );
  });

  it('builds the log input: no cap unless soft, an empty label is none', () => {
    const at = Date.parse(T);
    expect(markerInput({ anchorMs: at, timing: 'hard', capMs: 30_000, label: ' ' })).toEqual({
      kind: 'marker',
      plannedDurationMs: 0,
      title: null,
      timing: 'hard',
      anchorAt: T,
      capMs: null,
    });
    expect(
      markerInput({ anchorMs: at, timing: 'soft', capMs: 30_000, label: 'News' }),
    ).toMatchObject({ title: 'News', capMs: 30_000 });
  });
});
