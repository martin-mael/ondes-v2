import {
  addDays,
  clockSlotSchema,
  DEFAULT_ROTATION_RULES,
  LOG_TRANSITION_MS,
  localDayBounds,
  logDayItemInputSchema,
  type RotationRule,
  zonedFields,
  zonedInstant,
} from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { expandGrid } from '../grid/index.ts';
import { artistKeys } from '../rules/history.ts';
import { randomFor } from '../rules/random.ts';
import {
  CATEGORY_IDS,
  FIXTURE_TZ,
  fixtureAsset,
  fixtureSnapshot,
  HOUR_CLOCK_ID,
  hourClock,
} from './fixture.ts';
import { generateDay, generateDays, itemLengthMs, settleOccurrences } from './generate.ts';
import type {
  GeneratedDay,
  GeneratedItem,
  GeneratorOccurrence,
  GeneratorSnapshot,
  KeptItem,
  PlannedItem,
} from './types.ts';

const DATE = '2026-06-10';
const HOUR = 3_600_000;
const MINUTE = 60_000;

const top = (day: GeneratedDay) => day.items.filter((i) => i.segmentId === null);

/** The day's new items as the log's bulk write takes them (`logDayItemInputSchema`). */
function asInputs(day: GeneratedDay) {
  return day.items
    .filter((i) => i.keptId === null)
    .map((i) =>
      logDayItemInputSchema.parse({
        kind: i.kind,
        plannedDurationMs: i.plannedDurationMs,
        assetId: i.assetId,
        episodeId: i.episodeId,
        liveSlotId: i.liveSlotId,
        title: i.title,
        timing: i.timing,
        anchorAt: i.anchorAt?.toISOString() ?? null,
        capMs: i.capMs,
        origin: i.origin,
        relaxedRules: i.relaxedRules,
      }),
    );
}

function occurrence(overrides: Partial<GeneratorOccurrence> = {}): GeneratorOccurrence {
  return {
    slotId: '00000000-0000-7000-8551-000000000001',
    showId: '00000000-0000-7000-8550-000000000001',
    showName: 'Le Midi Vandale',
    type: 'prerecorded',
    date: DATE,
    startsAt: zonedInstant(DATE, '12:00', FIXTURE_TZ),
    durationMs: HOUR,
    special: false,
    episode: null,
    ...overrides,
  };
}

const episodeAsset = (n: number, playMs: number) =>
  fixtureAsset(90_000 + n, { type: 'episode', playMs, overlapMs: 0, artists: ['Vandale'] });

describe('a day', () => {
  const snapshot = fixtureSnapshot();
  const day = generateDay(snapshot, DATE);

  it('covers the local day without holes', () => {
    const { startsAt, endsAt } = localDayBounds(DATE, FIXTURE_TZ);
    expect(day.startsAt).toEqual(startsAt);
    expect(day.endsAt).toEqual(endsAt);
    const items = top(day);
    expect(items[0]?.plannedStart).toEqual(startsAt);
    for (const item of items) {
      expect(item.plannedStart.getTime()).toBeGreaterThanOrEqual(startsAt.getTime());
      expect(item.plannedStart.getTime()).toBeLessThan(endsAt.getTime());
    }
    // A complete grid: nothing waits for its time.
    expect(items.filter((i) => i.timing === 'not_before')).toEqual([]);
    const last = items.at(-1) as GeneratedItem;
    expect(
      Math.abs(last.plannedStart.getTime() + last.plannedDurationMs - endsAt.getTime()),
    ).toBeLessThan(6 * MINUTE);
    expect(day.items.map((i) => i.position)).toEqual(day.items.map((_, i) => i));
  });

  it('validates against the log contract', () => {
    const inputs = asInputs(day);
    expect(inputs.length).toBe(day.items.length);
    expect(inputs.every((i) => i.origin.type === 'clock')).toBe(true);
  });

  it('plans every hour of the clock: one top-of-hour marker per hour, a soft anchor', () => {
    const markers = day.items.filter((i) => i.kind === 'marker');
    expect(markers).toHaveLength(24);
    for (const m of markers) {
      expect(m.timing).toBe('soft');
      expect(m.capMs).toBe(60_000);
      expect(zonedFields(m.anchorAt as Date, FIXTURE_TZ).minute).toBe(0);
    }
  });

  it('records where each item comes from', () => {
    const clock = hourClock();
    for (const item of day.items) {
      expect(item.origin).toMatchObject({ type: 'clock', clockId: HOUR_CLOCK_ID });
      const slot = clock.slots[(item.origin as { slotIndex: number }).slotIndex];
      expect(slot).toBeDefined();
      if (item.kind === 'song') expect(slot?.kind).toBe('category');
      if (item.kind === 'jingle') expect(slot?.kind).toBe('jingle');
    }
  });

  it('sizes items as the log does: what they play, minus the overlap, plus a frame', () => {
    const asset = fixtureAsset(1, { durationMs: 200_000, playMs: 190_000, overlapMs: 4_000 });
    expect(itemLengthMs(asset)).toBe(190_000 - 4_000 + LOG_TRANSITION_MS);
    expect(itemLengthMs({ ...asset, playMs: null })).toBe(200_000 - 4_000 + LOG_TRANSITION_MS);
  });

  it('is reproducible: same snapshot and seed, same day; another seed, another day', () => {
    const again = generateDay(fixtureSnapshot(), DATE);
    expect(again.items).toEqual(day.items);
    expect(day.seed).toBe(`${snapshot.stationId}:${DATE}`);
    const other = generateDay(fixtureSnapshot(), DATE, { seed: 'another' });
    expect(other.items.map((i) => i.assetId)).not.toEqual(day.items.map((i) => i.assetId));
  });
});

describe('DST days (Europe/Paris)', () => {
  for (const [date, hours] of [
    ['2026-03-29', 23],
    ['2026-10-25', 25],
    ['2027-03-28', 23],
    ['2027-10-31', 25],
  ] as const) {
    it(`${date} has ${hours} hours, each with its clock`, () => {
      const day = generateDay(fixtureSnapshot(), date);
      expect(day.endsAt.getTime() - day.startsAt.getTime()).toBe(hours * HOUR);
      const markers = day.items.filter((i) => i.kind === 'marker');
      const realHours = expandGrid(
        { defaultClockId: HOUR_CLOCK_ID, cells: [], overrides: [] },
        { from: day.startsAt, to: day.endsAt },
        FIXTURE_TZ,
      );
      expect(realHours).toHaveLength(hours);
      expect(markers.map((m) => m.anchorAt)).toEqual(realHours.map((h) => h.startsAt));
      const items = top(day);
      expect(items[0]?.plannedStart).toEqual(day.startsAt);
      expect(items.every((i) => i.plannedStart < day.endsAt)).toBe(true);
      expect(items.filter((i) => i.timing === 'not_before')).toEqual([]);
      asInputs(day);
    });
  }

  it('chains days: the day after a 25-hour day starts where it ends', () => {
    const [a, b] = generateDays(fixtureSnapshot(), ['2026-10-25', '2026-10-26']);
    expect(b?.startsAt).toEqual(a?.endsAt);
    // The first item of the second day is timed against the first day's end.
    const last = top(a as GeneratedDay).at(-1) as GeneratedItem;
    const end = last.plannedStart.getTime() + last.plannedDurationMs;
    const first = top(b as GeneratedDay)[0] as GeneratedItem;
    const expected = end - first.plannedStart.getTime();
    if (expected === 0) expect(first.conflict).toBeNull();
    else
      expect(first.conflict).toEqual({
        kind: expected > 0 ? 'overrun' : 'gap',
        ms: Math.abs(expected),
      });
  });

  it('a show at 02:30 on the spring-forward night airs at 03:30 CEST, inside a 23-hour day', () => {
    const date = '2026-03-29';
    const startsAt = zonedInstant(date, '02:30', FIXTURE_TZ);
    expect(zonedFields(startsAt, FIXTURE_TZ).hour).toBe(3);
    const day = generateDay(
      fixtureSnapshot({ occurrences: [occurrence({ date, startsAt, type: 'live' })] }),
      date,
    );
    const live = day.items.find((i) => i.kind === 'live_slot');
    expect(live?.plannedStart).toEqual(startsAt);
  });
});

describe('show occurrences', () => {
  it('plans a pre-recorded episode with its audio as a hard start, and music around it', () => {
    const asset = episodeAsset(1, 57 * MINUTE);
    const o = occurrence({
      episode: { id: '00000000-0000-7000-8e00-000000000001', title: 'Episode 12', asset },
    });
    const day = generateDay(fixtureSnapshot({ occurrences: [o] }), DATE);
    const episode = day.items.find((i) => i.kind === 'episode') as GeneratedItem;
    expect(episode).toMatchObject({
      assetId: asset.id,
      episodeId: o.episode?.id,
      timing: 'hard',
      anchorAt: o.startsAt,
      plannedStart: o.startsAt,
      origin: { type: 'show', showSlotId: o.slotId },
      plannedDurationMs: 57 * MINUTE + LOG_TRANSITION_MS,
    });
    // The three minutes left of the slot get music, then 13:00's clock.
    const after = day.items[episode.position + 1] as GeneratedItem;
    expect(after.origin.type).toBe('clock');
    expect(after.plannedStart.getTime()).toBe(o.startsAt.getTime() + episode.plannedDurationMs);
    expect(day.issues.filter((i) => i.code === 'episode_missing')).toEqual([]);
    asInputs(day);
  });

  it('plans an occurrence without audio as an empty episode item, and reports it', () => {
    const o = occurrence({
      episode: { id: '00000000-0000-7000-8e00-000000000002', title: null, asset: null },
    });
    const day = generateDay(fixtureSnapshot({ occurrences: [o] }), DATE);
    const episode = day.items.find((i) => i.kind === 'episode');
    expect(episode).toMatchObject({
      assetId: null,
      episodeId: o.episode?.id,
      plannedDurationMs: HOUR,
      title: o.showName,
      origin: { type: 'show', showSlotId: o.slotId },
    });
    expect(day.issues).toContainEqual(
      expect.objectContaining({ code: 'episode_missing', showSlotId: o.slotId, at: o.startsAt }),
    );
    // No premiere at all: still an item for the missing-episode check to fill.
    const none = generateDay(fixtureSnapshot({ occurrences: [occurrence()] }), DATE);
    expect(none.items.find((i) => i.kind === 'episode')).toMatchObject({
      episodeId: null,
      assetId: null,
    });
    asInputs(day);
  });

  it('plans a rerun with the episode it plays again', () => {
    const asset = episodeAsset(2, HOUR - 30_000);
    const o = occurrence({
      type: 'rerun',
      episode: { id: '00000000-0000-7000-8e00-000000000003', title: 'Episode 3', asset },
    });
    const day = generateDay(fixtureSnapshot({ occurrences: [o] }), DATE);
    expect(day.items.find((i) => i.kind === 'episode')).toMatchObject({
      assetId: asset.id,
      episodeId: o.episode?.id,
      origin: { type: 'show', showSlotId: o.slotId },
    });
  });

  it('plans a live occurrence as a live slot', () => {
    const o = occurrence({ type: 'live', durationMs: 2 * HOUR });
    const day = generateDay(fixtureSnapshot({ occurrences: [o] }), DATE);
    const live = day.items.find((i) => i.kind === 'live_slot') as GeneratedItem;
    expect(live).toMatchObject({ plannedDurationMs: 2 * HOUR, timing: 'hard', title: o.showName });
    const next = day.items[live.position + 1] as GeneratedItem;
    expect(next.plannedStart.getTime()).toBe(o.startsAt.getTime() + 2 * HOUR);
  });

  it('settles collisions: a one-off beats a weekly slot at the same time; partial overlaps stay', () => {
    const weekly = occurrence({ slotId: '00000000-0000-7000-8551-00000000000a' });
    const special = occurrence({ slotId: '00000000-0000-7000-8551-00000000000b', special: true });
    const later = occurrence({
      slotId: '00000000-0000-7000-8551-00000000000c',
      startsAt: new Date(weekly.startsAt.getTime() + 30 * MINUTE),
    });
    const settled = settleOccurrences([weekly, special, later]);
    expect(settled.kept.map((o) => o.slotId)).toEqual([special.slotId, later.slotId]);
    expect(settled.dropped.map((o) => o.slotId)).toEqual([weekly.slotId]);
    expect(settled.overlaps.map((o) => o.slotId)).toEqual([later.slotId]);

    const day = generateDay(fixtureSnapshot({ occurrences: [weekly, special, later] }), DATE);
    const episodes = day.items.filter((i) => i.kind === 'episode');
    expect(episodes.map((e) => (e.origin as { showSlotId: string }).showSlotId)).toEqual([
      special.slotId,
      later.slotId,
    ]);
    expect(episodes[1]?.conflict).toEqual({ kind: 'overrun', ms: 30 * MINUTE });
    expect(day.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['occurrence_dropped', 'occurrence_overlap']),
    );
  });

  it('a show from the night before holds the start of the day; music waits for its end', () => {
    const o = occurrence({
      date: addDays(DATE, -1),
      startsAt: zonedInstant(addDays(DATE, -1), '23:00', FIXTURE_TZ),
      durationMs: 2 * HOUR,
      type: 'live',
    });
    const day = generateDay(fixtureSnapshot({ occurrences: [o] }), DATE);
    expect(day.items.some((i) => i.kind === 'live_slot')).toBe(false);
    // The 01:00 top-of-hour marker comes first, anchored to its time.
    const first = top(day)[0] as GeneratedItem;
    expect(first.timing).not.toBe('flow');
    expect(first.plannedStart).toEqual(zonedInstant(DATE, '01:00', FIXTURE_TZ));
  });
});

describe('the grid', () => {
  it('reports hours without a clock and waits for the next one rather than sliding into it', () => {
    // A grid without a default clock, painted from 06:00 on every day.
    const cells = [1, 2, 3, 4, 5, 6, 7].flatMap((weekday) =>
      Array.from({ length: 18 }, (_, h) => ({ weekday, hour: h + 6, clockId: HOUR_CLOCK_ID })),
    );
    const day = generateDay(
      fixtureSnapshot({ grid: { defaultClockId: null, cells, overrides: [] } }),
      DATE,
    );
    const gaps = day.issues.filter((i) => i.code === 'no_clock');
    expect(gaps).toHaveLength(6);
    expect(gaps[0]?.at).toEqual(day.startsAt);
    const first = top(day)[0] as GeneratedItem;
    expect(first.plannedStart).toEqual(zonedInstant(DATE, '06:00', FIXTURE_TZ));
    // The first item is the 06:00 marker (soft): it anchors itself.
    expect(first.timing).not.toBe('flow');
    expect(first.conflict).toEqual({ kind: 'gap', ms: 6 * HOUR });
  });

  it('reports a clock the snapshot lacks', () => {
    const day = generateDay(
      fixtureSnapshot({
        grid: { defaultClockId: '00000000-0000-7000-8c10-0000000000ff', cells: [], overrides: [] },
      }),
      DATE,
    );
    expect(day.items).toEqual([]);
    expect(day.issues.filter((i) => i.code === 'unknown_clock')).toHaveLength(24);
  });

  it('repeats a partial clock within the hour', () => {
    const quarter = {
      id: '00000000-0000-7000-8c10-000000000015',
      targetDurationMs: 15 * MINUTE,
      slots: [
        clockSlotSchema.parse({ kind: 'marker', offsetMs: 0, timing: 'soft', capMs: 30_000 }),
        ...[1, 2, 3, 4].map(() =>
          clockSlotSchema.parse({ kind: 'category', categoryId: CATEGORY_IDS.current }),
        ),
      ],
    };
    const day = generateDay(
      fixtureSnapshot({
        clocks: [quarter],
        grid: { defaultClockId: quarter.id, cells: [], overrides: [] },
      }),
      DATE,
    );
    const markers = day.items.filter((i) => i.kind === 'marker');
    expect(markers).toHaveLength(96);
    expect(new Set(markers.map((m) => zonedFields(m.anchorAt as Date, FIXTURE_TZ).minute))).toEqual(
      new Set([0, 15, 30, 45]),
    );
  });

  it('reports an empty category and keeps going', () => {
    const snapshot = fixtureSnapshot();
    const categories = new Map(snapshot.categories);
    const current = categories.get(CATEGORY_IDS.current);
    if (current) categories.set(CATEGORY_IDS.current, { ...current, members: [] });
    const day = generateDay({ ...snapshot, categories }, DATE);
    const unfilled = day.issues.filter((i) => i.code === 'unfilled_slot');
    expect(unfilled.length).toBeGreaterThan(0);
    expect(unfilled[0]?.detail).toBe('no schedulable member');
    expect(day.items.filter((i) => i.kind === 'song').length).toBeGreaterThan(200);
  });
});

describe('kept items', () => {
  it('keeps locked items and segue ends with their ids, and plans around them', () => {
    const base = generateDay(fixtureSnapshot(), DATE);
    const [a, b] = base.items.filter((i) => i.kind === 'song').slice(40, 42) as [
      GeneratedItem,
      GeneratedItem,
    ];
    const keep = (item: GeneratedItem, id: string): KeptItem => ({
      id,
      kind: item.kind,
      plannedStart: item.plannedStart,
      plannedDurationMs: item.plannedDurationMs,
      timing: 'flow',
      anchorAt: null,
      segmentId: null,
      crossOutMs: null,
      showSlotId: null,
      reasons: ['segue'],
      played: null,
    });
    const kept = [
      keep(a, '00000000-0000-7000-8ee0-000000000001'),
      keep(b, '00000000-0000-7000-8ee0-000000000002'),
    ];
    const day = generateDay({ ...fixtureSnapshot(), kept: new Map([[DATE, kept]]) }, DATE, {
      seed: 'regenerated',
    });
    const out = day.items.filter((i) => i.keptId !== null);
    expect(out.map((i) => i.keptId)).toEqual(kept.map((k) => k.id));
    // Still back to back (the segue stays attached), close to where they were.
    const [x, y] = out as [GeneratedItem, GeneratedItem];
    expect(y.position).toBe(x.position + 1);
    expect(Math.abs(x.plannedStart.getTime() - a.plannedStart.getTime())).toBeLessThan(6 * MINUTE);
  });

  it('a kept fallback stands for its occurrence: the occurrence is not planned again', () => {
    const o = occurrence();
    const fallback: KeptItem = {
      id: '00000000-0000-7000-8ee0-000000000003',
      kind: 'episode',
      plannedStart: o.startsAt,
      plannedDurationMs: HOUR,
      timing: 'hard',
      anchorAt: o.startsAt,
      segmentId: null,
      crossOutMs: null,
      showSlotId: o.slotId,
      reasons: ['fallback'],
      played: null,
    };
    const day = generateDay(
      { ...fixtureSnapshot({ occurrences: [o] }), kept: new Map([[DATE, [fallback]]]) },
      DATE,
    );
    const episodes = day.items.filter((i) => i.kind === 'episode');
    expect(episodes.map((e) => e.keptId)).toEqual([fallback.id]);
    expect(day.issues.filter((i) => i.code === 'occurrence_dropped')).toEqual([]);
  });
});

describe('extension points', () => {
  it('hands each run before an anchor to beforeAnchor (#46) and plans what it returns', () => {
    const seen: number[] = [];
    const day = generateDay(fixtureSnapshot(), DATE, {
      extensions: {
        beforeAnchor: ({ anchor, run, runEndsAt }) => {
          seen.push(run.length);
          expect(anchor.timing).not.toBe('flow');
          expect(runEndsAt.getTime()).toBeGreaterThanOrEqual(run[0]?.start.getTime() ?? 0);
          // Drop the last item of every run.
          return run.slice(0, -1);
        },
      },
    });
    expect(seen).toHaveLength(24);
    const plain = generateDay(fixtureSnapshot(), DATE);
    expect(day.items.length).toBe(plain.items.length - seen.filter((n) => n > 0).length);
  });

  it('asks placeVoiceTrack (#60) for placeholder slots, and reports them when nothing places one', () => {
    const clock = hourClock();
    const withVt = {
      ...clock,
      slots: [
        ...clock.slots.slice(0, 4),
        clockSlotSchema.parse({ kind: 'vt', mode: 'placeholder' }),
        ...clock.slots.slice(4),
      ],
    };
    const snapshot = fixtureSnapshot({ clocks: [withVt] });
    const plain = generateDay(snapshot, DATE);
    expect(plain.issues.filter((i) => i.code === 'vt_placeholder')).toHaveLength(24);

    const calls: PlannedItem[] = [];
    const placed = generateDay(snapshot, DATE, {
      extensions: {
        placeVoiceTrack: ({ previous, slotIndex }) => {
          expect(slotIndex).toBe(4);
          if (previous) calls.push(previous);
          return [];
        },
      },
    });
    expect(calls).toHaveLength(24);
    expect(placed.issues.filter((i) => i.code === 'vt_placeholder')).toEqual([]);
  });
});

// --- Properties ----------------------------------------------------------------------------

const rule = (r: Record<string, unknown>) => r as unknown as RotationRule;

/** Every broken rule is either relaxed on the item or never broken (unbreakable). */
function checkRules(snapshot: GeneratorSnapshot, days: GeneratedDay[], minutes: number) {
  const assets = new Map(
    [...snapshot.categories.values()].flatMap((c) => c.members.map((m) => [m.id, m] as const)),
  );
  const songs = days.flatMap((d) => d.items.filter((i) => i.kind === 'song'));
  for (let i = 0; i < songs.length; i++) {
    const item = songs[i] as GeneratedItem;
    const asset = assets.get(item.assetId as string);
    if (!asset) throw new Error('unknown asset');
    const artists = new Set(artistKeys(asset.artists, true));
    const relaxed = new Set(item.relaxedRules.map((r) => r.rule));
    for (let j = i - 1; j >= 0; j--) {
      const before = songs[j] as GeneratedItem;
      const gap = (item.start.getTime() - before.start.getTime()) / MINUTE;
      if (gap >= Math.max(minutes, 24 * 60)) break;
      const other = assets.get(before.assetId as string);
      if (!other) continue;
      // Unbreakable: never two songs by one artist within `minutes`.
      if (gap < minutes && artistKeys(other.artists, true).some((a) => artists.has(a))) {
        throw new Error(`${asset.artists} twice within ${gap} min at ${item.start.toISOString()}`);
      }
      // Song rest (breakable): a repeat inside the category's rest is relaxed on the item.
      const category = [...snapshot.categories.values()].find((c) => c.members.includes(asset));
      if (other.id === asset.id && category && gap < category.restMinutes) {
        expect(relaxed.has('song_rest')).toBe(true);
      }
    }
  }
}

describe('rule properties', () => {
  it('never breaks an unbreakable rule, and records every breakable one it breaks', () => {
    for (let run = 0; run < 6; run++) {
      const seed = `property-${run}`;
      const songs = 150 + Math.floor(randomFor(seed, 'songs') * 400);
      const minutes = 20 + Math.floor(randomFor(seed, 'minutes') * 40);
      const rules = [
        ...DEFAULT_ROTATION_RULES.filter((r) => r.kind !== 'artist_separation'),
        rule({
          id: 'artist-hard',
          enabled: true,
          priority: 5,
          breakable: false,
          kind: 'artist_separation',
          unit: 'minutes',
          value: minutes,
          includeFeatured: true,
        }),
      ];
      const snapshot = fixtureSnapshot({ songs, rules, seed });
      const days = generateDays(snapshot, [DATE, addDays(DATE, 1)], { seed });
      checkRules(snapshot, days, minutes);
      for (const day of days) asInputs(day);
    }
  });

  it('relaxes rules on a library too small for them, and says so on the items', () => {
    const snapshot = fixtureSnapshot({ songs: 40 });
    const day = generateDay(snapshot, DATE);
    const relaxed = day.items.flatMap((i) => i.relaxedRules.map((r) => r.rule));
    expect(relaxed.length).toBeGreaterThan(0);
    expect(new Set(relaxed)).not.toContain('flow');
    expect(day.items.filter((i) => i.kind === 'song').length).toBeGreaterThan(300);
  });
});
