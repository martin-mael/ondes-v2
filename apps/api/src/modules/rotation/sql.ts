import { asset, assetTag, type Db, type StationScope, type Tx, tag } from '@ondes/db';
import type { CategoryMembershipInput } from '@ondes/scheduling';
import {
  type CategoryCounts,
  type ComparisonOp,
  type RuleCondition,
  type RuleGroup,
  TAG_NUMBER_PATTERN,
} from '@ondes/shared';
import { type SQL, sql } from 'drizzle-orm';

// Category membership compiled to SQL over the `asset` table (#37), so counts and preview
// pages come from the database instead of loading the station's library. The reference
// implementation is @ondes/scheduling's `resolveCategory`; rotation.int.test.ts checks that
// both agree on generated rules. Tag tests are uncorrelated `asset.id in (…)` subqueries,
// which Postgres runs as hashed semi-joins, once per query.

const OPS: Record<ComparisonOp, SQL> = {
  eq: sql.raw('='),
  gte: sql.raw('>='),
  gt: sql.raw('>'),
  lte: sql.raw('<='),
  lt: sql.raw('<'),
};

const norm = (value: string) => value.trim().toLowerCase();

/** Assets of the station carrying a tag of `key` whose value satisfies `where`. */
function withTag(scope: StationScope, key: string, where: SQL): SQL {
  return sql`${asset.id} in (
    select ${assetTag.assetId} from ${assetTag}
    join ${tag} on ${tag.id} = ${assetTag.tagId}
    where ${tag.stationId} = ${scope.stationId} and ${tag.key} = ${key} and ${where})`;
}

const valueIs = (values: string[]) =>
  sql`lower(btrim(${tag.value})) in (${sql.join(
    values.map((v) => sql`${norm(v)}`),
    sql`, `,
  )})`;

function condition(scope: StationScope, c: RuleCondition): SQL {
  switch (c.kind) {
    case 'tag':
      if (c.op === 'any') return withTag(scope, c.key, valueIs(c.values));
      if (c.op === 'none') return sql`not ${withTag(scope, c.key, valueIs(c.values))}`;
      return sql`(${sql.join(
        c.values.map((v) => withTag(scope, c.key, valueIs([v]))),
        sql` and `,
      )})`;
    case 'tag_number':
      // CASE keeps the cast behind the pattern check (AND has no evaluation order).
      return withTag(
        scope,
        c.key,
        sql`(case when btrim(${tag.value}) ~ ${TAG_NUMBER_PATTERN}
          then btrim(${tag.value})::float8 end) ${OPS[c.op]} ${c.value}::float8`,
      );
    case 'year':
      return sql`coalesce(${asset.year} ${OPS[c.op]} ${c.value}, false)`;
    case 'explicit':
      return sql`${asset.explicit} = ${c.value}`;
    default:
      throw new Error(`unknown rule condition ${JSON.stringify(c satisfies never)}`);
  }
}

/** A rule as a boolean SQL expression on `asset`. */
export function compileRule(scope: StationScope, group: RuleGroup): SQL {
  const parts = group.children.map((child) =>
    child.kind === 'group' ? compileRule(scope, child) : condition(scope, child),
  );
  return sql`(${sql.join(parts, group.match === 'all' ? sql` and ` : sql` or `)})`;
}

/** `asset.id = any('{…}'::uuid[])`: one parameter, however many ids. */
function idIn(ids: string[]): SQL {
  if (ids.length === 0) return sql`false`;
  return sql`${asset.id} = any(${`{${ids.join(',')}}`}::uuid[])`;
}

export interface MembershipSql {
  /** Of the category's asset type. */
  typeOk: SQL;
  /** Matched by the rule (type not checked). */
  byRule: SQL;
  included: SQL;
  excluded: SQL;
  /** A member: right type, and (rule match not excluded, or included). */
  member: SQL;
  schedulable: SQL;
}

/** Membership of `category` as SQL expressions on `asset`, at instant `at`. */
export function membershipSql(
  scope: StationScope,
  category: CategoryMembershipInput,
  at: Date,
): MembershipSql {
  const typeOk = sql`${asset.type} = ${category.assetType}`;
  const byRule = category.rule ? compileRule(scope, category.rule) : sql`false`;
  const included = idIn(category.members.filter((m) => m.mode === 'include').map((m) => m.assetId));
  const excluded = idIn(category.members.filter((m) => m.mode === 'exclude').map((m) => m.assetId));
  return {
    typeOk,
    byRule,
    included,
    excluded,
    member: sql`(${typeOk} and ((${byRule} and not ${excluded}) or ${included}))`,
    schedulable: schedulableSql(at),
  };
}

/** Inside the asset's start/kill window at `at`. */
function schedulableSql(at: Date): SQL {
  const iso = at.toISOString();
  return sql`((${asset.startAt} is null or ${asset.startAt} <= ${iso}::timestamptz)
    and (${asset.killAt} is null or ${asset.killAt} > ${iso}::timestamptz))`;
}

/**
 * Counts of several categories in one scan of the station's assets. The per-row flags are
 * computed once in a materialized CTE: inlined into each aggregate's FILTER, the rule
 * subqueries would run once per aggregate.
 */
export async function countCategories(
  db: Db | Tx,
  scope: StationScope,
  categories: CategoryMembershipInput[],
  at: Date,
): Promise<CategoryCounts[]> {
  if (categories.length === 0) return [];
  const ms = categories.map((c) => membershipSql(scope, c, at));
  const col = (name: string, i: number) => sql.raw(`${name}${i}`);
  const flags = ms.flatMap((m, i) => [
    sql`${m.typeOk} as ${col('t', i)}`,
    sql`${m.byRule} as ${col('r', i)}`,
    sql`${m.included} as ${col('n', i)}`,
    sql`${m.excluded} as ${col('x', i)}`,
  ]);
  const aggregates = ms.flatMap((_, i) => {
    const [t, r, n, x] = (['t', 'r', 'n', 'x'] as const).map((name) => col(name, i));
    const member = sql`(${t} and ((${r} and not ${x}) or ${n}))`;
    const count = (where: SQL, as: string) =>
      sql`count(*) filter (where ${where})::int as ${col(as, i)}`;
    return [
      count(member, 'members_'),
      count(sql`${member} and s`, 'schedulable_'),
      count(sql`${t} and ${r}`, 'rule_matches_'),
      count(sql`${member} and not ${r}`, 'manual_only_'),
      count(sql`${t} and ${r} and ${x}`, 'excluded_'),
      sql`coalesce(sum(d) filter (where ${member}), 0)::float8 as ${col('duration_', i)}`,
    ];
  });
  const rows = await db.execute<Record<string, number>>(sql`
    with f as materialized (
      select ${asset.durationMs} as d, ${schedulableSql(at)} as s, ${sql.join(flags, sql`, `)}
      from ${asset} where ${asset.stationId} = ${scope.stationId}
    )
    select ${sql.join(aggregates, sql`, `)} from f`);
  const row = rows[0] ?? {};
  return ms.map((_, i) => ({
    members: Number(row[`members_${i}`] ?? 0),
    schedulable: Number(row[`schedulable_${i}`] ?? 0),
    ruleMatches: Number(row[`rule_matches_${i}`] ?? 0),
    manualOnly: Number(row[`manual_only_${i}`] ?? 0),
    excluded: Number(row[`excluded_${i}`] ?? 0),
    totalDurationMs: Number(row[`duration_${i}`] ?? 0),
  }));
}
