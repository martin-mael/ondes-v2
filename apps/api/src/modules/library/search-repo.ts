import {
  asRunEntry,
  asset,
  assetAnalysis,
  assetCues,
  assetFile,
  assetLoudness,
  assetTag,
  type Executor,
  getAsset,
  getStation,
  playoutCacheFile,
  type StationScope,
  tag,
  whereStation,
} from '@ondes/db';
import {
  ANALYSIS_STATES,
  type AnalysisState,
  type AssetActivity,
  type AssetType,
  FACET_TAGS_PER_KEY,
  getPlayoutGain,
  type LibraryFacets,
  type LibraryFacetsQuery,
  type LibraryItem,
  type LibrarySearch,
  type LibrarySearchPage,
  libraryFacetsQuerySchema,
  librarySearchSchema,
  type ParsedLibraryFilter,
  type Tag,
  type TagKey,
  VALIDITIES,
  type Validity,
} from '@ondes/shared';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { HttpError } from '../../plugins/errors.ts';
import {
  compileFilter,
  type FacetRow,
  facetsSql,
  filterSql,
  type Keyset,
  sortSql,
} from './search-sql.ts';

// Library search (#23): keyset pages of the station's assets with what the library table
// shows, facet counts, matching ids for bulk edits, and an asset's airplay and cache state.

// --- Cursors -----------------------------------------------------------------------------

const cursorSchema = z.object({
  s: z.string(),
  d: z.enum(['asc', 'desc']),
  v: z.string().nullable(),
  id: z.uuid(),
});

/** Opaque to clients: the sort it belongs to and the last row's sort value and id. */
export function encodeCursor(sort: string, direction: string, keyset: Keyset): string {
  const json = JSON.stringify({ s: sort, d: direction, v: keyset.value, id: keyset.id });
  return Buffer.from(json).toString('base64url');
}

function decodeCursor(cursor: string, sort: string, direction: string): Keyset {
  let parsed: z.infer<typeof cursorSchema>;
  try {
    parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
  } catch {
    throw new HttpError(400, 'invalid_cursor', 'invalid cursor');
  }
  if (parsed.s !== sort || parsed.d !== direction) {
    throw new HttpError(400, 'invalid_cursor', 'the cursor belongs to another sort order');
  }
  return { value: parsed.v, id: parsed.id };
}

// --- Search ------------------------------------------------------------------------------

/**
 * One page of the library. The page's ids come from one indexed query (filter, keyset, sort,
 * limit); the table columns (tags, analysis, loudness, last airing) are then read for those
 * rows only.
 */
export async function searchLibrary(
  db: Executor,
  scope: StationScope,
  input: LibrarySearch,
  at = new Date(),
): Promise<LibrarySearchPage> {
  const q = librarySearchSchema.parse(input);
  const after = q.cursor ? decodeCursor(q.cursor, q.sort, q.direction) : undefined;
  const sort = sortSql(q.sort, q.direction, after);
  const where = filterSql(compileFilter(scope, q.filter, at));
  const rows = await db
    .select({ id: asset.id, value: sort.value })
    .from(asset)
    .where(sort.after ? and(where, sort.after) : where)
    .orderBy(sort.orderBy)
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const items = await libraryItems(
    db,
    scope,
    page.map((r) => r.id),
  );
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      rows.length > q.limit && last
        ? encodeCursor(q.sort, q.direction, { value: last.value, id: last.id })
        : null,
  };
}

/** `"{a,b}"::uuid[]`: one parameter, however many ids. */
export const uuidArray = (ids: readonly string[]): SQL => sql`${`{${ids.join(',')}}`}::uuid[]`;

/** The table rows of these assets, in the order given. */
export async function libraryItems(
  db: Executor,
  scope: StationScope,
  ids: string[],
): Promise<LibraryItem[]> {
  if (ids.length === 0) return [];
  const [rows, station] = await Promise.all([
    db
      .select({
        asset,
        integratedLufs: assetLoudness.integratedLufs,
        truePeakDbtp: assetLoudness.truePeakDbtp,
        bpm: assetAnalysis.bpm,
        musicalKey: assetAnalysis.musicalKey,
        cues: sql<boolean>`${assetCues.assetId} is not null`,
        peaks: sql<boolean>`exists (select 1 from ${assetFile}
          where ${assetFile.assetId} = ${asset.id} and ${assetFile.role} = 'peaks')`,
        lastPlayedAt: sql<Date | null>`(select max(${asRunEntry.startedAt}) from ${asRunEntry}
          where ${asRunEntry.stationId} = ${scope.stationId} and ${asRunEntry.assetId} = ${asset.id})`.mapWith(
          asRunEntry.startedAt,
        ),
        tags: sql<Tag[]>`coalesce((select json_agg(json_build_object(
            'id', ${tag.id}, 'key', ${tag.key}, 'value', ${tag.value})
            order by ${tag.key}, lower(${tag.value}))
          from ${assetTag} join ${tag} on ${tag.id} = ${assetTag.tagId}
          where ${assetTag.assetId} = ${asset.id}), '[]'::json)`.mapWith(parseJson),
      })
      .from(asset)
      .leftJoin(assetLoudness, eq(assetLoudness.assetId, asset.id))
      .leftJoin(assetAnalysis, eq(assetAnalysis.assetId, asset.id))
      .leftJoin(assetCues, eq(assetCues.assetId, asset.id))
      .where(and(whereStation(asset, scope), sql`${asset.id} = any(${uuidArray(ids)})`)),
    getStation(db, scope, scope.stationId),
  ]);
  const byId = new Map(
    rows.map((row) => {
      const loudness =
        row.integratedLufs === null
          ? null
          : { integratedLufs: row.integratedLufs, truePeakDbtp: row.truePeakDbtp };
      const item: LibraryItem = {
        ...row.asset,
        tags: row.tags,
        analysis: { loudness: loudness !== null, cues: row.cues, peaks: row.peaks },
        integratedLufs: row.integratedLufs,
        playoutGain: getPlayoutGain({ ...row.asset, loudness }, station),
        bpm: row.bpm,
        musicalKey: row.musicalKey,
        lastPlayedAt: row.lastPlayedAt ?? null,
      };
      return [row.asset.id, item];
    }),
  );
  return ids.flatMap((id) => byId.get(id) ?? []);
}

function parseJson(value: unknown): Tag[] {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Tag[];
}

/**
 * Ids of every asset matching `filter`, oldest first, at most `limit`. Bulk edits on "all
 * matching" use it; callers pass one more than they accept to detect an overflow.
 */
export async function matchingIds(
  db: Executor,
  scope: StationScope,
  filter: ParsedLibraryFilter,
  limit: number,
  at = new Date(),
): Promise<string[]> {
  const rows = await db
    .select({ id: asset.id })
    .from(asset)
    .where(filterSql(compileFilter(scope, filter, at)))
    .orderBy(asset.id)
    .limit(limit);
  return rows.map((r) => r.id);
}

// --- Facets ------------------------------------------------------------------------------

export async function libraryFacets(
  db: Executor,
  scope: StationScope,
  input: LibraryFacetsQuery,
  at = new Date(),
): Promise<LibraryFacets> {
  const { filter } = libraryFacetsQuerySchema.parse(input);
  const rows = (await db.execute(
    facetsSql(scope, compileFilter(scope, filter, at), at),
  )) as unknown as FacetRow[];
  const facets: LibraryFacets = { total: 0, types: [], tags: [], analysis: [], validity: [] };
  const analysis = new Map<string, number>();
  const validity = new Map<string, number>();
  for (const row of rows) {
    const count = Number(row.count);
    switch (row.facet) {
      case 'total':
        facets.total = count;
        break;
      case 'type':
        facets.types.push({ type: row.key as AssetType, count });
        break;
      case 'analysis':
        analysis.set(row.key ?? '', count);
        break;
      case 'validity':
        validity.set(row.key ?? '', count);
        break;
      case 'tag':
        facets.tags.push({
          id: row.id ?? '',
          key: row.key as TagKey,
          value: row.value ?? '',
          count,
        });
        break;
    }
  }
  facets.types.sort((a, b) => b.count - a.count);
  facets.analysis = ANALYSIS_STATES.map((state: AnalysisState) => ({
    state,
    count: analysis.get(state) ?? 0,
  }));
  facets.validity = VALIDITIES.map((v: Validity) => ({ validity: v, count: validity.get(v) ?? 0 }));
  facets.tags = topTagsPerKey(facets.tags);
  return facets;
}

/** By key, then count (desc) and value; at most {@link FACET_TAGS_PER_KEY} per key. */
function topTagsPerKey(tags: LibraryFacets['tags']): LibraryFacets['tags'] {
  const sorted = [...tags].sort(
    (a, b) =>
      a.key.localeCompare(b.key) || b.count - a.count || a.value.localeCompare(b.value, 'fr'),
  );
  const seen = new Map<string, number>();
  return sorted.filter((t) => {
    const n = (seen.get(t.key) ?? 0) + 1;
    seen.set(t.key, n);
    return n <= FACET_TAGS_PER_KEY;
  });
}

// --- Activity ----------------------------------------------------------------------------

/** Airplay counts and the playout copy's engine cache state, for the asset drawer. */
export async function assetActivity(
  db: Executor,
  scope: StationScope,
  assetId: string,
  at = new Date(),
): Promise<AssetActivity> {
  await getAsset(db, scope, assetId); // 404 outside the station
  const day = 24 * 3600_000;
  const since = (ms: number) => new Date(at.getTime() - ms).toISOString();
  const [[plays], [cache]] = await Promise.all([
    db
      .select({
        lastPlayedAt: sql<Date | null>`max(${asRunEntry.startedAt})`.mapWith(asRunEntry.startedAt),
        plays7d: sql<number>`(count(*) filter (where ${asRunEntry.startedAt} >= ${since(7 * day)}::timestamptz))::int`,
        plays30d: sql<number>`(count(*) filter (where ${asRunEntry.startedAt} >= ${since(30 * day)}::timestamptz))::int`,
      })
      .from(asRunEntry)
      .where(and(whereStation(asRunEntry, scope), eq(asRunEntry.assetId, assetId))),
    db
      .select({
        state: playoutCacheFile.state,
        error: playoutCacheFile.errorMessage,
        fetchedAt: playoutCacheFile.fetchedAt,
      })
      .from(playoutCacheFile)
      .innerJoin(
        assetFile,
        and(
          eq(assetFile.sha256, playoutCacheFile.sha256),
          eq(assetFile.stationId, playoutCacheFile.stationId),
        ),
      )
      .where(
        and(
          whereStation(playoutCacheFile, scope),
          eq(assetFile.assetId, assetId),
          eq(assetFile.role, 'playout'),
        ),
      ),
  ]);
  return {
    lastPlayedAt: plays?.lastPlayedAt ?? null,
    plays7d: plays?.plays7d ?? 0,
    plays30d: plays?.plays30d ?? 0,
    cache: cache ? { state: cache.state, error: cache.error, fetchedAt: cache.fetchedAt } : null,
  };
}
