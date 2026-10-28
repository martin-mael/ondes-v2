import { markerTargetOf } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import {
  markerAnchor,
  markerBlocked,
  markerInput,
  markerOutcome,
  markerPlacement,
  markerTarget,
  parseMinSec,
  wontPush,
} from './markers.ts';
import { logItem, playable } from './testing.ts';
import { dayHours } from './time.ts';
import type { PassedOver } from './use-live.ts';

// The timeline's marker helpers (#52): which item a marker times, how it aired, where a new
// marker goes, and its time from a real hour of the day (DST included).

const T = '2026-10-21T11:00:00.000Z';
const marker = (timing: 'hard' | 'soft' | 'not_before', capMs: number | null = null) =>
  logItem({ kind: 'marker', title: 'Top', timing, anchorAt: T, capMs, plannedStart: T });

describe('markerTarget', () => {
  it('is the next pushed item, unless something anchored or a live slot comes first', () => {
    const m = marker('hard');
    const jingle = playable({ kind: 'jingle', title: 'ID', plannedStart: T });
    expect(markerTarget([m, jingle], 0)).toEqual({ item: jingle });
    expect(markerTarget([m, logItem({ kind: 'live_slot' }), jingle], 0)).toEqual({
      none: 'live_slot',
    });
    expect(markerTarget([m, marker('soft'), jingle], 0)).toEqual({ none: 'marker' });
    const show = playable({ kind: 'episode', title: 'Show', timing: 'hard', anchorAt: T });
    expect(markerTarget([m, show], 0)).toEqual({ none: 'anchored' });
    expect(markerTarget([m], 0)).toEqual({ none: 'end' });
    expect(markerTarget([jingle, m], 0)).toBeNull();
  });

  it("passes over what the feeder won't push, as the feeder does", () => {
    const m = marker('hard');
    const missing = logItem({ kind: 'jingle', title: 'No file' });
    const passed = playable({ kind: 'jingle', title: 'Not cached' });
    const dropped = playable({ kind: 'song', title: 'Dropped' });
    const jingle = playable({ kind: 'jingle', title: 'ID' });
    const reasons = new Map<string, PassedOver>([
      [passed.id, { itemId: passed.id, reason: 'not_cached' } as PassedOver],
      [dropped.id, { itemId: dropped.id, reason: 'dropped' } as PassedOver],
    ]);
    const items = [m, missing, passed, jingle];
    expect(markerTarget(items, 0, (id) => reasons.get(id))).toEqual({ item: jingle });
    // Dropped to meet an anchor: it could play, so the marker times it.
    expect(markerTarget([m, dropped, jingle], 0, (id) => reasons.get(id))).toEqual({
      item: dropped,
    });
    // The same entries through the feeder's rule.
    const entries = items.map((i) => ({
      ...i,
      unplayable: i === missing || i === passed,
    }));
    expect(markerTargetOf(entries, 0, (e) => e.unplayable)).toEqual({ index: 3 });
  });

  it('a segment needs a file for every part', () => {
    const part = (title: string) => playable({ title });
    expect(wontPush(logItem({ kind: 'segment', parts: [part('a'), part('b')] }))).toBe(false);
    expect(wontPush(logItem({ kind: 'segment', parts: [part('a'), logItem()] }))).toBe(true);
  });
});

describe('markerBlocked', () => {
  const at = (s: number) => new Date(Date.parse(T) + s * 1000).toISOString();
  const other = marker('soft');
  const jingle = playable({ kind: 'jingle', title: 'ID', plannedStart: at(0) });
  const song = playable({ title: 'Song', plannedStart: at(10) });
  const items = [other, jingle, song];

  it('warns when the new marker would go right before another marker or a live slot', () => {
    expect(markerBlocked(items, Date.parse(at(0)))).toBe('marker');
    expect(markerBlocked(items, Date.parse(at(5)))).toBeNull();
    const live = logItem({ kind: 'live_slot', plannedStart: at(30) });
    expect(markerBlocked([...items, live], Date.parse(at(20)))).toBe('live_slot');
    // At the end of the day: nothing after it, but nothing to warn about.
    expect(markerBlocked(items, Date.parse(at(600)))).toBeNull();
  });

  it('leaves the marker being edited out', () => {
    expect(markerBlocked(items, Date.parse(at(0)), other)).toBeNull();
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
