import {
  createOrganization,
  createStation,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import { resolveCategory } from '@ondes/scheduling';
import type { Actor, CategoryRule } from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prng, randomMembers, seedLibrary } from './fixture.ts';
import {
  createCategory,
  getCategory,
  listCategories,
  loadCandidates,
  previewCategory,
  previewDraft,
} from './repo.ts';

// Category reads on a 20k-asset library. Opt-in, it seeds for a while:
//   ROTATION_BENCH=1 pnpm vitest run -c vitest.integration.config.ts --project core rotation.bench
// Prints median timings; the bounds only catch a regression to whole-library loading.

const ASSETS = Number(process.env.ROTATION_BENCH_ASSETS ?? 20_000);
const RUNS = 7;
const system: Actor = { type: 'system', name: 'bench' };

let tdb: TestDatabase;
let scope: StationScope;
const categoryIds: string[] = [];

const rules: CategoryRule[] = [
  {
    kind: 'group',
    match: 'all',
    children: [
      { kind: 'tag', key: 'style', op: 'any', values: ['house', 'disco'] },
      { kind: 'tag_number', key: 'energy', op: 'gte', value: 3 },
    ],
  },
  {
    kind: 'group',
    match: 'any',
    children: [
      { kind: 'tag', key: 'mood', op: 'all', values: ['happy', 'warm'] },
      {
        kind: 'group',
        match: 'all',
        children: [
          { kind: 'year', op: 'lt', value: 1990 },
          { kind: 'tag', key: 'era', op: 'none', values: ['2000'] },
        ],
      },
    ],
  },
];

async function median(fn: () => Promise<unknown>): Promise<number> {
  await fn(); // warm-up
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return Math.round((times[Math.floor(RUNS / 2)] ?? 0) * 10) / 10;
}

describe.skipIf(!process.env.ROTATION_BENCH)(`category reads on ${ASSETS} assets`, () => {
  beforeAll(async () => {
    tdb = await createTestDatabase();
    const org = await createOrganization(tdb.db, system, { slug: 'bench-org', name: 'Org' });
    const orgScope = await resolveOrgScope(tdb.db, org.id);
    const st = await createStation(
      tdb.db,
      { actor: system, scope: orgScope },
      { slug: 'bench-fm', name: 'FM', timezone: 'Europe/Paris' },
    );
    scope = await resolveStationScope(tdb.db, org.id, st.id);
    const rand = prng(20_000);
    const ids = await seedLibrary(tdb.db, scope, ASSETS, rand);
    await tdb.db.execute('analyze');
    for (let i = 0; i < 10; i++) {
      const c = await createCategory(
        tdb.db,
        { actor: system, scope },
        {
          name: `Category ${i}`,
          rule: rules[i % rules.length] ?? null,
          members: randomMembers(rand, ids, 50),
        },
      );
      categoryIds.push(c.id);
    }
  }, 600_000);

  afterAll(() => tdb?.drop());

  it('reads from the database without loading the library', async () => {
    const id = categoryIds[0] as string;
    const draft = { rule: rules[1] as CategoryRule, members: [], limit: 50 };
    const timings = {
      'list (10 categories)': await median(() => listCategories(tdb.db, scope)),
      get: await median(() => getCategory(tdb.db, scope, id)),
      'preview (saved, 50 rows)': await median(() => previewCategory(tdb.db, scope, id, {})),
      'preview (draft, 50 rows)': await median(() => previewDraft(tdb.db, scope, draft)),
      'reference: load candidates + resolve': await median(async () =>
        resolveCategory(
          { assetType: 'song', rule: draft.rule, members: [] },
          await loadCandidates(tdb.db, scope),
          new Date(),
        ),
      ),
    };
    console.table(timings);
    expect(timings['preview (draft, 50 rows)']).toBeLessThan(1000);
    expect(timings['list (10 categories)']).toBeLessThan(1500);
  }, 120_000);
});
