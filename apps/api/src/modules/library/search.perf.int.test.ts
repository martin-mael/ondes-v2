import { readFileSync } from 'node:fs';
import {
  createOrganization,
  createStation,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import type { Actor, LibrarySearch } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prng, seedLibrary } from '../rotation/fixture.ts';
import { bulkEdit } from './search-bulk.ts';
import { libraryFacets, matchingIds, searchLibrary } from './search-repo.ts';
import { compileFilter, filterSql, sortSql } from './search-sql.ts';

// Library search on a large station (#23). Runs on 10k assets by default (CI); for the
// figures in the PR, on 50k:
//   LIBRARY_PERF_ASSETS=50000 pnpm vitest run -c vitest.integration.config.ts --project core search.perf
// Prints median timings. The bounds are loose: they catch a regression to scanning or
// loading the library, not a few milliseconds.

const ASSETS = Number(process.env.LIBRARY_PERF_ASSETS ?? 10_000);
const RUNS = 7;
const system: Actor = { type: 'system', name: 'perf' };

let tdb: TestDatabase;
let scope: StationScope;
let ids: string[];

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

describe(`library search on ${ASSETS} assets`, () => {
  beforeAll(async () => {
    tdb = await createTestDatabase();
    const org = await createOrganization(tdb.db, system, { slug: 'perf-org', name: 'Org' });
    const orgScope = await resolveOrgScope(tdb.db, org.id);
    const st = await createStation(
      tdb.db,
      { actor: system, scope: orgScope },
      { slug: 'perf-fm', name: 'FM', timezone: 'Europe/Paris' },
    );
    scope = await resolveStationScope(tdb.db, org.id, st.id);
    ids = await seedLibrary(tdb.db, scope, ASSETS, prng(23));
    // Analysis results for most assets, airplay for some: straight inserts (fixture only).
    const { orgId, stationId } = scope;
    await tdb.db.execute(sql`insert into asset_loudness
      (asset_id, org_id, station_id, integrated_lufs, true_peak_dbtp, analyzer, analyzer_version)
      select id, org_id, station_id, -20 + random() * 10, -1, 'perf', '1' from asset
      where station_id = ${stationId} and random() < 0.8`);
    await tdb.db.execute(sql`insert into asset_cues (asset_id, org_id, station_id, sample_rate, cue_in)
      select id, org_id, station_id, 44100, 0 from asset
      where station_id = ${stationId} and random() < 0.7`);
    await tdb.db.execute(sql`insert into asset_analysis (asset_id, org_id, station_id, bpm, analyzer, analyzer_version)
      select id, org_id, station_id, 70 + floor(random() * 100), 'perf', '1' from asset
      where station_id = ${stationId} and random() < 0.6`);
    await tdb.db.execute(sql`insert into asset_file
      (asset_id, org_id, station_id, role, storage_key, sha256, size_bytes, codec)
      select id, org_id, station_id, 'peaks', 'org/' || org_id || '/peaks/' || id, md5(id::text) || md5(id::text), 1, 'dat'
      from asset where station_id = ${stationId} and random() < 0.75`);
    await tdb.db.execute(sql`insert into asrun_entry
      (org_id, station_id, event_id, boot_id, seq, source, asset_id, started_at)
      select ${orgId}::uuid, ${stationId}::uuid, uuidv7(), 'perf', row_number() over (), 'log', id,
        now() - random() * interval '60 days'
      from asset, generate_series(1, 3) where station_id = ${stationId} and random() < 0.3`);
    await tdb.db.execute('analyze');
  }, 600_000);

  afterAll(() => tdb?.drop());

  const search = (input: LibrarySearch) => searchLibrary(tdb.db, scope, input);

  it('serves pages, searches and facets without scanning the library', async () => {
    // Page 30 of the title order, 100 rows each.
    let cursor: string | undefined;
    for (let i = 0; i < 29; i++) {
      cursor = (await search({ sort: 'title', direction: 'asc', cursor })).nextCursor ?? undefined;
    }
    const tags = [
      { key: 'style', value: 'house' },
      { key: 'style', value: 'disco' },
      { key: 'mood', value: 'dark' },
    ] as const;
    const timings = {
      'first page (added)': await median(() => search({})),
      'first page (title)': await median(() => search({ sort: 'title', direction: 'asc' })),
      'page 30 (title, keyset)': await median(() =>
        search({ sort: 'title', direction: 'asc', cursor }),
      ),
      'first page (bpm desc)': await median(() => search({ sort: 'bpm' })),
      'search "4242"': await median(() => search({ filter: { q: '4242' } })),
      'search "artist 12"': await median(() => search({ filter: { q: 'artist 12' } })),
      'search "ti" (short word)': await median(() => search({ filter: { q: 'ti' } })),
      'tags style:house|disco + mood:dark': await median(() =>
        search({ filter: { tags: [...tags] } }),
      ),
      'analysis pending + not played 30 d': await median(() =>
        search({
          filter: {
            analysis: ['pending'],
            notPlayedSince: new Date(Date.now() - 30 * 24 * 3600_000),
          },
        }),
      ),
      'facets (no filter)': await median(() => libraryFacets(tdb.db, scope, {})),
      'facets (q + tags + type)': await median(() =>
        libraryFacets(tdb.db, scope, {
          filter: { q: 'artist 1', tags: [...tags], types: ['song'] },
        }),
      ),
      'all matching ids (select all)': await median(() =>
        matchingIds(tdb.db, scope, { types: ['song'] }, 10_001),
      ),
      'bulk: tag 1000 assets': await median(() =>
        bulkEdit(
          tdb.db,
          { actor: system, scope },
          {
            selection: { ids: ids.slice(0, 1000) },
            action: { kind: 'tags', add: [{ key: 'custom', value: `perf` }], remove: [] },
          },
        ),
      ),
    };
    console.table(timings);
    for (const [name, ms] of Object.entries(timings)) {
      const bound = name.startsWith('bulk')
        ? 5_000
        : name.startsWith('all matching')
          ? 1_500
          : 1_000;
      expect(ms, name).toBeLessThan(bound);
    }
  }, 600_000);

  // What the migration costs on a populated library: each CREATE INDEX holds a SHARE lock on
  // its table (writes wait) while it builds. Rebuilt here from the migration's own statements.
  it('builds the search indexes in seconds (migration lock time)', async () => {
    const file = readFileSync(
      new URL(
        '../../../../../packages/db/migrations/20261021145106_library-search.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const statements = file
      .split('--> statement-breakpoint')
      .map((s) => s.replace(/^--.*$/gm, '').trim())
      .filter((s) => s.startsWith('CREATE INDEX'));
    const timings: Record<string, number> = {};
    for (const statement of statements) {
      const name = statement.match(/EXISTS (\w+)/)?.[1] ?? statement;
      await tdb.db.execute(sql.raw(`drop index ${name}`));
      const start = performance.now();
      await tdb.db.execute(sql.raw(statement));
      timings[name] = Math.round(performance.now() - start);
    }
    console.table(timings);
    const total = Object.values(timings).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(60_000);
  }, 120_000);

  // The planner may prefer a scan on a small fixture; with scans priced out, a plan that still
  // scans means the query's expressions no longer match the indexed ones.
  it('can use the trigram and sort indexes', async () => {
    const plan = (query: ReturnType<typeof sql>) =>
      tdb.db.transaction(async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`);
        const rows = (await tx.execute(sql`explain ${query}`)) as unknown as {
          'QUERY PLAN': string;
        }[];
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      });
    const where = filterSql(compileFilter(scope, { q: '4242' }, new Date()));
    expect(await plan(sql`select id from asset where ${where} limit 100`)).toContain(
      'asset_search_trgm_idx',
    );
    const sort = sortSql('title', 'asc', undefined);
    const all = filterSql(compileFilter(scope, {}, new Date()));
    expect(
      await plan(sql`select id from asset where ${all} order by ${sort.orderBy} limit 100`),
    ).toContain('asset_station_title_sort_idx');
  });
});
