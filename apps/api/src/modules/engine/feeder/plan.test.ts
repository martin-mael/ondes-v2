import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildFixtureDay, FIXTURE_LIBRARY, type FixtureAsset } from '../../log/fixture.ts';
import { localDayBounds } from '../../log/time.ts';
import { retime, type TimedItem } from '../../log/timing.ts';
import { diffQueue, type FeedEntry, planFeed, type QueuedEntry, type WantedEntry } from './plan.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-10-21T10:00:00Z');

/** Back-to-back 3-minute songs from `start`, flexible down to 30 s. */
function songs(n: number, start = T0, slotMs = 3 * MIN): FeedEntry[] {
  return Array.from({ length: n }, (_, i) => entry(`s${i}`, start + i * slotMs, { slotMs }));
}

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

const onAir = (itemId: string, elapsedMs: number, segmentId: string | null = null) => ({
  itemId,
  segmentId,
  source: 'queue' as const,
  elapsedMs,
});

const ids = (plan: ReturnType<typeof planFeed>, n = plan.need) =>
  plan.wanted.slice(0, n).map((w) => w.entry.id);

describe('planFeed: how far ahead', () => {
  it('keeps at least 2 items and 10 minutes queued past the item on air', () => {
    const plan = planFeed({ nowMs: T0 + MIN, onAir: onAir('s0', MIN), entries: songs(10) });
    // s0 ends at 10:03; 10 minutes ahead of 10:01 needs s1..s3 (ending 10:12).
    expect(ids(plan)).toEqual(['s1', 's2', 's3']);
    expect(plan.wanted[0]?.startMs).toBe(T0 + 3 * MIN);
    expect(plan.onAirEndMs).toBe(T0 + 3 * MIN);
  });

  it('keeps 2 items when they cover 10 minutes, and caps the count', () => {
    const long = songs(5, T0, 8 * MIN);
    expect(ids(planFeed({ nowMs: T0, onAir: onAir('s0', 0), entries: long }))).toEqual([
      's1',
      's2',
    ]);
    const jingles = songs(30, T0, 5_000);
    const plan = planFeed({ nowMs: T0, onAir: onAir('s0', 0), entries: jingles });
    expect(plan.need).toBe(8);
  });

  it('chains from the on-air item as it actually runs, not as planned', () => {
    // s0 went on air 40 s late: everything after it is predicted 40 s late.
    const plan = planFeed({ nowMs: T0 + 2 * MIN, onAir: onAir('s0', 80_000), entries: songs(6) });
    expect(plan.wanted[0]?.startMs).toBe(T0 + 3 * MIN + 40_000);
  });

  it('places a segment by its on-air part', () => {
    const seg = entry('seg', T0, {
      kind: 'segment',
      slotMs: 9 * MIN + 20,
      flexMs: 0,
      parts: [
        { id: 'p1', durationMs: 3 * MIN },
        { id: 'p2', durationMs: 3 * MIN },
        { id: 'p3', durationMs: 3 * MIN },
      ],
    });
    const after = entry('after', T0 + 9 * MIN + 20);
    const plan = planFeed({
      nowMs: T0 + 4 * MIN,
      onAir: onAir('p2', MIN, 'seg'),
      entries: [seg, after],
    });
    expect(plan.onAirIndex).toBe(0);
    expect(plan.wanted[0]).toMatchObject({ entry: { id: 'after' }, startMs: T0 + 9 * MIN + 20 });
  });
});

describe('planFeed: the log not on air', () => {
  it('starts with the current item if it started less than a minute ago', () => {
    const entries = songs(6);
    const plan = planFeed({ nowMs: T0 + 30_000, onAir: null, entries });
    expect(ids(plan, 1)).toEqual(['s0']);
    // It airs as soon as it's pushed.
    expect(plan.wanted[0]?.startMs).toBe(T0 + 30_000);
  });

  it('else waits for the planned end of the current item, keeping the log on time', () => {
    const entries = songs(6);
    const late = planFeed({ nowMs: T0 + 90_000, onAir: null, entries });
    expect(late.wanted).toEqual([]);
    expect(late.hold).toEqual({ itemId: 's1', untilMs: T0 + 3 * MIN - 500 });
    // Close to its end (within holdGapMs), the next item goes straight away.
    const close = planFeed({ nowMs: T0 + 3 * MIN - 3_000, onAir: null, entries });
    expect(close.wanted[0]).toMatchObject({ entry: { id: 's1' }, startMs: T0 + 3 * MIN - 3_000 });
  });

  it('never replays what aired during this boot', () => {
    const plan = planFeed({
      nowMs: T0 + 10_000,
      onAir: { itemId: null, segmentId: null, source: 'safety', elapsedMs: 5_000 },
      entries: songs(6),
      aired: new Set(['s0']),
    });
    expect(ids(plan, 1)).toEqual(['s1']);
  });

  it('is dry when the log has nothing ahead', () => {
    const plan = planFeed({ nowMs: T0 + 30 * MIN, onAir: null, entries: songs(3) });
    expect(plan.wanted).toEqual([]);
    expect(plan.need).toBe(0);
    expect(plan.hold).toBeNull();
  });
});

describe('planFeed: items it cannot play', () => {
  it('skips an uncached item and pushes the next cached one in its place', () => {
    const entries = songs(8);
    entries[2] = { ...(entries[2] as FeedEntry), unplayable: 'not_cached' };
    const plan = planFeed({ nowMs: T0, onAir: onAir('s0', 0), entries });
    expect(ids(plan)).toEqual(['s1', 's3', 's4']);
    expect(plan.wanted[1]?.startMs).toBe(T0 + 6 * MIN);
    expect(plan.skipped).toEqual([{ entry: entries[2], reason: 'not_cached' }]);
  });

  it('pushes nothing for markers and holds what follows a live slot until its end', () => {
    const entries = [
      entry('s0', T0),
      entry('m', T0 + 3 * MIN, { kind: 'marker', slotMs: 0, flexMs: 0 }),
      entry('live', T0 + 3 * MIN, { kind: 'live_slot', slotMs: 60 * MIN, flexMs: 0 }),
      entry('s1', T0 + 63 * MIN),
    ];
    const plan = planFeed({ nowMs: T0, onAir: onAir('s0', 0), entries });
    expect(plan.wanted).toEqual([]);
    expect(plan.hold).toEqual({ itemId: 's1', untilMs: T0 + 63 * MIN - 500 });
    const atEnd = planFeed({ nowMs: T0 + 63 * MIN - 400, onAir: null, entries });
    expect(ids(atEnd, 1)).toEqual(['s1']);
  });

  const show = () => [
    entry('s0', T0),
    entry('live', T0 + 3 * MIN, {
      kind: 'live_slot',
      slotMs: 60 * MIN,
      flexMs: 0,
      timing: 'hard',
      anchorAtMs: T0 + 3 * MIN,
    }),
    entry('s1', T0 + 63 * MIN),
    entry('s2', T0 + 66 * MIN),
  ];

  it('holds the items after a live slot while the DJ is on air mid-slot', () => {
    // 10:08, five minutes into the 10:03–11:03 show, the DJ on air.
    const plan = planFeed({
      nowMs: T0 + 8 * MIN,
      onAir: { itemId: null, segmentId: null, source: 'live', elapsedMs: 5 * MIN },
      entries: show(),
    });
    expect(plan.wanted).toEqual([]);
    expect(plan.hold).toEqual({ itemId: 's1', untilMs: T0 + 63 * MIN - 500 });
  });

  it('holds them too when safety fills a live slot with no DJ', () => {
    const plan = planFeed({
      nowMs: T0 + 30 * MIN,
      onAir: { itemId: null, segmentId: null, source: 'safety', elapsedMs: 20_000 },
      entries: show(),
    });
    expect(plan.wanted).toEqual([]);
    expect(plan.hold?.itemId).toBe('s1');
    // At the slot's end the log takes the air back.
    const after = planFeed({ nowMs: T0 + 63 * MIN, onAir: null, entries: show() });
    expect(ids(after, 2)).toEqual(['s1', 's2']);
  });
});

describe('planFeed: anchors (ADR 0003)', () => {
  const hardAt = T0 + 15 * MIN;
  const episode = (timing: FeedEntry['timing'] = 'hard') =>
    entry('ep', hardAt, {
      kind: 'episode',
      timing,
      anchorAtMs: hardAt,
      slotMs: 30 * MIN,
      flexMs: 0,
    });

  it('trims the last flexible song so a hard start lands on time', () => {
    // The log runs 40 s late: s4 (ending at 10:15:40) is cut by 40 s.
    const entries = [...songs(5), episode()];
    const plan = planFeed({ nowMs: T0 + 70_000, onAir: onAir('s0', 30_000), entries });
    const s4 = plan.wanted.find((w) => w.entry.id === 's4');
    expect(s4?.trimMs).toBe(40_000);
    expect(plan.wanted.find((w) => w.entry.id === 'ep')?.startMs).toBe(hardAt);
    expect(plan.late).toEqual([]);
  });

  it('drops whole items when the overrun is longer than they are', () => {
    const entries = [...songs(5), episode()];
    // 4 minutes late: s4 (3 min) goes, s3 is cut by 1 minute.
    const plan = planFeed({ nowMs: T0, onAir: onAir('s0', -4 * MIN), entries });
    expect(plan.wanted.map((w) => w.entry.id)).toEqual(['s1', 's2', 's3', 'ep']);
    expect(plan.wanted[2]?.trimMs).toBe(MIN);
    expect(plan.skipped).toEqual([{ entry: entries[4], reason: 'dropped' }]);
    expect(plan.wanted[3]?.startMs).toBe(hardAt);
  });

  it('reports what the tail cannot absorb', () => {
    const entries = [entry('s0', T0, { slotMs: 20 * MIN }), episode()];
    const plan = planFeed({ nowMs: T0 + MIN, onAir: onAir('s0', MIN), entries });
    expect(plan.late).toEqual([{ itemId: 'ep', ms: 5 * MIN }]);
  });

  it('holds a hard item when the music would end well before it', () => {
    const entries = [...songs(4), episode()];
    const plan = planFeed({ nowMs: T0, onAir: onAir('s0', 0), entries });
    expect(plan.wanted.map((w) => w.entry.id)).toEqual(['s1', 's2', 's3']);
    expect(plan.hold).toEqual({ itemId: 'ep', untilMs: hardAt - 500 });
    // A small gap (≤ 5 s) is not worth the safety playlist: it starts a bit early.
    const close = planFeed({
      nowMs: T0,
      onAir: onAir('s0', 4_000),
      entries: [...songs(5), episode()],
    });
    expect(close.wanted.at(-1)?.entry.id).toBe('ep');
  });

  it('holds a not-before item, then pushes it when its time comes', () => {
    const entries = [...songs(2), episode('not_before')];
    expect(planFeed({ nowMs: T0, onAir: onAir('s0', 0), entries }).hold?.itemId).toBe('ep');
    const due = planFeed({ nowMs: hardAt - 100, onAir: null, entries });
    expect(due.wanted[0]).toMatchObject({ entry: { id: 'ep' }, startMs: hardAt - 100 });
  });

  it('soft: drops what would start after the anchor, and what would end past the cap', () => {
    const softAt = T0 + 10 * MIN;
    const marker = entry('top', softAt, {
      kind: 'marker',
      slotMs: 0,
      timing: 'soft',
      anchorAtMs: softAt,
      capMs: MIN,
      flexMs: 0,
    });
    // The log runs 2 minutes early: s4 would start at 10:10 or later, so it goes.
    const early = [...songs(4), marker, entry('next', softAt)];
    const late = planFeed({ nowMs: T0, onAir: onAir('s0', 2 * MIN), entries: early });
    expect(late.wanted.map((w) => w.entry.id)).toEqual(['s1', 's2', 's3', 'next']);
    // The log runs 2 minutes late: s3 starts before 10:10 but ends at 10:14, past the cap.
    const behind = planFeed({ nowMs: T0, onAir: onAir('s0', -2 * MIN), entries: early });
    expect(behind.wanted.map((w) => w.entry.id)).toEqual(['s1', 's2', 'next']);
    expect(behind.skipped.map((s) => [s.entry.id, s.reason])).toEqual([['s3', 'dropped']]);
    expect(behind.wanted[2]?.startMs).toBe(softAt + MIN);
  });
});

describe('planFeed: re-planning after an edit', () => {
  it('only the queued tail changes: the item on air and the next one stay', () => {
    const before = songs(8);
    const plan1 = planFeed({ nowMs: T0, onAir: onAir('s0', 0), entries: before });
    const queued: QueuedEntry[] = plan1.wanted
      .slice(0, plan1.need)
      .map((w) => ({ id: w.entry.id, fingerprint: `f:${w.entry.id}`, trimMs: 0 }));

    // The item after next (s2) is replaced in the log by another song.
    const after = before.map((e) => (e.id === 's2' ? { ...e, id: 'x2' } : e));
    const plan2 = planFeed({ nowMs: T0 + 1000, onAir: onAir('s0', 1000), entries: after });
    const wanted: WantedEntry[] = plan2.wanted.map((w) => ({
      id: w.entry.id,
      fingerprint: `f:${w.entry.id}`,
      trimMs: w.trimMs,
    }));
    const actions = diffQueue(queued, wanted, plan2.need);
    expect(queued.map((q) => q.id)).toEqual(['s1', 's2', 's3']);
    expect(actions.remove).toEqual(['s2', 's3']);
    expect(actions.push.map((i) => wanted[i]?.id)).toEqual(['x2', 's3']);
  });
});

describe('diffQueue', () => {
  const w = (id: string, trimMs = 0, fingerprint = `f:${id}`) => ({ id, fingerprint, trimMs });

  it('tops the queue up without touching what matches', () => {
    expect(diffQueue([w('a')], [w('a'), w('b'), w('c')], 3)).toEqual({ remove: [], push: [1, 2] });
  });

  it('keeps extra matching entries past `need`', () => {
    expect(diffQueue([w('a'), w('b'), w('c')], [w('a'), w('b'), w('c')], 2)).toEqual({
      remove: [],
      push: [],
    });
  });

  it('re-pushes an entry pushed by someone else, or with another body', () => {
    const unknown: QueuedEntry = { id: 'a', fingerprint: null, trimMs: 0 };
    expect(diffQueue([unknown, w('b')], [w('a'), w('b')], 2)).toEqual({
      remove: ['a', 'b'],
      push: [0, 1],
    });
    expect(diffQueue([w('a'), w('b', 0, 'old')], [w('a'), w('b')], 2).remove).toEqual(['b']);
  });

  it('ignores trim jitter under the tolerance, re-pushes past it', () => {
    expect(diffQueue([w('a', 10_000)], [w('a', 10_200)], 1).remove).toEqual([]);
    expect(diffQueue([w('a', 10_000)], [w('a', 11_000)], 1).remove).toEqual(['a']);
  });

  it('removes queued entries the log no longer has', () => {
    expect(diffQueue([w('a'), w('gone')], [w('a')], 1)).toEqual({ remove: ['gone'], push: [] });
  });
});

describe('planFeed: DST days (Europe/Paris fixture)', () => {
  const TZ = 'Europe/Paris';
  const library: FixtureAsset[] = FIXTURE_LIBRARY.map((a) => ({ ...a, id: randomUUID() }));

  /** A fixture day as the feeder sees it: retimed from local midnight, all cached. */
  function fixtureEntries(localDate: string): FeedEntry[] {
    const { startsAt } = localDayBounds(localDate, TZ);
    const flat: (TimedItem & { kind: FeedEntry['kind']; capMs: number | null })[] = [];
    for (const item of buildFixtureDay(localDate, TZ, library)) {
      const id = randomUUID();
      flat.push({
        id,
        kind: item.kind,
        plannedDurationMs: item.plannedDurationMs ?? 0,
        timing: item.timing ?? 'flow',
        anchorAt: item.anchorAt ? new Date(item.anchorAt) : null,
        capMs: item.capMs ?? null,
        segmentId: null,
      });
      for (const part of item.parts ?? []) {
        flat.push({
          id: randomUUID(),
          kind: part.kind,
          plannedDurationMs: part.plannedDurationMs,
          timing: 'flow',
          anchorAt: null,
          capMs: null,
          segmentId: id,
        });
      }
    }
    const timed = retime(flat, startsAt);
    return flat.flatMap((item, i) => {
      if (item.segmentId) return [];
      const t = timed[i];
      if (!t) return [];
      const parts = flat
        .map((p, j) => ({ p, t: timed[j] }))
        .filter(({ p }) => p.segmentId === item.id)
        .map(({ p, t: pt }) => ({ id: p.id, durationMs: pt?.plannedDurationMs ?? 0 }));
      return [
        entry(item.id, t.plannedStart.getTime(), {
          kind: item.kind,
          slotMs: t.plannedDurationMs,
          timing: item.timing,
          anchorAtMs: item.anchorAt?.getTime() ?? null,
          capMs: item.capMs,
          parts,
          flexMs: item.kind === 'song' ? Math.max(0, t.plannedDurationMs - 30_000) : 0,
        }),
      ];
    });
  }

  for (const [localDate, hours] of [
    ['2026-03-29', 23],
    ['2026-10-25', 25],
  ] as const) {
    it(`feeds the ${hours}-hour day ${localDate} across its DST change, hour by hour`, () => {
      const entries = fixtureEntries(localDate);
      const { startsAt, endsAt } = localDayBounds(localDate, TZ);
      expect(endsAt.getTime() - startsAt.getTime()).toBe(hours * 3_600_000);
      const markers = entries.filter((e) => e.kind === 'marker');
      // One top-of-hour marker per real hour (none during the 19:00–21:00 live slot).
      expect(markers).toHaveLength(hours - 2);

      // Walk the night minute by minute through the change, the log on air: predicted starts
      // only move forward and never cross a top-of-hour anchor by more than its cap.
      for (
        let at = startsAt.getTime() + 30 * MIN;
        at < startsAt.getTime() + 5 * 3_600_000;
        at += MIN
      ) {
        const current = entries.findLast((e) => e.plannedStartMs <= at && e.kind !== 'marker');
        if (!current) continue;
        const plan = planFeed({
          nowMs: at,
          onAir: onAir(current.id, at - current.plannedStartMs),
          entries,
        });
        expect(plan.need).toBeGreaterThanOrEqual(2);
        const starts = plan.wanted.map((w) => w.startMs);
        expect(starts).toEqual([...starts].sort((a, b) => a - b));
        // On a plan that runs on time, nothing is dropped or late.
        expect(plan.late).toEqual([]);
        expect(plan.skipped).toEqual([]);
        const last = plan.wanted[plan.need - 1];
        expect(last && last.startMs + last.entry.slotMs - at).toBeGreaterThanOrEqual(10 * MIN);
      }
    });
  }

  it('re-syncs on the repeated 02:00 hour of the 25-hour day', () => {
    const entries = fixtureEntries('2026-10-25');
    // 00:00Z and 01:00Z are both 02:00 local; the log runs 3 minutes late into 01:00Z.
    const anchor = Date.parse('2026-10-25T01:00:00Z');
    const lastBefore = entries.findLast(
      (e) => e.plannedStartMs < anchor && e.kind === 'song',
    ) as FeedEntry;
    const plan = planFeed({
      nowMs: lastBefore.plannedStartMs - 3 * MIN,
      onAir: onAir(
        entries.findLast((e) => e.plannedStartMs < lastBefore.plannedStartMs - 3 * MIN)
          ?.id as string,
        -3 * MIN + 1,
      ),
      entries,
    });
    // Whatever would end past 01:01Z (the cap) was dropped; the next hour starts by then.
    const next = plan.wanted.find((w) => w.entry.plannedStartMs >= anchor);
    expect(next?.startMs).toBeLessThanOrEqual(anchor + MIN);
    expect(plan.skipped.some((s) => s.reason === 'dropped')).toBe(true);
  });
});
