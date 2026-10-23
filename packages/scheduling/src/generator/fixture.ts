import {
  type ClockSlot,
  clockSlotSchema,
  DEFAULT_ROTATION_RULES,
  type RotationRule,
} from '@ondes/shared';
import type { ClockGrid } from '../grid/index.ts';
import { randomFor } from '../rules/random.ts';
import type {
  GeneratorAsset,
  GeneratorCategory,
  GeneratorClock,
  GeneratorOccurrence,
  GeneratorSnapshot,
} from './types.ts';

// A synthetic station for the generator's tests and benchmark: a library of any size, three
// music categories and a jingle category, an hour clock on every hour. Deterministic.

export const FIXTURE_TZ = 'Europe/Paris';
export const FIXTURE_STATION = '00000000-0000-7000-8000-0000000000a1';

const uuid = (prefix: string, n: number) =>
  `00000000-0000-7000-${prefix}-${String(n).padStart(12, '0')}`;

export const CATEGORY_IDS = {
  current: uuid('8c01', 1),
  recurrent: uuid('8c01', 2),
  gold: uuid('8c01', 3),
  jingles: uuid('8c01', 4),
} as const;

export const HOUR_CLOCK_ID = uuid('8c10', 1);

export function fixtureAsset(
  n: number,
  overrides: Partial<GeneratorAsset> = {},
  seed = 'fixture',
): GeneratorAsset {
  const r = (key: string) => randomFor(seed, `${n}:${key}`);
  const artistPool = overrides.type === 'jingle' ? 1 : 2_500;
  const artist = Math.floor(r('artist') * artistPool);
  return {
    id: uuid('8a55', n),
    type: 'song',
    year: 1970 + Math.floor(r('year') * 56),
    explicit: false,
    durationMs: 150_000 + Math.floor(r('length') * 180_000),
    startAt: null,
    killAt: null,
    addedAt: new Date('2026-01-01T00:00:00Z'),
    tags: [{ key: 'style', value: ['house', 'rock', 'jazz', 'hip-hop'][n % 4] as string }],
    title: `Song ${n}`,
    artists: [`Artist ${artist}`],
    album: `Album ${Math.floor(artist * 3 + r('album') * 3)}`,
    playMs: null,
    overlapMs: Math.floor(r('overlap') * 6_000),
    ...overrides,
  };
}

/** `songs` songs split 25/35/40 into current, recurrent, gold, plus 12 jingles. */
export function fixtureLibrary(songs: number, seed = 'fixture') {
  const library = Array.from({ length: songs }, (_, i) => fixtureAsset(i + 1, {}, seed));
  const jingles = Array.from({ length: 12 }, (_, i) =>
    fixtureAsset(songs + i + 1, {
      type: 'jingle',
      durationMs: 5_000 + i * 700,
      artists: [],
      album: null,
      overlapMs: 0,
      title: `Jingle ${i + 1}`,
    }),
  );
  const category = (
    id: string,
    members: GeneratorAsset[],
    extra: Partial<GeneratorCategory> = {},
  ): GeneratorCategory => ({
    id,
    assetType: members[0]?.type ?? 'song',
    rotationOrder: 'least_recently_played',
    searchDepthPercent: 30,
    restMinutes: 24 * 60,
    maxPlaysPerDay: 2,
    maxPlaysPerWeek: null,
    members,
    ...extra,
  });
  const a = Math.floor(songs * 0.25);
  const b = Math.floor(songs * 0.6);
  const categories = new Map<string, GeneratorCategory>([
    [
      CATEGORY_IDS.current,
      category(CATEGORY_IDS.current, library.slice(0, a), { restMinutes: 180 }),
    ],
    [CATEGORY_IDS.recurrent, category(CATEGORY_IDS.recurrent, library.slice(a, b))],
    [
      CATEGORY_IDS.gold,
      category(CATEGORY_IDS.gold, library.slice(b), { rotationOrder: 'weighted_random' }),
    ],
    [
      CATEGORY_IDS.jingles,
      category(CATEGORY_IDS.jingles, jingles, {
        assetType: 'jingle',
        rotationOrder: 'sequential',
        searchDepthPercent: 100,
        restMinutes: 0,
        maxPlaysPerDay: null,
      }),
    ],
  ]);
  return { library, jingles, categories };
}

const slot = (input: Record<string, unknown>): ClockSlot => clockSlotSchema.parse(input);

/** An hour: a hard top-of-hour marker, a jingle, then 15 music slots with a jingle at :30. */
export function hourClock(id = HOUR_CLOCK_ID): GeneratorClock {
  const music = [
    CATEGORY_IDS.current,
    CATEGORY_IDS.gold,
    CATEGORY_IDS.recurrent,
    CATEGORY_IDS.current,
    CATEGORY_IDS.gold,
    CATEGORY_IDS.recurrent,
    CATEGORY_IDS.current,
  ];
  return {
    id,
    targetDurationMs: 3_600_000,
    slots: [
      slot({ kind: 'marker', offsetMs: 0, timing: 'soft', capMs: 60_000, label: 'Top of hour' }),
      slot({ kind: 'jingle', categoryId: CATEGORY_IDS.jingles }),
      ...music.map((categoryId) => slot({ kind: 'category', categoryId })),
      slot({ kind: 'jingle', categoryId: CATEGORY_IDS.jingles }),
      ...music.map((categoryId) => slot({ kind: 'category', categoryId })),
      slot({ kind: 'category', categoryId: CATEGORY_IDS.gold }),
    ],
  };
}

export interface FixtureOptions {
  songs?: number;
  rules?: RotationRule[];
  grid?: ClockGrid;
  clocks?: GeneratorClock[];
  occurrences?: GeneratorOccurrence[];
  seed?: string;
  /**
   * Give most songs an older airing, up to 60 days before this instant, as a station that has
   * been on air has (`lastPlayedAt`): rotation then orders every member by time.
   */
  airedBefore?: Date;
}

export function fixtureSnapshot(options: FixtureOptions = {}): GeneratorSnapshot {
  const { categories, library, jingles } = fixtureLibrary(options.songs ?? 2_000, options.seed);
  const clocks = options.clocks ?? [hourClock()];
  return {
    stationId: FIXTURE_STATION,
    timeZone: FIXTURE_TZ,
    grid: options.grid ?? { defaultClockId: HOUR_CLOCK_ID, cells: [], overrides: [] },
    clocks: new Map(clocks.map((c) => [c.id, c])),
    categories,
    assets: new Map([...library, ...jingles].map((a) => [a.id, a])),
    rules: options.rules ?? DEFAULT_ROTATION_RULES,
    history: [],
    occurrences: options.occurrences ?? [],
    ...(options.airedBefore ? { lastPlayedAt: olderAirings(library, options.airedBefore) } : {}),
  };
}

/** 90 % of the songs aired once in the 60 days before `before`. */
function olderAirings(library: readonly GeneratorAsset[], before: Date): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const asset of library) {
    const r = randomFor('aired', asset.id);
    if (r < 0.9)
      out.set(asset.id, new Date(before.getTime() - Math.ceil((r / 0.9) * 60 * 86_400_000)));
  }
  return out;
}
