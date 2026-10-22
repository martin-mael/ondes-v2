import {
  asRunEntry,
  asset,
  assetAnalysis,
  assetCues,
  assetFile,
  assetLoudness,
  assetTag,
  type StationScope,
  tag,
  whereStation,
} from '@ondes/db';
import {
  ANALYSIS_STATES,
  type AnalysisState,
  type LibrarySort,
  type ParsedLibraryFilter,
  type SortDirection,
  type TagKey,
  type Validity,
} from '@ondes/shared';
import { type SQL, sql } from 'drizzle-orm';

// Library filters, sorts and facet counts compiled to SQL over `asset` (#23). The search box
// and the sort orders lean on the indexes of migration `*_library-search.sql`: the
// expressions below must stay exactly the indexed ones (`ondes_asset_search_text(…)`,
// `ondes_fold(title)`,
// …) or Postgres falls back to scanning the station's assets.
//
// Per-asset lookups (analysis results, as-run) are correlated `exists` on primary keys or
// on `asrun_entry_station_asset_idx`; tag tests are uncorrelated `asset.id in (…)`
// subqueries, which run once per query as hashed semi-joins (like rotation/sql.ts).

/** `like` pattern for a substring, with `%`, `_` and `\` escaped. */
const containing = (value: string) => `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Search words: whitespace-separated, deduplicated, at most 8. */
export function searchWords(q: string | undefined): string[] {
  if (!q) return [];
  return [...new Set(q.split(/\s+/).filter(Boolean))].slice(0, 8);
}

/** What the trigram index covers (migration `*_library-search.sql`). */
const searchText = sql`ondes_asset_search_text(${asset.title}, ${asset.artists}, ${asset.album})`;

/** Ids of the station's assets one search word matches: in their text or in a tag value. */
function wordMatch(scope: StationScope, word: string): SQL {
  const pattern = sql`ondes_fold(${containing(word)})`;
  return sql`${asset.id} in (
    select ${asset.id} from ${asset}
      where ${whereStation(asset, scope)} and ${searchText} like ${pattern}
    union
    select ${assetTag.assetId} from ${assetTag}
      join ${tag} on ${tag.id} = ${assetTag.tagId}
      where ${tag.stationId} = ${scope.stationId} and ondes_fold(${tag.value}) like ${pattern})`;
}

/** Assets carrying any of `values` (case-insensitive) under `key`. */
function hasTag(scope: StationScope, key: TagKey, values: string[]): SQL {
  return sql`${asset.id} in (
    select ${assetTag.assetId} from ${assetTag}
    join ${tag} on ${tag.id} = ${assetTag.tagId}
    where ${tag.stationId} = ${scope.stationId} and ${tag.key} = ${key}
      and lower(${tag.value}) in (${sql.join(
        values.map((v) => sql`${v.toLowerCase()}`),
        sql`, `,
      )}))`;
}

const hasLoudness = sql`exists (select 1 from ${assetLoudness} where ${assetLoudness.assetId} = ${asset.id})`;
const hasCues = sql`exists (select 1 from ${assetCues} where ${assetCues.assetId} = ${asset.id})`;
const hasPeaks = sql`exists (select 1 from ${assetFile}
  where ${assetFile.assetId} = ${asset.id} and ${assetFile.role} = 'peaks')`;
const hasPlayout = sql`exists (select 1 from ${assetFile}
  where ${assetFile.assetId} = ${asset.id} and ${assetFile.role} = 'playout')`;
const bpmOf = sql`(select ${assetAnalysis.bpm} from ${assetAnalysis} where ${assetAnalysis.assetId} = ${asset.id})`;

/** One analysis state as a boolean over the three presence flags. */
function analysisSql(state: AnalysisState, f: { l: SQL; c: SQL; p: SQL }): SQL {
  switch (state) {
    case 'complete':
      return sql`(${f.l} and ${f.c} and ${f.p})`;
    case 'pending':
      return sql`not (${f.l} and ${f.c} and ${f.p})`;
    case 'no_loudness':
      return sql`not ${f.l}`;
    case 'no_cues':
      return sql`not ${f.c}`;
    case 'no_peaks':
      return sql`not ${f.p}`;
    default:
      throw new Error(`unknown analysis state ${JSON.stringify(state satisfies never)}`);
  }
}

/** The scheduling window state at `at`, as a text expression over two timestamp columns. */
function validityStateSql(startAt: SQL, killAt: SQL, at: Date): SQL {
  const iso = sql`${at.toISOString()}::timestamptz`;
  return sql`(case when ${killAt} is not null and ${killAt} <= ${iso} then 'expired'
    when ${startAt} is not null and ${startAt} > ${iso} then 'future'
    else 'active' end)`;
}

const anyOf = (parts: SQL[]) => sql`(${sql.join(parts, sql` or `)})`;
const allOf = (parts: SQL[]) =>
  parts.length === 0 ? sql`true` : sql`(${sql.join(parts, sql` and `)})`;

function rangeSql(expr: SQL, range: { min?: unknown; max?: unknown } | undefined): SQL[] {
  if (!range) return [];
  const parts: SQL[] = [];
  if (range.min !== undefined) parts.push(sql`${expr} >= ${range.min}`);
  if (range.max !== undefined) parts.push(sql`${expr} <= ${range.max}`);
  return parts;
}

/** Tag filter values grouped by key (OR inside a key, AND across keys). */
export function tagsByKey(filter: ParsedLibraryFilter): Map<TagKey, string[]> {
  const byKey = new Map<TagKey, string[]>();
  for (const t of filter.tags ?? []) byKey.set(t.key, [...(byKey.get(t.key) ?? []), t.value]);
  return byKey;
}

/** A filter split into its non-faceted part and one condition per facet. */
export interface CompiledFilter {
  /** Station, words, ranges, flags, airplay: everything the facet panel doesn't count. */
  base: SQL;
  types: SQL | null;
  tags: Map<TagKey, SQL>;
  analysis: SQL | null;
  validity: SQL | null;
  /** The selected values, for the facet query, which rebuilds both on its own columns. */
  analysisStates: AnalysisState[];
  validities: Validity[];
}

export function compileFilter(
  scope: StationScope,
  filter: ParsedLibraryFilter,
  at: Date,
): CompiledFilter {
  const base: SQL[] = [whereStation(asset, scope)];
  for (const word of searchWords(filter.q)) base.push(wordMatch(scope, word));
  if (filter.explicit !== undefined) base.push(sql`${asset.explicit} = ${filter.explicit}`);
  base.push(...rangeSql(sql`${asset.durationMs}`, filter.durationMs));
  base.push(...rangeSql(sql`${asset.year}`, filter.year));
  base.push(...rangeSql(bpmOf, filter.bpm));
  if (filter.addedAt) {
    const { min, max } = filter.addedAt;
    base.push(
      ...rangeSql(sql`${asset.createdAt}`, {
        min: min && sql`${min.toISOString()}::timestamptz`,
        max: max && sql`${max.toISOString()}::timestamptz`,
      }),
    );
  }
  const plays = (since?: Date) => sql`exists (select 1 from ${asRunEntry}
    where ${asRunEntry.stationId} = ${scope.stationId} and ${asRunEntry.assetId} = ${asset.id}
    ${since ? sql`and ${asRunEntry.startedAt} >= ${since.toISOString()}::timestamptz` : sql``})`;
  if (filter.notPlayedSince) base.push(sql`not ${plays(filter.notPlayedSince)}`);
  if (filter.neverPlayed) base.push(sql`not ${plays()}`);
  if (filter.playable !== undefined) {
    base.push(filter.playable ? hasPlayout : sql`not ${hasPlayout}`);
  }

  const types = filter.types?.length
    ? sql`${asset.type} in (${sql.join(
        filter.types.map((t) => sql`${t}`),
        sql`, `,
      )})`
    : null;
  const tags = new Map<TagKey, SQL>();
  for (const [key, values] of tagsByKey(filter)) tags.set(key, hasTag(scope, key, values));
  const flags = { l: hasLoudness, c: hasCues, p: hasPeaks };
  const analysis = filter.analysis?.length
    ? anyOf(filter.analysis.map((s) => analysisSql(s, flags)))
    : null;
  const state = validityStateSql(sql`${asset.startAt}`, sql`${asset.killAt}`, at);
  const validity = filter.validity?.length
    ? sql`${state} in (${sql.join(
        filter.validity.map((v) => sql`${v}`),
        sql`, `,
      )})`
    : null;
  return {
    base: allOf(base),
    types,
    tags,
    analysis,
    validity,
    analysisStates: filter.analysis ?? [],
    validities: filter.validity ?? [],
  };
}

/** The whole filter as one condition on `asset`. */
export function filterSql(compiled: CompiledFilter): SQL {
  const parts = [compiled.base, compiled.types, compiled.analysis, compiled.validity];
  return allOf([...parts.filter((p): p is SQL => p !== null), ...compiled.tags.values()]);
}

// --- Sorting -----------------------------------------------------------------------------

/**
 * Sort expressions, never null (keyset comparisons need that) and identical to the indexed
 * ones. Text sorts compare folded values (case and accents ignored: "Été" sorts with the
 * E's whatever the database collation). `cast` turns a cursor's text value back into the
 * expression's type.
 */
export const SORTS: Record<Exclude<LibrarySort, 'added'>, { expr: SQL; cast: SQL }> = {
  title: { expr: sql`ondes_fold(${asset.title})`, cast: sql.raw('text') },
  artist: { expr: sql`ondes_fold(coalesce(${asset.artists}[1], ''))`, cast: sql.raw('text') },
  album: { expr: sql`ondes_fold(coalesce(${asset.album}, ''))`, cast: sql.raw('text') },
  year: { expr: sql`coalesce(${asset.year}, 0)`, cast: sql.raw('integer') },
  duration: { expr: sql`coalesce(${asset.durationMs}, 0)`, cast: sql.raw('integer') },
  bpm: { expr: sql`coalesce(${bpmOf}, 0)`, cast: sql.raw('real') },
};

export interface Keyset {
  /** The sort value of the last row, as text (`null` for `added`, which sorts on the id). */
  value: string | null;
  id: string;
}

/** `order by` and the "after this row" condition of a keyset page. */
export function sortSql(sort: LibrarySort, direction: SortDirection, after: Keyset | undefined) {
  const dir = sql.raw(direction);
  const op = sql.raw(direction === 'asc' ? '>' : '<');
  if (sort === 'added') {
    return {
      value: sql<null>`null`,
      orderBy: sql`${asset.id} ${dir}`,
      after: after ? sql`${asset.id} ${op} ${after.id}` : null,
    };
  }
  const { expr, cast } = SORTS[sort];
  return {
    value: sql<string>`(${expr})::text`,
    orderBy: sql`${expr} ${dir}, ${asset.id} ${dir}`,
    after: after
      ? sql`(${expr}, ${asset.id}) ${op} (cast(${after.value} as ${cast}), ${after.id}::uuid)`
      : null,
  };
}

// --- Facets ------------------------------------------------------------------------------

export interface FacetRow {
  facet: 'total' | 'type' | 'analysis' | 'validity' | 'tag';
  key: string | null;
  value: string | null;
  id: string | null;
  count: number;
}

/**
 * Every facet count in one statement and one scan of the matching assets. A materialized CTE
 * computes the per-asset flags once (the base filter, each facet's own condition, the
 * analysis presence flags, joined rather than probed per row, and the validity state); each
 * facet then counts the rows that pass every other facet's condition.
 */
export function facetsSql(scope: StationScope, compiled: CompiledFilter, at: Date): SQL {
  const keys = [...compiled.tags.keys()];
  const kcol = (i: number) => sql.raw(`k${i}`);
  const flags = [
    sql`${compiled.types ?? sql`true`} as ft`,
    sql`${assetLoudness.assetId} is not null as hl`,
    sql`${assetCues.assetId} is not null as hc`,
    sql`${assetFile.assetId} is not null as hp`,
    sql`${asset.startAt} as start_at`,
    sql`${asset.killAt} as kill_at`,
    ...keys.map((key, i) => sql`${compiled.tags.get(key)} as ${kcol(i)}`),
  ];
  const tagsBut = (skip: number | null) =>
    allOf(keys.flatMap((_, i) => (i === skip ? [] : [sql`r.${kcol(i)}`])));
  const rFlags = { l: sql`r.hl`, c: sql`r.hc`, p: sql`r.hp` };
  const analysis = compiled.analysis
    ? anyOf(compiled.analysisStates.map((s) => analysisSql(s, rFlags)))
    : sql`true`;
  const validity = validityStateSql(sql`r.start_at`, sql`r.kill_at`, at);
  const validityOk = compiled.validity
    ? sql`${validity} in (${sql.join(
        compiled.validities.map((v) => sql`${v}`),
        sql`, `,
      )})`
    : sql`true`;
  const tagCase =
    keys.length === 0
      ? sql`true`
      : sql`(case ${tag.key} ${sql.join(
          keys.map((key, i) => sql`when ${key} then ${tagsBut(i)}`),
          sql` `,
        )} else ${tagsBut(null)} end)`;

  return sql`with r as materialized (
      select ${asset.id} as id, ${asset.type} as type, ${sql.join(flags, sql`, `)}
      from ${asset}
      left join ${assetLoudness} on ${assetLoudness.assetId} = ${asset.id}
      left join ${assetCues} on ${assetCues.assetId} = ${asset.id}
      left join ${assetFile} on ${assetFile.assetId} = ${asset.id} and ${assetFile.role} = 'peaks'
      where ${compiled.base}
    ), f as (
      select r.*, ${analysis} as fa, ${validity} as vs, ${validityOk} as fv from r
    )
    select 'total' as facet, null as key, null as value, null::uuid as id,
      (count(*) filter (where ft and fa and fv and ${tagsBut(null)}))::int as count
      from f r
    union all
    select 'type', r.type, null, null, count(*)::int from f r
      where fa and fv and ${tagsBut(null)} group by r.type
    union all
    select 'analysis', s.state, null, null, count(*)::int from f r
      cross join lateral (values ${sql.join(
        ANALYSIS_STATES.map((s) => sql`(${s}, ${analysisSql(s, rFlags)})`),
        sql`, `,
      )}) as s(state, hit)
      where ft and fv and ${tagsBut(null)} and s.hit group by s.state
    union all
    select 'validity', r.vs, null, null, count(*)::int from f r
      where ft and fa and ${tagsBut(null)} group by r.vs
    union all
    select 'tag', ${tag.key}, ${tag.value}, ${tag.id}, count(*)::int from f r
      join ${assetTag} on ${assetTag.assetId} = r.id
      join ${tag} on ${tag.id} = ${assetTag.tagId}
      where ${whereStation(tag, scope)} and ft and fa and fv and ${tagCase}
      group by ${tag.id}, ${tag.key}, ${tag.value}`;
}
