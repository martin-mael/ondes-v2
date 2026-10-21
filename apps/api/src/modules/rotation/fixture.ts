// Generated libraries and rules for the categories' integration tests and benchmark. Not for
// production code.
import { asset, assetTag, type Db, type StationScope, tag } from '@ondes/db';
import type {
  AssetType,
  CategoryMember,
  CategoryRule,
  RuleCondition,
  RuleGroup,
  TagKey,
} from '@ondes/shared';

/** Deterministic PRNG (mulberry32), so a failing case can be replayed from its seed. */
export function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)] as T;
  return { next, int, pick, chance: (p: number) => next() < p };
}
export type Rand = ReturnType<typeof prng>;

/** Tag vocabulary: mixed case, padding and non-numeric values that `tag_number` must skip. */
export const VOCABULARY: Partial<Record<TagKey, string[]>> = {
  style: ['House', 'techno', 'Ambient', 'disco', 'Électro'],
  energy: ['1', '2', ' 3 ', '4', '5', '2.5', 'low', '1e3', '-1'],
  mood: ['happy', 'Sad', 'dark', 'warm'],
  era: ['80s', '90s', '2000'],
};
const KEYS = Object.keys(VOCABULARY) as TagKey[];
const TYPES: AssetType[] = ['song', 'song', 'song', 'jingle', 'vt'];

/**
 * Inserts `count` assets with random tags, years, flags and start/kill windows, in batches,
 * straight into the tables (no audit: fixtures only). Returns the asset ids.
 */
export async function seedLibrary(
  db: Db,
  scope: StationScope,
  count: number,
  rand: Rand,
): Promise<string[]> {
  const owner = { orgId: scope.orgId, stationId: scope.stationId };
  const tags = await db
    .insert(tag)
    .values(
      KEYS.flatMap((key) => (VOCABULARY[key] ?? []).map((value) => ({ ...owner, key, value }))),
    )
    .returning({ id: tag.id, key: tag.key });
  const byKey = new Map<TagKey, string[]>();
  for (const t of tags) byKey.set(t.key, [...(byKey.get(t.key) ?? []), t.id]);

  const ids: string[] = [];
  const batch = 2000;
  for (let start = 0; start < count; start += batch) {
    const rows = Array.from({ length: Math.min(batch, count - start) }, (_, i) => {
      const n = start + i;
      const window = rand.int(10);
      return {
        ...owner,
        type: rand.pick(TYPES),
        title: `Title ${n}`,
        artists: rand.chance(0.9) ? [`Artist ${rand.int(count / 4 + 1)}`] : [],
        year: rand.chance(0.8) ? 1960 + rand.int(66) : null,
        explicit: rand.chance(0.1),
        durationMs: rand.chance(0.95) ? 120_000 + rand.int(240_000) : null,
        startAt: window === 0 ? new Date('2099-01-01T00:00:00Z') : null,
        killAt: window === 1 ? new Date('2020-01-01T00:00:00Z') : null,
      };
    });
    const inserted = await db.insert(asset).values(rows).returning({ id: asset.id });
    const links = inserted.flatMap(({ id }) => {
      ids.push(id);
      return KEYS.flatMap((key) => {
        const pool = byKey.get(key) ?? [];
        const chosen = new Set(Array.from({ length: rand.int(3) }, () => rand.pick(pool)));
        return [...chosen].map((tagId) => ({ ...owner, assetId: id, tagId }));
      });
    });
    for (let i = 0; i < links.length; i += 5000) {
      await db.insert(assetTag).values(links.slice(i, i + 5000));
    }
  }
  return ids;
}

function randomCondition(rand: Rand): RuleCondition {
  const key = rand.pick(KEYS);
  const values = VOCABULARY[key] ?? [];
  switch (rand.int(4)) {
    case 0:
    case 1:
      return {
        kind: 'tag',
        key,
        op: rand.pick(['any', 'all', 'none'] as const),
        // Case and padding differ from the stored values on purpose.
        values: Array.from({ length: 1 + rand.int(2) }, () => {
          const v = rand.pick(values).trim();
          return rand.chance(0.5) ? v.toUpperCase() : v;
        }),
      };
    case 2:
      return rand.chance(0.6)
        ? {
            kind: 'tag_number',
            key: 'energy',
            op: rand.pick(['eq', 'gte', 'gt', 'lte', 'lt'] as const),
            value: rand.pick([1, 2, 2.5, 3, 4, -1, 1000]),
          }
        : { kind: 'year', op: rand.pick(['eq', 'gte', 'lt'] as const), value: 1960 + rand.int(66) };
    default:
      return { kind: 'explicit', value: rand.chance(0.5) };
  }
}

/** A random rule, up to three groups deep. */
export function randomRule(rand: Rand, depth = 1): CategoryRule {
  const group: RuleGroup = {
    kind: 'group',
    match: rand.chance(0.5) ? 'all' : 'any',
    children: Array.from({ length: 1 + rand.int(3) }, () =>
      depth < 3 && rand.chance(0.3) ? randomRule(rand, depth + 1) : randomCondition(rand),
    ),
  };
  return group;
}

/** Random manual entries among `ids` (unique per asset). */
export function randomMembers(rand: Rand, ids: string[], count: number): CategoryMember[] {
  const chosen = new Set(Array.from({ length: count }, () => rand.pick(ids)));
  return [...chosen].map((assetId) => ({
    assetId,
    mode: rand.chance(0.5) ? 'include' : 'exclude',
  }));
}
