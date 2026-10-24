import { describe, expect, it } from 'vitest';
import {
  SCHEDULE_FREEZE_MS,
  scheduleAction,
  scheduleBody,
  slotFit,
  stretchTail,
} from './hardstart.ts';
import { type FeedEntry, planFeed } from './plan.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-10-21T10:00:00Z');

describe('slotFit', () => {
  it('cuts a flexible item to its log slot, and lets it play that much longer again', () => {
    // 120 s of bed, no overlap: a natural slot of 120.02 s, planned 80 s.
    expect(slotFit('fill', 80_000, 120_000, 0)).toEqual({ cutMs: 40_020, stretchMs: 40_020 });
    expect(slotFit('song', 150_000, 200_000, 4_000)).toEqual({
      cutMs: 46_020,
      stretchMs: 46_020,
    });
  });

  it('leaves whole items, rounding and non-flexible kinds alone', () => {
    expect(slotFit('song', 196_020, 200_000, 4_000)).toEqual({ cutMs: 0, stretchMs: 0 });
    expect(slotFit('song', 195_900, 200_000, 4_000)).toEqual({ cutMs: 0, stretchMs: 0 });
    expect(slotFit('song', 250_000, 200_000, 0)).toEqual({ cutMs: 0, stretchMs: 0 });
    expect(slotFit('episode', 60_000, 3_600_000, 0)).toEqual({ cutMs: 0, stretchMs: 0 });
    expect(slotFit('jingle', 1_000, 8_000, 0)).toEqual({ cutMs: 0, stretchMs: 0 });
    expect(slotFit('fill', 1_000, null, 0)).toEqual({ cutMs: 0, stretchMs: 0 });
  });
});

describe('stretchTail', () => {
  const w = (startMs: number, stretchMs: number, trimMs = 0) => ({
    startMs,
    trimMs,
    entry: { stretchMs },
  });

  it('lengthens the last entries first and moves what follows', () => {
    const wanted = [w(0, 50_000), w(100, 10_000), w(200, 5_000)];
    expect(stretchTail(wanted, 1, 12_000)).toBe(12_000);
    expect(wanted.map((x) => x.trimMs)).toEqual([0, -7_000, -5_000]);
    expect(wanted[2]?.startMs).toBe(200 + 7_000);
  });

  it('stops at the tail start and at what the media allows', () => {
    const wanted = [w(0, 50_000), w(100, 2_000, 1_000)];
    // A trimmed entry gives back its trim, then its stretch.
    expect(stretchTail(wanted, 1, 10_000)).toBe(3_000);
    expect(wanted.map((x) => x.trimMs)).toEqual([0, -2_000]);
  });
});

describe('scheduleAction', () => {
  const wanted = { itemId: 'ep', atMs: T0, fingerprint: 'f1' };
  const now = T0 - 10 * MIN;

  it('schedules what the engine does not hold', () => {
    expect(scheduleAction({ nowMs: now, engine: null, wanted, sent: null, stillHard: false })).toBe(
      'schedule',
    );
    expect(
      scheduleAction({
        nowMs: now,
        engine: { itemId: 'other', atMs: T0 },
        wanted,
        sent: 'f0',
        stillHard: true,
      }),
    ).toBe('schedule');
  });

  it('keeps what it sent, and re-sends a changed body or time', () => {
    const engine = { itemId: 'ep', atMs: T0 };
    expect(scheduleAction({ nowMs: now, engine, wanted, sent: 'f1', stillHard: true })).toBe(
      'none',
    );
    expect(scheduleAction({ nowMs: now, engine, wanted, sent: 'f0', stillHard: true })).toBe(
      'schedule',
    );
    expect(
      scheduleAction({
        nowMs: now,
        engine: { itemId: 'ep', atMs: T0 + 1_000 },
        wanted,
        sent: 'f1',
        stillHard: true,
      }),
    ).toBe('schedule');
  });

  it('re-sends after a handover, but not in the last seconds', () => {
    const engine = { itemId: 'ep', atMs: T0 };
    expect(scheduleAction({ nowMs: now, engine, wanted, sent: null, stillHard: true })).toBe(
      'schedule',
    );
    expect(
      scheduleAction({
        nowMs: T0 - SCHEDULE_FREEZE_MS + 1,
        engine,
        wanted,
        sent: null,
        stillHard: true,
      }),
    ).toBe('none');
  });

  it('cancels an item the log no longer starts hard', () => {
    const engine = { itemId: 'ep', atMs: T0 };
    expect(scheduleAction({ nowMs: now, engine, wanted: null, sent: 'f1', stillHard: false })).toBe(
      'unschedule',
    );
    expect(scheduleAction({ nowMs: now, engine, wanted: null, sent: 'f1', stillHard: true })).toBe(
      'none',
    );
  });
});

describe('scheduleBody', () => {
  it('carries the push fields and the cut', () => {
    expect(
      scheduleBody(
        {
          item_id: 'ep',
          uri: '/cache/ep.flac',
          cue_in: 0.5,
          amplify_db: -2,
          title: 'Episode',
          fade_out: 3,
          cross_in: 2,
        },
        T0,
        1,
      ),
    ).toEqual({
      item_id: 'ep',
      uri: '/cache/ep.flac',
      at: T0 / 1000,
      cue_in: 0.5,
      amplify_db: -2,
      title: 'Episode',
      fade_out: 1,
    });
  });
});

describe('planFeed: hard starts', () => {
  const entry = (id: string, startMs: number, extra: Partial<FeedEntry> = {}): FeedEntry => ({
    id,
    kind: 'song',
    plannedStartMs: startMs,
    slotMs: 3 * MIN,
    timing: 'flow',
    anchorAtMs: null,
    capMs: null,
    parts: [],
    unplayable: null,
    flexMs: 0,
    ...extra,
  });
  const anchor = T0 + 9 * MIN;
  const log = [
    entry('a', T0),
    entry('b', T0 + 3 * MIN),
    entry('fill', T0 + 6 * MIN, { kind: 'fill', flexMs: 2 * MIN, stretchMs: 30_000 }),
    entry('ep', anchor, { kind: 'episode', timing: 'hard', anchorAtMs: anchor, slotMs: 60 * MIN }),
    entry('after', anchor + 60 * MIN),
  ];
  const onAir = (elapsedMs: number) => ({
    itemId: 'a',
    segmentId: null,
    source: 'queue' as const,
    elapsedMs,
  });

  it('stretches the fill when the music runs early', () => {
    // `a` started 10 s early: the tail ends 10 s before the anchor.
    const plan = planFeed({ nowMs: T0 + MIN, onAir: onAir(MIN + 10_000), entries: log });
    const fill = plan.wanted.find((w) => w.entry.id === 'fill');
    expect(fill?.trimMs).toBe(-10_000);
    expect(plan.late).toEqual([]);
  });

  it('hands the hard item to the engine and stops there', () => {
    const plan = planFeed({
      nowMs: T0 + MIN,
      onAir: onAir(MIN),
      entries: log,
      options: { engineCut: true, cutOverlapMs: 500 },
    });
    expect(plan.scheduled).toEqual({ entry: log[3], atMs: anchor });
    expect(plan.wanted.map((w) => w.entry.id)).toEqual(['b', 'fill']);
    // The tail aims half a second past the anchor: the engine fades it out under the item.
    expect(plan.wanted.at(-1)?.trimMs).toBe(-500);
  });

  it('cuts the tail, without reporting late, when the engine cuts', () => {
    const plan = planFeed({
      nowMs: T0 + MIN,
      onAir: onAir(MIN - 5 * MIN),
      entries: log,
      options: { engineCut: true },
    });
    expect(plan.scheduled?.entry.id).toBe('ep');
    expect(plan.late).toEqual([]);
  });

  it('still schedules the hard item when the tail can not reach it', () => {
    const plan = planFeed({
      nowMs: T0 + MIN,
      onAir: onAir(MIN + 2 * MIN),
      entries: log,
      options: { engineCut: true },
    });
    expect(plan.scheduled?.entry.id).toBe('ep');
    expect(plan.hold).toBeNull();
  });
});

describe('planFeed: soft starts and the tail (#46 review)', () => {
  const entry = (id: string, startMs: number, extra: Partial<FeedEntry> = {}): FeedEntry => ({
    id,
    kind: 'song',
    plannedStartMs: startMs,
    slotMs: 3 * MIN,
    timing: 'flow',
    anchorAtMs: null,
    capMs: null,
    parts: [],
    unplayable: null,
    flexMs: 2 * MIN,
    ...extra,
  });
  const anchor = T0 + 9 * MIN;
  const soft = (extra: Partial<FeedEntry> = {}) =>
    entry('ep', anchor, {
      kind: 'episode',
      timing: 'soft',
      anchorAtMs: anchor,
      capMs: 30_000,
      slotMs: 60 * MIN,
      flexMs: 0,
      ...extra,
    });
  const onAir = (itemId: string, elapsedMs: number) => ({
    itemId,
    segmentId: null,
    source: 'queue' as const,
    elapsedMs,
  });

  it('holds a soft item the music would reach early, until its anchor', () => {
    // `a` started 3 min late in the plan's terms: the tail ends a minute before the anchor
    // (nothing to stretch), so the soft item waits.
    const log = [entry('a', T0), entry('b', T0 + 3 * MIN, { slotMs: 2 * MIN }), soft()];
    const plan = planFeed({ nowMs: T0 + MIN, onAir: onAir('a', MIN), entries: log });
    expect(plan.wanted.map((w) => w.entry.id)).toEqual(['b']);
    expect(plan.hold).toEqual({ itemId: 'ep', untilMs: anchor - 500 });
  });

  it('cuts the last song to the cap rather than dropping it', () => {
    // The tail ends 60 s past the anchor, 30 s past the cap: `b` is cut by 30 s.
    const log = [entry('a', T0), entry('b', T0 + 3 * MIN, { slotMs: 7 * MIN }), soft()];
    const plan = planFeed({ nowMs: T0 + MIN, onAir: onAir('a', MIN), entries: log });
    expect(plan.wanted.map((w) => [w.entry.id, w.trimMs])).toEqual([
      ['b', 30_000],
      ['ep', 0],
    ]);
    expect(plan.late).toEqual([]);
  });

  it('has the engine cut an item on air past the cap', () => {
    // `a` (not flexible) runs 2 min past the anchor: nothing queued can absorb it.
    const log = [entry('a', T0, { slotMs: 11 * MIN, flexMs: 0 }), soft()];
    const cut = planFeed({
      nowMs: T0 + MIN,
      onAir: onAir('a', MIN),
      entries: log,
      options: { engineCut: true },
    });
    expect(cut.scheduled).toEqual({ entry: log[1], atMs: anchor + 30_000 });
    const without = planFeed({ nowMs: T0 + MIN, onAir: onAir('a', MIN), entries: log });
    expect(without.scheduled).toBeNull();
    expect(without.late).toEqual([{ itemId: 'ep', ms: 90_000 }]);
  });

  it('keeps a voice track when the song before it can give the time', () => {
    const hard = entry('ep', anchor, {
      kind: 'episode',
      timing: 'hard',
      anchorAtMs: anchor,
      slotMs: 60 * MIN,
      flexMs: 0,
    });
    // b (song) then a 20 s VT end 20 s past the anchor.
    const log = [
      entry('a', T0),
      entry('b', T0 + 3 * MIN, { slotMs: 6 * MIN }),
      entry('vt', T0 + 9 * MIN, { kind: 'vt', slotMs: 20_000, flexMs: 0 }),
      hard,
    ];
    const plan = planFeed({ nowMs: T0 + MIN, onAir: onAir('a', MIN), entries: log });
    expect(plan.wanted.map((w) => [w.entry.id, w.trimMs])).toEqual([
      ['b', 20_000],
      ['vt', 0],
      ['ep', 0],
    ]);
  });

  it('absorbs an overrun in the tail since the previous anchor only', () => {
    const marker = T0 + 6 * MIN;
    const hard = entry('ep', anchor, {
      kind: 'episode',
      timing: 'hard',
      anchorAtMs: anchor,
      slotMs: 60 * MIN,
      flexMs: 0,
    });
    // A song before the marker: the overrun after the marker can't cut it (it would only move
    // the marker's start), and the VT, longer than the overrun, stays: the rest is late.
    const log = [
      entry('a', T0),
      entry('s0', T0 + 3 * MIN),
      entry('m', marker, { kind: 'marker', timing: 'soft', anchorAtMs: marker, slotMs: 0 }),
      entry('vt', marker, { kind: 'vt', slotMs: 4 * MIN, flexMs: 0 }),
      hard,
    ];
    const plan = planFeed({ nowMs: T0 + MIN, onAir: onAir('a', MIN), entries: log });
    expect(plan.wanted.map((w) => [w.entry.id, w.trimMs])).toEqual([
      ['s0', 0],
      ['vt', 0],
      ['ep', 0],
    ]);
    expect(plan.late).toEqual([{ itemId: 'ep', ms: MIN }]);
  });
});

describe('scheduleAction: the last seconds', () => {
  it('leaves the engine copy alone close to its time, even when the body changed', () => {
    expect(
      scheduleAction({
        nowMs: T0 - SCHEDULE_FREEZE_MS + 1,
        engine: { itemId: 'ep', atMs: T0 },
        wanted: { itemId: 'ep', atMs: T0, fingerprint: 'f2' },
        sent: 'f1',
        stillHard: true,
      }),
    ).toBe('none');
  });
});
