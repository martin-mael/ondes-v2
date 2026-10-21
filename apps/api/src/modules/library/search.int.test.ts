import { randomBytes, randomUUID } from 'node:crypto';
import {
  addMembership,
  asRunEntry,
  auditLog,
  createAsset,
  createOrganization,
  createStation,
  type Db,
  episode,
  logDay,
  logItem,
  putAssetFile,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
  segue,
  setAnalysis,
  setAssetTags,
  setLoudness,
  show,
  stationEmergencyAsset,
  stationSafetyAsset,
  updateCues,
} from '@ondes/db';
import type {
  Actor,
  CreateAsset,
  LibraryFilter,
  LibrarySort,
  SetAssetTags,
  SortDirection,
} from '@ondes/shared';
import { contentKey } from '@ondes/storage';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, signUpAndLogin, type TestApp } from '../auth/testing.ts';
import { createCategory, getCategory } from '../rotation/repo.ts';
import { bulkEdit, type LibraryChangeEvent } from './search-bulk.ts';
import { assetActivity, libraryFacets, matchingIds, searchLibrary } from './search-repo.ts';

// Library search, facets and bulk edits (#23) against a throwaway database: results checked
// against hand-written expectations and against each other (facet counts = search counts),
// tenant isolation, audit rows, and the routes' permissions on the real app.

const system: Actor = { type: 'system', name: 'test' };
const user: Actor = { type: 'user', userId: '0199f6a0-0000-7000-8000-00000000000b' };

let t: TestApp;
let db: Db;
let n = 0;

beforeAll(async () => {
  t = await createTestApp();
  db = t.tdb.db;
});
afterAll(() => t?.close());

async function tenant() {
  n++;
  const org = await createOrganization(db, system, { slug: `search-org-${n}`, name: 'Org' });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: `search-fm-${n}`, name: 'FM', timezone: 'Europe/Paris' },
  );
  return { orgScope, scope: await resolveStationScope(db, org.id, st.id) };
}

const ctxOf = (scope: StationScope) => ({ actor: user, scope });

interface Seed extends CreateAsset {
  tags?: SetAssetTags['tags'];
  analysed?: boolean;
  bpm?: number;
  playedAt?: Date;
}

/** Creates assets through the repositories; `analysed` adds loudness, cues and peaks. */
async function seed(scope: StationScope, assets: Seed[]) {
  const ids: string[] = [];
  const ctx = { actor: system, scope };
  for (const { tags, analysed, bpm, playedAt, ...input } of assets) {
    const a = await createAsset(db, ctx, input);
    ids.push(a.id);
    if (tags) await setAssetTags(db, ctx, a.id, { tags });
    if (analysed) {
      const sha256 = randomBytes(32).toString('hex');
      await putAssetFile(db, ctx, a.id, {
        role: 'peaks',
        storageKey: contentKey({ orgId: scope.orgId, sha256, ext: 'peaks' }),
        sha256,
        sizeBytes: 10,
        codec: 'dat',
      });
      await setLoudness(db, ctx, a.id, {
        integratedLufs: -12,
        truePeakDbtp: -1.5,
        analyzer: 'ffmpeg-ebur128',
        analyzerVersion: '1',
      });
      await updateCues(db, ctx, a.id, { sampleRate: 44_100, cueIn: { samples: 100 } });
    }
    if (bpm !== undefined) {
      await setAnalysis(db, ctx, a.id, { bpm, analyzer: 'test', analyzerVersion: '1' });
    }
    if (playedAt) {
      await db.insert(asRunEntry).values({
        orgId: scope.orgId,
        stationId: scope.stationId,
        eventId: randomUUID(),
        bootId: 'boot',
        seq: ids.length,
        source: 'log',
        assetId: a.id,
        startedAt: playedAt,
      });
    }
  }
  return ids;
}

/** Every page of a search, following cursors. */
async function allPages(
  scope: StationScope,
  filter: LibraryFilter,
  sort: LibrarySort = 'added',
  direction: SortDirection = 'desc',
  limit = 2,
) {
  const items = [];
  let cursor: string | undefined;
  do {
    const page = await searchLibrary(db, scope, { filter, sort, direction, limit, cursor });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

const titles = async (scope: StationScope, filter: LibraryFilter) =>
  (await allPages(scope, filter, 'title', 'asc')).map((i) => i.title);

describe('library search', () => {
  let scope: StationScope;
  let other: StationScope;
  const now = new Date();

  beforeAll(async () => {
    ({ scope } = await tenant());
    ({ scope: other } = await tenant());
    await seed(scope, [
      {
        type: 'song',
        title: 'Été indien',
        artists: ['Joe Dassin'],
        album: 'Joe Dassin (Le Costume Blanc)',
        year: 1975,
        durationMs: 300_000,
        tags: [
          { key: 'genre', value: 'Chanson' },
          { key: 'mood', value: 'warm' },
        ],
        analysed: true,
        bpm: 92,
        playedAt: new Date(now.getTime() - 2 * 24 * 3600_000),
      },
      {
        type: 'song',
        title: 'One More Time',
        artists: ['Daft Punk'],
        album: 'Discovery',
        year: 2000,
        durationMs: 320_000,
        tags: [
          { key: 'genre', value: 'House' },
          { key: 'mood', value: 'happy' },
        ],
        analysed: true,
        bpm: 123,
        playedAt: new Date(now.getTime() - 40 * 24 * 3600_000),
      },
      {
        type: 'song',
        title: 'Around the World',
        artists: ['Daft Punk'],
        album: 'Homework',
        year: 1997,
        durationMs: 429_000,
        tags: [{ key: 'genre', value: 'house' }],
        bpm: 121,
      },
      {
        type: 'jingle',
        title: 'ID Vandale 100%_off',
        durationMs: 8_000,
        tags: [{ key: 'custom', value: 'station-id' }],
      },
      {
        type: 'song',
        title: 'Futur',
        artists: ['Nobody'],
        startAt: new Date('2099-01-01T00:00:00Z'),
        explicit: true,
      },
      {
        type: 'song',
        title: 'Passé',
        artists: [],
        killAt: new Date('2020-01-01T00:00:00Z'),
        tags: [{ key: 'genre', value: 'Soul' }],
      },
    ]);
    // Same words in another station: never visible from the first one.
    await seed(other, [
      { type: 'song', title: 'One More Time (other station)', artists: ['Daft Punk'] },
    ]);
  });

  it('matches words in titles, artists, albums and tags, ignoring case and accents', async () => {
    expect(await titles(scope, { q: 'ete' })).toEqual(['Été indien']);
    expect(await titles(scope, { q: 'DAFT' })).toEqual(['Around the World', 'One More Time']);
    expect(await titles(scope, { q: 'daft disco' })).toEqual(['One More Time']);
    expect(await titles(scope, { q: 'costume' })).toEqual(['Été indien']);
    expect(await titles(scope, { q: 'chanson' })).toEqual(['Été indien']);
    expect(await titles(scope, { q: 'station-id' })).toEqual(['ID Vandale 100%_off']);
    // `%` and `_` are literal.
    expect(await titles(scope, { q: '100%_' })).toEqual(['ID Vandale 100%_off']);
    expect(await titles(scope, { q: '0%x' })).toEqual([]);
    expect(await titles(scope, { q: 'daft nothing' })).toEqual([]);
  });

  it('filters by type, tags, flags, ranges and validity', async () => {
    expect(await titles(scope, { types: ['jingle'] })).toEqual(['ID Vandale 100%_off']);
    // Same key: any value. Case-insensitive.
    expect(
      await titles(scope, {
        tags: [
          { key: 'genre', value: 'HOUSE' },
          { key: 'genre', value: 'soul' },
        ],
      }),
    ).toEqual(['Around the World', 'One More Time', 'Passé']);
    // Different keys: all of them.
    expect(
      await titles(scope, {
        tags: [
          { key: 'genre', value: 'house' },
          { key: 'mood', value: 'happy' },
        ],
      }),
    ).toEqual(['One More Time']);
    expect(await titles(scope, { explicit: true })).toEqual(['Futur']);
    expect(await titles(scope, { year: { min: 1990, max: 1999 } })).toEqual(['Around the World']);
    expect(await titles(scope, { durationMs: { min: 310_000 } })).toEqual([
      'Around the World',
      'One More Time',
    ]);
    expect(await titles(scope, { bpm: { max: 122 } })).toEqual(['Around the World', 'Été indien']);
    expect(await titles(scope, { validity: ['future', 'expired'] })).toEqual(['Futur', 'Passé']);
    expect(await titles(scope, { addedAt: { min: new Date(now.getTime() + 3600_000) } })).toEqual(
      [],
    );
  });

  it('filters by analysis state and airplay', async () => {
    expect(await titles(scope, { analysis: ['complete'] })).toEqual([
      'Été indien',
      'One More Time',
    ]);
    expect((await titles(scope, { analysis: ['pending'] })).length).toBe(4);
    expect(await titles(scope, { neverPlayed: true, types: ['song'], q: 'daft' })).toEqual([
      'Around the World',
    ]);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 3600_000);
    expect(await titles(scope, { notPlayedSince: monthAgo, q: 'daft' })).toEqual([
      'Around the World',
      'One More Time',
    ]);
    expect(await titles(scope, { notPlayedSince: monthAgo, q: 'ete' })).toEqual([]);
  });

  it('returns the table columns', async () => {
    const [item] = (await searchLibrary(db, scope, { filter: { q: 'ete' } })).items;
    expect(item).toMatchObject({
      title: 'Été indien',
      analysis: { loudness: true, cues: true, peaks: true },
      integratedLufs: -12,
      bpm: 92,
      playoutGain: { source: 'measured' },
      tags: [
        { key: 'genre', value: 'Chanson' },
        { key: 'mood', value: 'warm' },
      ],
    });
    expect(item?.lastPlayedAt).toBeInstanceOf(Date);
  });

  it('pages every sort order with keyset cursors, in both directions', async () => {
    const all = await allPages(scope, {}, 'added', 'desc', 100);
    expect(all).toHaveLength(6);
    const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const key: Record<LibrarySort, (i: (typeof all)[number]) => string | number> = {
      added: (i) => i.id,
      title: (i) => fold(i.title),
      artist: (i) => fold(i.artists[0] ?? ''),
      album: (i) => fold(i.album ?? ''),
      year: (i) => i.year ?? 0,
      duration: (i) => i.durationMs ?? 0,
      bpm: (i) => i.bpm ?? 0,
    };
    for (const sort of Object.keys(key) as LibrarySort[]) {
      for (const direction of ['asc', 'desc'] as const) {
        const paged = await allPages(scope, {}, sort, direction, 2);
        // No row twice, none missing.
        expect(new Set(paged.map((i) => i.id)).size, `${sort} ${direction}`).toBe(6);
        // Sorted on the key, ties broken on the id, in the requested direction.
        const values = paged.map((i) => [key[sort](i), i.id] as const);
        for (let i = 1; i < values.length; i++) {
          const [a, aId] = values[i - 1] as readonly [string | number, string];
          const [b, bId] = values[i] as readonly [string | number, string];
          const cmp = typeof a === 'number' ? a - (b as number) : a < b ? -1 : a > b ? 1 : 0;
          const ordered = cmp !== 0 ? cmp : aId < bId ? -1 : 1;
          expect(direction === 'asc' ? ordered < 0 : ordered > 0, `${sort} ${direction}`).toBe(
            true,
          );
        }
      }
    }
  });

  it('refuses a cursor of another sort order', async () => {
    const page = await searchLibrary(db, scope, { sort: 'title', direction: 'asc', limit: 1 });
    await expect(
      searchLibrary(db, scope, { sort: 'year', limit: 1, cursor: page.nextCursor ?? '' }),
    ).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(searchLibrary(db, scope, { cursor: 'garbage' })).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
    // A well-formed cursor whose value isn't of the sort's type never reaches the SQL cast.
    const tampered = Buffer.from(
      JSON.stringify({ s: 'year', d: 'desc', v: "1'; drop table asset; --", id: randomUUID() }),
    ).toString('base64url');
    await expect(
      searchLibrary(db, scope, { sort: 'year', direction: 'desc', cursor: tampered }),
    ).rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it('counts facets like the search does, each without its own filter', async () => {
    const filter: LibraryFilter = {
      types: ['song'],
      tags: [{ key: 'genre', value: 'house' }],
      validity: ['active'],
    };
    const facets = await libraryFacets(db, scope, { filter });
    const count = async (f: LibraryFilter) => (await matchingIds(db, scope, f, 1000)).length;
    expect(facets.total).toBe(await count(filter));
    expect(facets.total).toBe(2);
    for (const { type, count: c } of facets.types) {
      expect(c, type).toBe(await count({ ...filter, types: [type] }));
    }
    for (const { state, count: c } of facets.analysis) {
      expect(c, state).toBe(await count({ ...filter, analysis: [state] }));
    }
    for (const { validity, count: c } of facets.validity) {
      expect(c, validity).toBe(await count({ ...filter, validity: [validity] }));
    }
    // Genre counts ignore the genre filter; other keys keep it.
    const genre = facets.tags.filter((g) => g.key === 'genre');
    expect(genre.map((g) => [g.value, g.count])).toEqual([
      ['House', 2],
      ['Chanson', 1],
    ]);
    expect(facets.tags.find((g) => g.key === 'mood' && g.value === 'happy')?.count).toBe(1);
    expect(facets.tags.find((g) => g.key === 'mood' && g.value === 'warm')).toBeUndefined();
  });

  it('never shows another station', async () => {
    const mine = await allPages(scope, { q: 'one more time' });
    expect(mine.map((i) => i.title)).toEqual(['One More Time']);
    const theirs = await allPages(other, {});
    expect(theirs.map((i) => i.title)).toEqual(['One More Time (other station)']);
    expect((await libraryFacets(db, other, {})).total).toBe(1);
    const theirId = theirs[0]?.id ?? '';
    await expect(assetActivity(db, scope, theirId)).rejects.toMatchObject({
      name: 'NotFoundError',
    });
  });

  it('reports airplay', async () => {
    const [id] = await matchingIds(db, scope, { q: 'ete' }, 1);
    const activity = await assetActivity(db, scope, id ?? '');
    expect(activity).toMatchObject({ plays7d: 1, plays30d: 1, cache: null });
  });
});

describe('library bulk edits', () => {
  async function auditRows(scope: StationScope, action: string) {
    return db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.stationId, scope.stationId), eq(auditLog.action, action)));
  }

  it('adds and removes tags, auditing each changed asset', async () => {
    const { scope } = await tenant();
    const ids = await seed(scope, [
      { type: 'song', title: 'A', tags: [{ key: 'genre', value: 'jazz' }] },
      { type: 'song', title: 'B', tags: [{ key: 'mood', value: 'Warm' }] },
      { type: 'song', title: 'C' },
    ]);
    const before = (await auditRows(scope, 'asset.tag')).length;
    const result = await bulkEdit(db, ctxOf(scope), {
      selection: { ids },
      action: {
        kind: 'tags',
        add: [{ key: 'mood', value: 'warm' }],
        remove: [{ key: 'genre', value: 'JAZZ' }],
      },
    });
    // B already had the tag (case-insensitive): unchanged.
    expect(result).toEqual({ matched: 3, changed: 2 });
    const items = await allPages(scope, {}, 'title', 'asc');
    expect(items.map((i) => i.tags.map((tg) => `${tg.key}:${tg.value}`))).toEqual([
      ['mood:Warm'],
      ['mood:Warm'],
      ['mood:Warm'],
    ]);
    const rows = await auditRows(scope, 'asset.tag');
    expect(rows.length - before).toBe(2);
    expect(rows.at(-1)).toMatchObject({ actorType: 'user', entityType: 'asset' });
    expect(rows.find((r) => r.entityId === ids[0] && r.actorType === 'user')?.diff).toEqual({
      tags: { from: ['genre:jazz'], to: ['mood:Warm'] },
    });
  });

  it('updates shared fields and refuses a kill date before a start date', async () => {
    const { scope } = await tenant();
    const ids = await seed(scope, [
      { type: 'song', title: 'A', startAt: new Date('2030-01-01T00:00:00Z') },
      { type: 'song', title: 'B', album: 'Same' },
    ]);
    const result = await bulkEdit(db, ctxOf(scope), {
      selection: { ids },
      action: { kind: 'update', patch: { album: 'Same', explicit: true } },
    });
    expect(result).toEqual({ matched: 2, changed: 2 });
    expect((await auditRows(scope, 'asset.update')).map((r) => r.diff)).toContainEqual({
      explicit: { from: false, to: true },
    });
    await expect(
      bulkEdit(db, ctxOf(scope), {
        selection: { ids },
        action: { kind: 'update', patch: { killAt: '2029-01-01T00:00:00Z' } },
      }),
    ).rejects.toMatchObject({ code: 'kill_before_start' });
    // Nothing changed.
    expect((await allPages(scope, { validity: ['expired'] })).length).toBe(0);
  });

  it('selects by filter only when the count still matches', async () => {
    const { scope } = await tenant();
    await seed(scope, [
      { type: 'jingle', title: 'J1' },
      { type: 'jingle', title: 'J2' },
      { type: 'song', title: 'S' },
    ]);
    const filter: LibraryFilter = { types: ['jingle'] };
    await expect(
      bulkEdit(db, ctxOf(scope), {
        selection: { filter, expectedCount: 3 },
        action: { kind: 'update', patch: { explicit: true } },
      }),
    ).rejects.toMatchObject({ code: 'selection_changed', details: { count: 2 } });
    const result = await bulkEdit(db, ctxOf(scope), {
      selection: { filter, expectedCount: 2 },
      action: { kind: 'update', patch: { explicit: true } },
    });
    expect(result).toEqual({ matched: 2, changed: 2 });
    expect(await titles(scope, { explicit: true })).toEqual(['J1', 'J2']);
  });

  it('deletes assets, releases their files and audits each one', async () => {
    const { scope } = await tenant();
    const ids = await seed(scope, [
      { type: 'song', title: 'A', analysed: true },
      { type: 'song', title: 'B' },
      { type: 'song', title: 'Keep' },
    ]);
    const result = await bulkEdit(db, ctxOf(scope), {
      selection: { ids: ids.slice(0, 2) },
      action: { kind: 'delete' },
    });
    expect(result).toEqual({ matched: 2, changed: 2 });
    expect(await titles(scope, {})).toEqual(['Keep']);
    expect((await auditRows(scope, 'asset.delete')).map((r) => r.entityId).sort()).toEqual(
      ids.slice(0, 2).sort(),
    );
    const [queued] = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from storage_deletion where org_id = ${scope.orgId}`,
    );
    expect(queued?.count).toBe(1);
  });

  it('refuses to delete assets something still needs, and says what', async () => {
    const { scope } = await tenant();
    const owner = { orgId: scope.orgId, stationId: scope.stationId };
    const [ep, safe, emergency, logged, voice, free] = (await seed(
      scope,
      ['episode', 'safety', 'emergency', 'logged', 'voice', 'free'].map((title) => ({
        type: 'song' as const,
        title,
      })),
    )) as [string, string, string, string, string, string];
    const [s1] = await db
      .insert(show)
      .values({ ...owner, name: 'Show' })
      .returning();
    const [e1] = await db
      .insert(episode)
      .values({
        ...owner,
        showId: s1?.id ?? '',
        number: 1,
        kind: 'prerecorded',
        assetId: ep,
        status: 'ready',
      })
      .returning();
    await db.insert(stationSafetyAsset).values({ ...owner, assetId: safe });
    await db.insert(stationEmergencyAsset).values({ ...owner, assetId: emergency });
    const soon = new Date(Date.now() + 3600_000);
    const [day] = await db
      .insert(logDay)
      .values({
        ...owner,
        localDate: '2099-01-01',
        startsAt: soon,
        endsAt: new Date(soon.getTime() + 86_400_000),
      })
      .returning();
    const [item] = await db
      .insert(logItem)
      .values({
        ...owner,
        logDayId: day?.id ?? '',
        position: 0,
        kind: 'song',
        plannedStart: soon,
        plannedDurationMs: 1000,
        assetId: logged,
        originType: 'manual',
      })
      .returning();
    // A voice recorded into a segue's lanes (#55).
    const [vt] = await db
      .insert(segue)
      .values({
        ...owner,
        outLane: { envelope: [] },
        inLane: { start: 0, envelope: [] },
        voices: [{ assetId: voice, start: 0, gainDb: 0, envelope: [] }],
      })
      .returning();

    const refusal = await bulkEdit(db, ctxOf(scope), {
      selection: { ids: [ep, safe, emergency, logged, voice, free] },
      action: { kind: 'delete' },
    }).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: 'asset_in_use' });
    const usages = (refusal as { details: { usages: unknown[] } }).details.usages;
    expect(usages).toEqual(
      expect.arrayContaining([
        { assetId: ep, kind: 'episode', usedBy: e1?.id },
        { assetId: safe, kind: 'safety_playlist', usedBy: scope.stationId },
        { assetId: emergency, kind: 'emergency_file', usedBy: scope.stationId },
        { assetId: logged, kind: 'log_item', usedBy: item?.id },
        { assetId: voice, kind: 'segue_voice', usedBy: vt?.id },
      ]),
    );
    expect(usages).toHaveLength(5);
    // Nothing was deleted, not even the free one.
    expect((await allPages(scope, {})).length).toBe(6);
    // An aired episode no longer holds its audio.
    await db
      .update(episode)
      .set({ status: 'aired' })
      .where(eq(episode.id, e1?.id ?? ''));
    expect(
      await bulkEdit(db, ctxOf(scope), {
        selection: { ids: [ep, free] },
        action: { kind: 'delete' },
      }),
    ).toEqual({ matched: 2, changed: 2 });
  });

  it('announces deletes and playout changes after the commit', async () => {
    const { scope } = await tenant();
    const ids = await seed(scope, [
      { type: 'song', title: 'A' },
      { type: 'song', title: 'B', gainOverrideDb: -3 },
    ]);
    const events: LibraryChangeEvent[] = [];
    const deps = {
      db,
      publish: async (e: LibraryChangeEvent) => {
        events.push(e);
      },
    };
    await bulkEdit(deps, ctxOf(scope), {
      selection: { ids },
      action: { kind: 'update', patch: { gainOverrideDb: -3, album: 'X' } },
    });
    // Only A's gain changed.
    expect(events).toEqual([
      { type: 'asset.updated', data: { assetId: ids[0], changes: ['settings'] } },
    ]);
    await bulkEdit(deps, ctxOf(scope), {
      selection: { ids },
      action: { kind: 'tags', add: [{ key: 'mood', value: 'x' }] },
    });
    expect(events).toHaveLength(1);
    await bulkEdit(deps, ctxOf(scope), { selection: { ids }, action: { kind: 'delete' } });
    expect(events.slice(1)).toEqual(
      ids.map((assetId) => ({ type: 'asset.deleted', data: { assetId } })),
    );
  });

  it("includes, excludes and removes the selection in a category's manual list", async () => {
    const { scope } = await tenant();
    const ids = (await seed(scope, [
      { type: 'song', title: 'A' },
      { type: 'song', title: 'B' },
      { type: 'song', title: 'C' },
    ])) as [string, string, string];
    const category = await createCategory(db, ctxOf(scope), {
      name: 'Hits',
      members: [{ assetId: ids[2], mode: 'include' }],
    });
    const run = (mode: 'include' | 'exclude' | 'remove', selected: string[]) =>
      bulkEdit(db, ctxOf(scope), {
        selection: { ids: selected },
        action: { kind: 'category', categoryId: category.id, mode },
      });
    const members = async () =>
      (await getCategory(db, scope, category.id)).members
        .map((m) => `${m.assetId}:${m.mode}`)
        .sort();
    expect(await run('include', ids)).toEqual({ matched: 3, changed: 2 });
    // C was already included: unchanged.
    expect(await members()).toEqual(
      [`${ids[0]}:include`, `${ids[1]}:include`, `${ids[2]}:include`].sort(),
    );
    expect(await run('exclude', [ids[0]])).toEqual({ matched: 1, changed: 1 });
    expect(await run('remove', [ids[1], ids[2]])).toEqual({ matched: 2, changed: 2 });
    expect(await members()).toEqual([`${ids[0]}:exclude`]);
    expect(await auditRows(scope, 'category.update')).toHaveLength(3);
  });

  it("ignores another station's assets", async () => {
    const { scope } = await tenant();
    const { scope: other } = await tenant();
    const [theirs] = await seed(other, [{ type: 'song', title: 'Theirs' }]);
    const result = await bulkEdit(db, ctxOf(scope), {
      selection: { ids: [theirs ?? ''] },
      action: { kind: 'delete' },
    });
    expect(result).toEqual({ matched: 0, changed: 0 });
    expect(await titles(other, {})).toEqual(['Theirs']);
  });
});

describe('library search routes', () => {
  it('lets readers search and writers bulk edit', async () => {
    const { orgScope, scope } = await tenant();
    const [id] = await seed(scope, [{ type: 'song', title: 'Routed' }]);
    const cookies: Record<string, string> = {};
    for (const role of ['programmer', 'presenter'] as const) {
      const { userId, cookie } = await signUpAndLogin(t, `${role}-${n}@search.test`);
      await addMembership(
        db,
        { actor: system, scope: orgScope },
        { level: 'station', stationId: scope.stationId, userId, role },
      );
      cookies[role] = cookie;
    }
    const outsider = (await signUpAndLogin(t, `outsider-${n}@search.test`)).cookie;
    const call = (cookie: string, method: 'GET' | 'POST', url: string, payload?: object) =>
      t.app.inject({
        method,
        url: `/api/v1/stations/${scope.stationId}/library${url}`,
        cookies: { ondes_session: cookie },
        ...(payload ? { payload } : {}),
      });

    const search = await call(cookies.presenter ?? '', 'POST', '/search', {
      filter: { q: 'rout' },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().items).toHaveLength(1);
    expect((await call(cookies.presenter ?? '', 'POST', '/facets', {})).json().total).toBe(1);
    expect((await call(cookies.presenter ?? '', 'GET', `/assets/${id}/activity`)).statusCode).toBe(
      200,
    );
    const bulk = { selection: { ids: [id] }, action: { kind: 'update', patch: { year: 2001 } } };
    expect((await call(cookies.presenter ?? '', 'POST', '/bulk', bulk)).statusCode).toBe(403);
    const ok = await call(cookies.programmer ?? '', 'POST', '/bulk', bulk);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ matched: 1, changed: 1 });
    expect((await call(outsider, 'POST', '/search', {})).statusCode).toBe(404);
    // The single-asset delete applies the same in-use rule.
    await db
      .insert(stationSafetyAsset)
      .values({ orgId: scope.orgId, stationId: scope.stationId, assetId: id ?? '' });
    const remove = (assetId: string) =>
      t.app.inject({
        method: 'DELETE',
        url: `/api/v1/stations/${scope.stationId}/assets/${assetId}`,
        cookies: { ondes_session: cookies.programmer ?? '' },
      });
    const refused = await remove(id ?? '');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'asset_in_use' });
    expect((await remove(randomUUID())).statusCode).toBe(404);
    const invalid = await call(cookies.programmer ?? '', 'POST', '/bulk', {
      selection: { ids: [id] },
      action: { kind: 'tags', add: [], remove: [] },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
