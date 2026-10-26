import {
  addDays,
  type ClockSlot,
  clockSlotSchema,
  type LocalDate,
  zonedInstant,
} from '@ondes/shared';
import {
  CATEGORY_IDS,
  FIXTURE_TZ,
  fixtureAsset,
  fixtureSnapshot,
  HOUR_CLOCK_ID,
  hourClock,
} from '../generator/fixture.ts';
import type {
  GeneratorAsset,
  GeneratorCategory,
  GeneratorOccurrence,
  GeneratorSnapshot,
} from '../generator/types.ts';

// A station with hard starts every day, for back-timing's tests and the as-run simulation:
// the generator's fixture (hour clock, three music categories, jingles) plus a category of
// beds and a `fill` slot at the end of the clock, and pre-recorded episodes at 07:00, 12:00
// (soft, 30 s cap), 18:30 and 21:00. Deterministic.

export const BEDS_CATEGORY_ID = '00000000-0000-7000-8c01-000000000005';

const uuid = (prefix: string, n: number) =>
  `00000000-0000-7000-${prefix}-${String(n).padStart(12, '0')}`;

/** 16 beds, 40 s to 160 s. */
export function fixtureBeds(): GeneratorAsset[] {
  return Array.from({ length: 16 }, (_, i) =>
    fixtureAsset(90_000 + i, {
      type: 'bed',
      durationMs: 40_000 + i * 8_000,
      artists: [],
      album: null,
      overlapMs: 0,
      title: `Bed ${i + 1}`,
    }),
  );
}

/** The hour clock with a `fill` slot of beds at its end, before the next top of hour. */
export function hourClockWithFill(): ReturnType<typeof hourClock> {
  const clock = hourClock();
  const fill: ClockSlot = clockSlotSchema.parse({ kind: 'fill', categoryId: BEDS_CATEGORY_ID });
  return { ...clock, slots: [...clock.slots, fill] };
}

export interface HardStartShow {
  slotId: string;
  time: string;
  durationMs: number;
  /** The episode file's length (its log slot). */
  episodeMs: number;
  startPolicy?: GeneratorOccurrence['startPolicy'];
}

export const HARD_START_SHOWS: readonly HardStartShow[] = [
  { slotId: uuid('8551', 1), time: '07:00', durationMs: 3_600_000, episodeMs: 3_540_000 },
  {
    slotId: uuid('8551', 2),
    time: '12:00',
    durationMs: 1_800_000,
    episodeMs: 1_790_000,
    startPolicy: { mode: 'soft', capMs: 30_000 },
  },
  { slotId: uuid('8551', 3), time: '18:30', durationMs: 1_800_000, episodeMs: 1_700_000 },
  { slotId: uuid('8551', 4), time: '21:00', durationMs: 7_200_000, episodeMs: 7_080_000 },
];

/** One occurrence of every show on each date, each with its own episode file. */
export function hardStartOccurrences(
  dates: readonly LocalDate[],
  shows: readonly HardStartShow[] = HARD_START_SHOWS,
): GeneratorOccurrence[] {
  let n = 0;
  return dates.flatMap((date) =>
    shows.map((show) => {
      n++;
      const asset = fixtureAsset(80_000 + n, {
        type: 'episode',
        durationMs: show.episodeMs,
        artists: [],
        album: null,
        overlapMs: 0,
        title: `Episode ${n}`,
      });
      return {
        slotId: show.slotId,
        showId: uuid('85a0', 1),
        showName: `Show ${show.time}`,
        type: 'prerecorded' as const,
        date,
        startsAt: zonedInstant(date, show.time, FIXTURE_TZ),
        durationMs: show.durationMs,
        special: false,
        episode: { id: uuid('8e91', n), title: `Episode ${n}`, asset },
        ...(show.startPolicy ? { startPolicy: show.startPolicy } : {}),
      };
    }),
  );
}

/** Consecutive dates from `first`. */
export function datesFrom(first: LocalDate, count: number): LocalDate[] {
  return Array.from({ length: count }, (_, i) => addDays(first, i));
}

export interface HardStartFixtureOptions {
  /** Give the clock a `fill` slot of beds (default true); without it, jingles fill. */
  beds?: boolean;
  songs?: number;
  seed?: string;
  /** Older airings for most songs (`fixtureSnapshot`'s `airedBefore`). */
  airedBefore?: Date;
  /** Default `HARD_START_SHOWS`. */
  shows?: readonly HardStartShow[];
}

export function hardStartSnapshot(
  dates: readonly LocalDate[],
  options: HardStartFixtureOptions = {},
): GeneratorSnapshot {
  const beds = options.beds ?? true;
  const base = fixtureSnapshot({
    songs: options.songs ?? 1_500,
    clocks: [beds ? hourClockWithFill() : hourClock()],
    occurrences: hardStartOccurrences(dates, options.shows),
    ...(options.seed ? { seed: options.seed } : {}),
    ...(options.airedBefore ? { airedBefore: options.airedBefore } : {}),
  });
  if (!beds) return base;
  const members = fixtureBeds();
  const category: GeneratorCategory = {
    id: BEDS_CATEGORY_ID,
    assetType: 'bed',
    rotationOrder: 'sequential',
    searchDepthPercent: 100,
    restMinutes: 0,
    maxPlaysPerDay: null,
    maxPlaysPerWeek: null,
    members,
  };
  return {
    ...base,
    categories: new Map([...base.categories, [BEDS_CATEGORY_ID, category]]),
    assets: new Map([...base.assets, ...members.map((m) => [m.id, m] as const)]),
  };
}

export { CATEGORY_IDS, FIXTURE_TZ, HOUR_CLOCK_ID };
