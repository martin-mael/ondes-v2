import { type ClockSlot, clockSlotSchema, localDayBounds, zonedInstant } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { CATEGORY_IDS, FIXTURE_TZ, fixtureSnapshot, HOUR_CLOCK_ID } from '../generator/fixture.ts';
import { generateDay, generateDays } from '../generator/generate.ts';
import type { GeneratorClock, PlannedItem } from '../generator/types.ts';
import {
  createPromoPlacer,
  type PromoCandidate,
  type PromoSnapshot,
  resolvePromoPlacements,
} from './place.ts';

// Promo placement (#60, ADR 0032): eligibility (validity, dayparts, caps, pools), rotation by
// weight, determinism, and the placements the generator's hook yields on a real day.

const POOL = '00000000-0000-7000-8f00-000000000001';
const OTHER_POOL = '00000000-0000-7000-8f00-000000000002';
const DATE = '2026-11-04';

const promo = (n: number, extra: Partial<PromoCandidate> = {}): PromoCandidate => ({
  id: `00000000-0000-7000-8e00-${String(n).padStart(12, '0')}`,
  assetId: `00000000-0000-7000-8e01-${String(n).padStart(12, '0')}`,
  poolIds: [POOL],
  weight: 1,
  maxPlaysPerDay: null,
  dayparts: [],
  startAt: null,
  killAt: null,
  enabled: true,
  playMs: 20_000,
  ...extra,
});

const snapshot = (promos: PromoCandidate[], plays: PromoSnapshot['plays'] = []) => ({
  timeZone: FIXTURE_TZ,
  promos,
  plays,
});

const song = (start: Date): PlannedItem => ({
  keptId: null,
  kind: 'song',
  plannedDurationMs: 200_000,
  assetId: '00000000-0000-7000-8a55-000000000001',
  episodeId: null,
  liveSlotId: null,
  title: null,
  timing: 'flow',
  anchorAt: null,
  capMs: null,
  origin: { type: 'clock', clockId: HOUR_CLOCK_ID, slotIndex: 2 },
  relaxedRules: [],
  segmentId: null,
  crossOutMs: null,
  start,
});

const at = (time: string, date = DATE) => zonedInstant(date, time, FIXTURE_TZ);

/** Asks the placer for one promo at `time`, after a fresh song. */
function ask(placer: ReturnType<typeof createPromoPlacer>, time: string, date = DATE) {
  const when = at(time, date);
  return placer.placeVoiceTrack({
    clockId: HOUR_CLOCK_ID,
    slotIndex: 3,
    mode: 'promo',
    poolId: POOL,
    at: when,
    previous: song(new Date(when.getTime() - 200_000)),
  });
}

describe('createPromoPlacer', () => {
  it('leaves placeholders to the generator', () => {
    const placer = createPromoPlacer(snapshot([promo(1)]), { seed: 's' });
    const placed = placer.placeVoiceTrack({
      clockId: HOUR_CLOCK_ID,
      slotIndex: 1,
      mode: 'placeholder',
      poolId: null,
      at: at('10:00'),
      previous: song(at('09:57')),
    });
    expect(placed).toBeNull();
    expect(placer.placements).toHaveLength(0);
  });

  it('places a promo of the pool over the transition, adding nothing to the run', () => {
    const placer = createPromoPlacer(snapshot([promo(1, { poolIds: [OTHER_POOL] }), promo(2)]), {
      seed: 's',
    });
    expect(ask(placer, '10:00')).toEqual([]);
    expect(placer.placements.map((p) => p.promoId)).toEqual([promo(2).id]);
    expect(placer.placements[0]?.poolId).toBe(POOL);
  });

  it('never places an expired promo, nor one not started yet', () => {
    const kill = at('10:00');
    const placer = createPromoPlacer(
      snapshot([
        promo(1, { killAt: kill }),
        promo(2, { startAt: at('12:00') }),
        // Kill date inside the voice's margin: it could still be on air then.
        promo(3, { killAt: new Date(at('11:00').getTime() + 10_000) }),
      ]),
      { seed: 's' },
    );
    for (const time of ['09:00', '10:00', '10:30', '11:00', '11:30']) ask(placer, time);
    const byTime = placer.placements.map((p) => [p.at.toISOString(), p.promoId]);
    for (const [iso, id] of byTime) {
      const t = Date.parse(iso as string);
      if (id === promo(1).id) expect(t + 20_000).toBeLessThan(kill.getTime());
      if (id === promo(2).id) expect(t - 20_000).toBeGreaterThanOrEqual(at('12:00').getTime());
      if (id === promo(3).id) expect(t + 20_000).toBeLessThan(at('11:00').getTime() + 10_000);
    }
    // 11:30: nothing valid left.
    expect(placer.issues.at(-1)?.code).toBe('no_eligible_promo');
  });

  it('skips disabled promos and caps plays per station-local day', () => {
    const placer = createPromoPlacer(
      snapshot(
        [promo(1, { maxPlaysPerDay: 2 }), promo(2, { enabled: false })],
        // One play already counted today (a kept placement), one yesterday (doesn't count).
        [
          { promoId: promo(1).id, at: at('08:00') },
          { promoId: promo(1).id, at: at('23:30', '2026-11-03') },
        ],
      ),
      { seed: 's' },
    );
    ask(placer, '10:00');
    ask(placer, '11:00');
    ask(placer, '12:00');
    expect(placer.placements).toHaveLength(1);
    expect(placer.issues.map((i) => i.code)).toEqual(['no_eligible_promo', 'no_eligible_promo']);
    // The next local day starts a new count.
    ask(placer, '00:30', '2026-11-05');
    expect(placer.placements).toHaveLength(2);
  });

  it('keeps to dayparts on the station clock, across the DST changes', () => {
    // Weekday mornings 06–10, and Sunday 02–03 (the hour that repeats in October).
    const dayparts = [
      { weekdays: [1, 2, 3, 4, 5], startHour: 6, endHour: 10 },
      { weekdays: [7], startHour: 2, endHour: 3 },
    ];
    const placer = createPromoPlacer(snapshot([promo(1, { dayparts })]), { seed: 's' });
    expect(placer.placeVoiceTrack).toBeDefined();
    ask(placer, '05:59');
    ask(placer, '06:00');
    ask(placer, '09:59');
    ask(placer, '10:00');
    expect(placer.placements.map((p) => p.at)).toEqual([at('06:00'), at('09:59')]);

    // 2026-10-25 (last Sunday of October): 02:00–03:00 happens twice, both count.
    const fallBack = localDayBounds('2026-10-25', FIXTURE_TZ).startsAt.getTime();
    const firstTwo = new Date(fallBack + 2 * 3_600_000 + 15 * 60_000); // 02:15 CEST
    const secondTwo = new Date(fallBack + 3 * 3_600_000 + 15 * 60_000); // 02:15 CET
    const later = new Date(fallBack + 4 * 3_600_000 + 15 * 60_000); // 03:15 CET
    const dst = createPromoPlacer(snapshot([promo(1, { dayparts })]), { seed: 's' });
    for (const when of [firstTwo, secondTwo, later]) {
      dst.placeVoiceTrack({
        clockId: HOUR_CLOCK_ID,
        slotIndex: 3,
        mode: 'promo',
        poolId: POOL,
        at: when,
        previous: song(new Date(when.getTime() - 200_000)),
      });
    }
    expect(dst.placements.map((p) => p.at)).toEqual([firstTwo, secondTwo]);

    // 2026-03-29 (last Sunday of March): 02:00 doesn't exist; the hour after the jump is 03:00.
    const springStart = localDayBounds('2026-03-29', FIXTURE_TZ).startsAt.getTime();
    const spring = createPromoPlacer(snapshot([promo(1, { dayparts })]), { seed: 's' });
    spring.placeVoiceTrack({
      clockId: HOUR_CLOCK_ID,
      slotIndex: 3,
      mode: 'promo',
      poolId: POOL,
      // 01:30 UTC = 03:30 CEST: outside 02–03.
      at: new Date(springStart + 2.5 * 3_600_000),
      previous: song(new Date(springStart + 2.4 * 3_600_000)),
    });
    expect(spring.placements).toHaveLength(0);
  });

  it('spreads plays in proportion to weight, deterministically', () => {
    const promos = [promo(1, { weight: 3 }), promo(2, { weight: 1 }), promo(3, { weight: 2 })];
    const run = () => {
      const placer = createPromoPlacer(snapshot(promos), { seed: 'seed' });
      for (let h = 0; h < 24; h++) {
        for (const m of ['05', '25', '45']) ask(placer, `${String(h).padStart(2, '0')}:${m}`);
      }
      return placer.placements.map((p) => p.promoId);
    };
    const ids = run();
    expect(run()).toEqual(ids);
    const count = (n: number) => ids.filter((id) => id === promo(n).id).length;
    expect(count(1)).toBe(36);
    expect(count(3)).toBe(24);
    expect(count(2)).toBe(12);
    // Never the same promo twice in a row while another one is as due.
    expect(ids.slice(0, 6)).not.toEqual(Array(6).fill(promo(1).id));
  });

  it('needs a song before the slot and one promo per transition', () => {
    const placer = createPromoPlacer(snapshot([promo(1), promo(2)]), { seed: 's' });
    const when = at('10:00');
    const jingle = { ...song(when), kind: 'jingle' as const };
    const context = {
      clockId: HOUR_CLOCK_ID,
      slotIndex: 3,
      mode: 'promo' as const,
      poolId: POOL,
      at: when,
    };
    placer.placeVoiceTrack({ ...context, previous: null });
    placer.placeVoiceTrack({ ...context, previous: jingle });
    placer.placeVoiceTrack({ ...context, previous: { ...song(when), keptId: 'kept' } });
    const a = song(when);
    placer.placeVoiceTrack({ ...context, previous: a });
    placer.placeVoiceTrack({ ...context, previous: a });
    expect(placer.issues.map((i) => i.code)).toEqual([
      'no_song_before',
      'no_song_before',
      'transition_taken',
      'transition_taken',
    ]);
    expect(placer.placements).toHaveLength(1);
  });
});

// --- With the generator --------------------------------------------------------------------

const slot = (input: Record<string, unknown>): ClockSlot => clockSlotSchema.parse(input);

/** Songs with a promo slot after every second one, and one right after a jingle. */
function promoClock(): GeneratorClock {
  const music = () => slot({ kind: 'category', categoryId: CATEGORY_IDS.current });
  const promoSlot = () => slot({ kind: 'vt', mode: 'promo', poolId: POOL });
  return {
    id: HOUR_CLOCK_ID,
    targetDurationMs: 3_600_000,
    slots: [
      slot({ kind: 'marker', offsetMs: 0, timing: 'soft', capMs: 60_000 }),
      slot({ kind: 'jingle', categoryId: CATEGORY_IDS.jingles }),
      promoSlot(),
      ...Array.from({ length: 7 }, (_, i) =>
        i % 2 === 1 ? [music(), promoSlot()] : [music()],
      ).flat(),
      music(),
      music(),
      music(),
      music(),
      music(),
      music(),
      music(),
      music(),
    ],
  };
}

describe('the placeVoiceTrack hook in the generator', () => {
  it('places promos between two songs, and the day keeps its music', () => {
    const snap = fixtureSnapshot({ songs: 600, clocks: [promoClock()] });
    const plain = generateDay(snap, DATE);
    const placer = createPromoPlacer(snapshot([promo(1), promo(2)]), { seed: snap.stationId });
    const day = generateDay(snap, DATE, {
      extensions: { placeVoiceTrack: placer.placeVoiceTrack },
    });
    // The hook adds no items: the same day, item for item.
    expect(day.items.map((i) => i.assetId)).toEqual(plain.items.map((i) => i.assetId));
    expect(day.issues.filter((i) => i.code === 'vt_placeholder')).toHaveLength(0);

    const { placed, issues } = resolvePromoPlacements(day, placer.placements);
    // Three promo slots per hour follow a song; the one after the jingle doesn't.
    expect(placed.length).toBeGreaterThanOrEqual(24 * 3 - 2);
    expect(placer.issues.filter((i) => i.code === 'no_song_before').length).toBeGreaterThanOrEqual(
      24,
    );
    for (const p of placed) {
      const a = day.items[p.fromPosition];
      const b = day.items[p.toPosition];
      expect(a?.kind).toBe('song');
      expect(b?.kind).toBe('song');
      expect(p.plannedAt.getTime()).toBe(
        (a?.plannedStart.getTime() ?? 0) + (a?.plannedDurationMs ?? 0),
      );
    }
    expect(new Set(placed.map((p) => p.fromPosition)).size).toBe(placed.length);
    expect(issues.every((i) => i.code === 'no_song_after')).toBe(true);
  });

  it('without the hook, a pool slot is reported like a placeholder', () => {
    const day = generateDay(fixtureSnapshot({ songs: 600, clocks: [promoClock()] }), DATE);
    expect(day.issues.filter((i) => i.code === 'vt_placeholder').length).toBeGreaterThan(0);
  });

  it('counts plays across the days it generates', () => {
    const snap = fixtureSnapshot({ songs: 600, clocks: [promoClock()] });
    const placer = createPromoPlacer(snapshot([promo(1, { maxPlaysPerDay: 5 })]), {
      seed: snap.stationId,
    });
    const days = generateDays(snap, [DATE, '2026-11-05'], {
      extensions: { placeVoiceTrack: placer.placeVoiceTrack },
    });
    for (const day of days) {
      expect(resolvePromoPlacements(day, placer.placements).placed.length).toBeLessThanOrEqual(5);
    }
    expect(placer.placements).toHaveLength(10);
  });
});
