import { resolveMarkers } from '@ondes/scheduling';
import { describe, expect, it } from 'vitest';
import { type FeedEntry, type PlanInput, planFeed } from './plan.ts';

// Fixed-time markers in the planner (#52, ADR 0036): the feeder resolves each marker onto the
// item after it (`resolveMarkers`), then plans as for any anchored item. The engine side is
// engine/tests/markers.

const MIN = 60_000;
const T0 = Date.parse('2026-10-21T10:00:00Z');

function entry(id: string, plannedStartMs: number, extra: Partial<FeedEntry> = {}): FeedEntry {
  const slotMs = extra.slotMs ?? 3 * MIN;
  return {
    id,
    kind: 'song',
    plannedStartMs,
    slotMs,
    timing: 'flow',
    anchorAtMs: null,
    capMs: null,
    parts: [],
    unplayable: null,
    flexMs: Math.max(0, slotMs - 30_000),
    ...extra,
  };
}
const marker = (at: number, timing: FeedEntry['timing'], capMs: number | null = null) =>
  entry('marker', at, { kind: 'marker', slotMs: 0, flexMs: 0, timing, anchorAtMs: at, capMs });
const jingle = (at: number) => entry('j', at, { kind: 'jingle', slotMs: 5_000, flexMs: 0 });
const songs = (n: number, slotMs = 3 * MIN) =>
  Array.from({ length: n }, (_, i) => entry(`s${i}`, T0 + i * slotMs, { slotMs }));
const onAir = (itemId: string, elapsedMs: number) => ({
  itemId,
  segmentId: null,
  source: 'queue' as const,
  elapsedMs,
});

/** What the feeder plans: markers resolved first. */
const plan = (input: Omit<PlanInput, 'entries'> & { entries: FeedEntry[] }) =>
  planFeed({ ...input, entries: resolveMarkers(input.entries) });
const ids = (p: ReturnType<typeof planFeed>) => p.wanted.map((w) => w.entry.id);

describe('hard markers', () => {
  const at = T0 + 9 * MIN;
  const entries = [...songs(3), marker(at, 'hard'), jingle(at), entry('after', at + 5_000)];

  it("the engine starts the marker's item at T: the music before is planned to reach it", () => {
    const p = plan({ nowMs: T0, onAir: onAir('s0', 0), entries, options: { engineCut: true } });
    expect(p.scheduled).toMatchObject({ entry: { id: 'j', timing: 'hard' }, atMs: at });
    // Nothing after it is queued before it airs.
    expect(ids(p)).toEqual(['s1', 's2']);
    expect(p.late).toEqual([]);
  });

  it('a late hour is cut down to T, the engine fades out the rest', () => {
    // s0 went on air 40 s late: s2 is trimmed (aiming half a second past T).
    const p = plan({
      nowMs: T0 + MIN,
      onAir: onAir('s0', 20_000),
      entries,
      options: { engineCut: true },
    });
    expect(p.wanted.at(-1)).toMatchObject({ entry: { id: 's2' }, trimMs: 39_500 });
    expect(p.scheduled?.atMs).toBe(at);
  });

  it('without the engine cut, the item is queued and what the tail cannot absorb is late', () => {
    const long = [entry('s0', T0, { slotMs: 20 * MIN }), marker(at, 'hard'), jingle(at)];
    const p = plan({ nowMs: T0, onAir: onAir('s0', 0), entries: long });
    expect(p.scheduled).toBeNull();
    expect(p.late).toEqual([{ itemId: 'j', ms: 11 * MIN }]);
    expect(ids(p)).toEqual(['j']);
  });
});

describe('soft markers', () => {
  it('the item on air ends first; the queued items after T are skipped', () => {
    const at = T0 + 5 * MIN;
    const entries = [...songs(3), marker(at, 'soft', 3 * MIN), jingle(at)];
    const p = plan({ nowMs: T0, onAir: onAir('s0', 0), entries, options: { engineCut: true } });
    // s1 (10:03–10:06) plays to its end; s2 would start after 10:05: skipped.
    expect(ids(p)).toEqual(['s1', 'j']);
    expect(p.wanted[1]?.startMs).toBe(T0 + 6 * MIN);
    expect(p.skipped).toEqual([
      { entry: expect.objectContaining({ id: 's2' }), reason: 'dropped' },
    ]);
    expect(p.scheduled).toBeNull();
  });

  it('past the cap, the engine cuts the item on air at T + cap', () => {
    const at = T0 + 5 * MIN;
    const entries = [
      entry('long', T0, { slotMs: 20 * MIN }),
      marker(at, 'soft', 30_000),
      jingle(at),
    ];
    const cut = plan({ nowMs: T0, onAir: onAir('long', 0), entries, options: { engineCut: true } });
    expect(cut.scheduled).toMatchObject({ entry: { id: 'j', timing: 'soft' }, atMs: at + 30_000 });
    const replan = plan({ nowMs: T0, onAir: onAir('long', 0), entries });
    expect(replan.scheduled).toBeNull();
    expect(replan.late).toEqual([{ itemId: 'j', ms: 15 * MIN - 30_000 }]);
  });
});

describe('not-before markers', () => {
  const at = T0 + 6 * MIN + 30_000;

  it('the music before stretches to T, aiming half a second past it', () => {
    // s1 was cut by a minute in the log (back-timing): it gives 30.5 s back.
    const entries = [
      entry('s0', T0),
      entry('s1', T0 + 3 * MIN, { stretchMs: MIN }),
      marker(at, 'not_before'),
      jingle(at),
    ];
    const p = plan({ nowMs: T0, onAir: onAir('s0', 0), entries });
    expect(p.wanted.map((w) => [w.entry.id, w.startMs, w.trimMs])).toEqual([
      ['s1', T0 + 3 * MIN, -30_500],
      ['j', at + 500, 0],
    ]);
    expect(p.hold).toBeNull();
  });

  it('never starts early: even a small gap waits, then the item goes at T', () => {
    const entries = [...songs(2), marker(T0 + 6 * MIN + 2_000, 'not_before'), jingle(at)];
    const early = plan({ nowMs: T0, onAir: onAir('s0', 0), entries });
    expect(early.hold).toEqual({ itemId: 'j', untilMs: T0 + 6 * MIN + 2_000 });
    expect(ids(early)).toEqual(['s1']);
    expect(plan({ nowMs: T0 + 6 * MIN + 1_900, onAir: null, entries }).hold?.itemId).toBe('j');
    const due = plan({ nowMs: T0 + 6 * MIN + 2_000, onAir: null, entries });
    expect(due.wanted[0]).toMatchObject({ entry: { id: 'j' }, startMs: T0 + 6 * MIN + 2_000 });
  });

  it('holds even for a gap within the tolerance: never a few ms early', () => {
    const entries = [...songs(2), marker(T0 + 6 * MIN + 10, 'not_before'), jingle(at)];
    const p = plan({ nowMs: T0, onAir: onAir('s0', 0), entries });
    expect(p.hold).toEqual({ itemId: 'j', untilMs: T0 + 6 * MIN + 10 });
  });

  it('late is fine: nothing is cut or skipped', () => {
    const entries = [...songs(3), marker(T0 + 5 * MIN, 'not_before'), jingle(T0 + 5 * MIN)];
    const p = plan({ nowMs: T0, onAir: onAir('s0', 0), entries, options: { engineCut: true } });
    expect(ids(p)).toEqual(['s1', 's2', 'j']);
    expect(p.wanted.every((w) => w.trimMs === 0)).toBe(true);
    expect([p.skipped, p.late, p.scheduled]).toEqual([[], [], null]);
  });
});

describe('markers that time nothing', () => {
  it('a marker before a live slot stays a timing point the planner holds at', () => {
    const at = T0 + 10 * MIN;
    const entries = [
      ...songs(2),
      marker(at, 'not_before'),
      entry('live', at, { kind: 'live_slot', slotMs: 30 * MIN, flexMs: 0 }),
      entry('after', at + 30 * MIN),
    ];
    const p = plan({ nowMs: T0, onAir: onAir('s0', 0), entries });
    expect(p.hold).toEqual({ itemId: 'marker', untilMs: at });
  });

  it("a show at the marker's time keeps its own policy", () => {
    const at = T0 + 9 * MIN;
    const entries = [
      ...songs(3),
      marker(at, 'soft', 30_000),
      entry('ep', at, { kind: 'episode', timing: 'hard', anchorAtMs: at, slotMs: 30 * MIN }),
    ];
    const p = plan({ nowMs: T0, onAir: onAir('s0', 0), entries, options: { engineCut: true } });
    expect(p.scheduled).toMatchObject({ entry: { id: 'ep', timing: 'hard' }, atMs: at });
  });
});
