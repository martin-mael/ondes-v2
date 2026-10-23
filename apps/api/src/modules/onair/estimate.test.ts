import type { LogItem } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { estimateNext } from './estimate.ts';

const T0 = Date.parse('2026-10-25T08:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
let n = 0;

function item(startMs: number, durationMs: number, extra: Partial<LogItem> = {}): LogItem {
  n += 1;
  return {
    id: `01a15ddf-0000-7000-8000-${String(n).padStart(12, '0')}`,
    logDayId: '01a15ddf-0000-7000-8000-00000000d001',
    position: n,
    kind: 'song',
    plannedStart: iso(T0 + startMs),
    plannedDurationMs: durationMs,
    assetId: null,
    asset: {
      id: '01a15ddf-0000-7000-8000-00000000a001',
      type: 'song',
      title: `Song ${n}`,
      artists: ['Artist'],
      durationMs,
    },
    episodeId: null,
    liveSlotId: null,
    title: null,
    cueOverrides: null,
    timing: 'flow',
    anchorAt: null,
    capMs: null,
    origin: { type: 'manual' },
    locked: false,
    relaxedRules: [],
    segmentId: null,
    conflict: null,
    parts: [],
    ...extra,
  };
}

const starts = (r: ReturnType<typeof estimateNext>) => r.next.map((i) => i.estimatedStart);

describe('estimateNext', () => {
  it('moves the next items by the drift of the item on air', () => {
    const log = [item(0, 180_000), item(180_000, 200_000), item(380_000, 60_000)];
    const [a] = log;
    // A went on air 4 s late; it is 30 s in.
    const r = estimateNext(
      log,
      { logItemId: a?.id ?? null, segmentId: null, startedAt: T0 + 4_000 },
      T0 + 34_000,
      5,
    );
    expect(starts(r)).toEqual([iso(T0 + 184_000), iso(T0 + 384_000)]);
  });

  it('pushes the next items while the item on air overruns its plan', () => {
    const log = [item(0, 180_000), item(180_000, 200_000)];
    const now = T0 + 190_000;
    const r = estimateNext(
      log,
      { logItemId: log[0]?.id ?? null, segmentId: null, startedAt: T0 },
      now,
      5,
    );
    expect(starts(r)).toEqual([iso(now)]);
  });

  it('starts a hard item at its anchor and reports it as the next hard event', () => {
    const anchor = T0 + 360_000;
    const log = [
      item(0, 180_000),
      item(180_000, 200_000),
      item(360_000, 60_000, { timing: 'hard', anchorAt: iso(anchor), title: 'News' }),
      item(420_000, 60_000),
    ];
    const r = estimateNext(
      log,
      { logItemId: log[0]?.id ?? null, segmentId: null, startedAt: T0 + 10_000 },
      T0 + 20_000,
      5,
    );
    expect(starts(r)).toEqual([iso(T0 + 190_000), iso(anchor), iso(T0 + 420_000)]);
    expect(r.hardEvent).toMatchObject({ kind: 'hard_start', at: iso(anchor), title: 'News' });
  });

  it('starts a not_before item no earlier than its anchor', () => {
    const anchor = T0 + 200_000;
    const log = [
      item(0, 180_000),
      item(200_000, 60_000, { timing: 'not_before', anchorAt: iso(anchor) }),
    ];
    const early = estimateNext(
      log,
      { logItemId: log[0]?.id ?? null, segmentId: null, startedAt: T0 - 5_000 },
      T0,
      5,
    );
    expect(starts(early)).toEqual([iso(anchor)]);
  });

  it('lists the parts after the one on air, then the items after the segment', () => {
    // An island chain: A's body, the island, B's body. A's body is on air.
    const body = item(0, 170_000);
    const island = item(170_000, 12_000, { kind: 'segment', title: 'Island' });
    const b = item(182_000, 200_000, { timing: 'flow', title: 'B' });
    const segment = item(0, 382_000, { kind: 'segment', parts: [body, island, b] });
    const after = item(382_000, 60_000, { kind: 'marker', title: 'Top' });
    const r = estimateNext(
      [segment, after],
      { logItemId: body.id, segmentId: segment.id, startedAt: T0 + 1_000 },
      T0 + 2_000,
      5,
    );
    expect(r.next.map((i) => i.title)).toEqual(['Island', 'B', 'Top']);
    expect(starts(r)).toEqual([iso(T0 + 171_000), iso(T0 + 183_000), iso(T0 + 383_000)]);
    expect(r.hardEvent).toMatchObject({ kind: 'marker', title: 'Top' });
  });

  it('labels a soft start as such', () => {
    const anchor = T0 + 200_000;
    const log = [
      item(0, 180_000),
      item(200_000, 60_000, { timing: 'soft', anchorAt: iso(anchor) }),
    ];
    const r = estimateNext(log, null, T0 - 1, 5);
    expect(r.hardEvent).toMatchObject({ kind: 'soft_start', at: iso(anchor) });
  });

  it('finds the item on air among a segment’s parts', () => {
    const part = item(0, 90_000, { segmentId: null });
    const segment = item(0, 180_000, { kind: 'segment', parts: [part] });
    const log = [segment, item(180_000, 60_000)];
    const r = estimateNext(
      log,
      { logItemId: part.id, segmentId: segment.id, startedAt: T0 + 2_000 },
      T0 + 3_000,
      5,
    );
    expect(starts(r)).toEqual([iso(T0 + 182_000)]);
  });

  it('follows the plan from now when the air is off the log', () => {
    const log = [item(0, 180_000), item(180_000, 200_000), item(380_000, 60_000)];
    const r = estimateNext(log, null, T0 + 100_000, 5);
    expect(starts(r)).toEqual([iso(T0 + 180_000), iso(T0 + 380_000)]);
  });

  it('keeps at most `count` items but still finds a marker further on', () => {
    const log = [
      item(0, 60_000),
      item(60_000, 60_000),
      item(120_000, 60_000),
      item(180_000, 0, { kind: 'marker', title: 'Top of hour' }),
    ];
    const r = estimateNext(log, null, T0 - 1, 2);
    expect(r.next).toHaveLength(2);
    expect(r.hardEvent).toMatchObject({ kind: 'marker', at: iso(T0 + 180_000) });
  });
});
