import type { AssetCues } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import {
  asRunByItem,
  ENGINE_WINDOW_MS,
  groupByHour,
  itemState,
  onAirItem,
  showBlocks,
  slotMs,
  transitionPlan,
} from './model.ts';
import { asRunEntry, id, logItem } from './testing.ts';
import { dayBounds, dayHours, formatClock, formatDuration, formatSigned } from './time.ts';

// The timeline's pure rules: station-local hours across DST, hour totals and warnings,
// what's on air, what's frozen, show blocks, slot sizing and the transition preview's timing.

const PARIS = 'Europe/Paris';
describe('station-local hours', () => {
  it('has 24 hours on a plain day, labelled in station time', () => {
    const hours = dayHours('2026-10-21', PARIS);
    expect(hours).toHaveLength(24);
    expect(hours[0]?.label).toBe('00:00');
    // Paris is UTC+2 in October before the change.
    expect(new Date(hours[0]?.start ?? 0).toISOString()).toBe('2026-10-20T22:00:00.000Z');
    expect(hours[14]?.label).toBe('14:00');
  });

  it('has 23 hours on the last Sunday of March (02:00 does not exist)', () => {
    const hours = dayHours('2026-03-29', PARIS);
    expect(hours).toHaveLength(23);
    expect(hours.map((h) => h.label).slice(0, 4)).toEqual(['00:00', '01:00', '03:00', '04:00']);
  });

  it('has 25 hours on the last Sunday of October, with 02:00 twice told apart', () => {
    const hours = dayHours('2026-10-25', PARIS);
    expect(hours).toHaveLength(25);
    expect(hours.map((h) => h.label).slice(1, 5)).toEqual([
      '01:00',
      '02:00 UTC+2',
      '02:00 UTC+1',
      '03:00',
    ]);
    const { start, end } = dayBounds('2026-10-25', PARIS);
    expect(end - start).toBe(25 * 3_600_000);
  });

  it('formats clocks, durations and drifts', () => {
    expect(formatClock('2026-10-21T12:05:09.400Z', PARIS)).toBe('14:05:09');
    expect(formatClock('2026-10-21T12:05:09.400Z', PARIS, false)).toBe('14:05');
    expect(formatDuration(214_000)).toBe('3:34');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatSigned(3_200)).toBe('+3 s');
    expect(formatSigned(-80_000)).toBe('-1:20');
  });
});

describe('groupByHour', () => {
  it('puts items in the hour they start in, with totals and conflicts', () => {
    const hours = dayHours('2026-10-25', PARIS);
    // The second 02:00 (UTC+1) starts at 01:00Z.
    const a = logItem({ plannedStart: '2026-10-25T00:30:00.000Z', plannedDurationMs: 60_000 });
    const b = logItem({
      plannedStart: '2026-10-25T01:00:00.000Z',
      plannedDurationMs: 90_000,
      timing: 'soft',
      anchorAt: '2026-10-25T01:00:00.000Z',
      conflict: { kind: 'overrun', ms: 4_000 },
      relaxedRules: [{ rule: 'artist_separation' }],
    });
    const c = logItem({
      plannedStart: '2026-10-25T01:20:00.000Z',
      plannedDurationMs: 30_000,
      conflict: { kind: 'gap', ms: 2_000 },
    });
    const groups = groupByHour([a, b, c], hours);
    const first = groups[2];
    const second = groups[3];
    expect(first?.label).toBe('02:00 UTC+2');
    expect(first?.items).toEqual([a]);
    expect(second?.items).toEqual([b, c]);
    expect(second).toMatchObject({
      contentMs: 120_000,
      overrunMs: 4_000,
      gapMs: 2_000,
      relaxed: 1,
    });
  });
});

describe('on air and frozen items', () => {
  const a = logItem({ plannedStart: '2026-10-21T10:00:00.000Z', plannedDurationMs: 200_000 });
  const b = logItem({ plannedStart: '2026-10-21T10:03:20.000Z', plannedDurationMs: 200_000 });
  const later = logItem({ plannedStart: '2026-10-21T11:00:00.000Z' });
  const now = Date.parse('2026-10-21T10:01:00.000Z');

  it('prefers the open as-run entry over the plan', () => {
    const entry = asRunEntry({ logItemId: b.id });
    expect(onAirItem([a, b], [entry], now)).toMatchObject({ itemId: b.id, source: 'asrun' });
    expect(onAirItem([a, b], [], now)).toMatchObject({ itemId: a.id, source: 'plan' });
    // Safety on air: no log item is.
    expect(onAirItem([a, b], [asRunEntry({ source: 'safety' })], now)).toBeNull();
  });

  it('highlights the island, not its part', () => {
    const segmentId = id();
    const entry = asRunEntry({ logItemId: id(), segmentId });
    expect(onAirItem([], [entry], now)?.itemId).toBe(segmentId);
    expect(asRunByItem([entry]).get(segmentId)).toBe(entry);
  });

  it('freezes aired and on-air items, flags the engine window', () => {
    const aired = asRunByItem([asRunEntry({ logItemId: a.id, endedAt: '2026-10-21T10:03:20Z' })]);
    const ctx = { now, onAirId: b.id, aired };
    expect(itemState(a, ctx)).toBe('aired');
    expect(itemState(b, ctx)).toBe('on_air');
    const soon = logItem({ plannedStart: new Date(now + ENGINE_WINDOW_MS - 1).toISOString() });
    expect(itemState(soon, ctx)).toBe('queued');
    expect(itemState(later, ctx)).toBe('planned');
    // Planned in the past without as-run (nothing aired it): read-only too.
    const past = Date.parse('2026-10-21T10:05:00.000Z');
    expect(itemState(a, { now: past, onAirId: null, aired: new Map() })).toBe('aired');
  });
});

describe('showBlocks', () => {
  it('groups consecutive items of a show slot', () => {
    const slot = id();
    const show = { type: 'show' as const, showSlotId: slot };
    const items = [logItem(), logItem({ origin: show }), logItem({ origin: show }), logItem()];
    const blocks = showBlocks(items);
    expect(blocks.get(items[1]?.id ?? '')).toEqual({ showSlotId: slot, first: true, last: false });
    expect(blocks.get(items[2]?.id ?? '')).toEqual({ showSlotId: slot, first: false, last: true });
    expect(blocks.has(items[0]?.id ?? '')).toBe(false);
  });
});

const cues = (c: { cueIn?: number; cueOut?: number; crossStartNext?: number }): AssetCues => {
  const point = (samples: number | undefined) => ({
    samples: samples ?? null,
    source: 'auto' as const,
    locked: false,
  });
  return {
    assetId: id(),
    sampleRate: 44_100,
    analyzerVersion: null,
    cueIn: point(c.cueIn),
    cueOut: point(c.cueOut),
    introEnd: point(undefined),
    outroStart: point(undefined),
    fadeIn: point(undefined),
    fadeOut: point(undefined),
    crossStartNext: point(c.crossStartNext),
    updatedAt: new Date(),
  };
};

describe('slots and transitions', () => {
  it('sizes a slot from the cues, else the duration, plus the engine frame', () => {
    expect(slotMs(180_000, null)).toBe(180_020);
    expect(slotMs(180_000, cues({ cueIn: 44_100, cueOut: 44_100 * 171 }))).toBe(170_020);
    expect(
      slotMs(180_000, cues({ cueIn: 44_100, cueOut: 44_100 * 171, crossStartNext: 44_100 * 166 })),
    ).toBe(165_020);
  });

  it('plays the outgoing item up to where the plan starts the next one', () => {
    const a = logItem({ plannedDurationMs: 165_020 });
    const b = logItem();
    const plan = transitionPlan(a, cues({ cueIn: 44_100 }), b, cues({ cueIn: 22_050 }));
    // a starts at its cue-in (1 s); b starts 165 s later, at a's 166 s.
    expect(plan).toEqual({ fromS: 158, switchS: 166, intoS: 0.5 });
    // An item override wins over the asset's cue.
    const override = logItem({ cueOverrides: { sampleRate: 48_000, cueIn: 96_000 } });
    expect(transitionPlan(a, null, override, cues({ cueIn: 22_050 })).intoS).toBe(2);
  });
});
