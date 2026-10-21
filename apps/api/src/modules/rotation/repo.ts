import {
  asset,
  assetTag,
  auditDiff,
  category,
  categoryMember,
  type Db,
  type MutationContext,
  NotFoundError,
  type StationScope,
  type Tx,
  tag,
  whereStation,
  withAudit,
} from '@ondes/db';
import {
  type CategoryCandidate,
  type CategoryMembership,
  type CategoryMembershipInput,
  projectTurnoverDays,
  resolveCategory,
} from '@ondes/scheduling';
import {
  CATEGORY_DEFAULTS,
  type Category,
  type CategoryCounts,
  type CategoryDetail,
  type CategoryList,
  type CategoryMember,
  type CategoryPreview,
  type CategoryPreviewQuery,
  type CreateCategory,
  categoryPreviewQuerySchema,
  categoryRuleSchema,
  createCategorySchema,
  type DraftPreview,
  draftPreviewSchema,
  type ManualEffect,
  type TagKey,
  type UpdateCategory,
  updateCategorySchema,
} from '@ondes/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';
import { countCategories, membershipSql } from './sql.ts';

// Categories (#37): storage and membership. Every function takes the station scope and
// filters on it; mutations run in `withAudit`. Membership is never stored: the api's reads
// compile it to SQL (sql.ts), so counts and pages come from the database, and schedulers get
// members from @ondes/scheduling's `resolveCategory` (`resolveCategoryMembers`). Both follow
// tag edits at once; rotation.int.test.ts checks that they agree.

export interface StationContext extends MutationContext {
  scope: StationScope;
}

type CategoryRow = typeof category.$inferSelect;

/** A library asset as membership sees it, plus what the preview shows. */
export interface LibraryCandidate extends CategoryCandidate {
  title: string;
  artists: string[];
}

const storedRule = categoryRuleSchema.nullable();

function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    orgId: row.orgId,
    stationId: row.stationId,
    name: row.name,
    description: row.description,
    color: row.color,
    assetType: row.assetType,
    // jsonb: checked against the contract on the way out too.
    rule: storedRule.parse(row.rule ?? null),
    rotationOrder: row.rotationOrder,
    searchDepthPercent: row.searchDepthPercent,
    restMinutes: row.restMinutes,
    maxPlaysPerDay: row.maxPlaysPerDay,
    maxPlaysPerWeek: row.maxPlaysPerWeek,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Library order: first artist, then title. */
const libraryOrder = () => [
  sql`lower(coalesce(${asset.artists}[1], ''))`,
  sql`lower(${asset.title})`,
  asc(asset.id),
];

/**
 * The station's assets with their tags, in library order: the candidates `resolveCategory`
 * needs. Loads the whole library; the api's own reads use the SQL in sql.ts instead.
 */
export async function loadCandidates(
  db: Db | Tx,
  scope: StationScope,
): Promise<LibraryCandidate[]> {
  return db
    .select({
      id: asset.id,
      type: asset.type,
      title: asset.title,
      artists: asset.artists,
      year: asset.year,
      explicit: asset.explicit,
      durationMs: asset.durationMs,
      startAt: asset.startAt,
      killAt: asset.killAt,
      addedAt: asset.createdAt,
      tags: sql<{ key: TagKey; value: string }[]>`coalesce(
        json_agg(json_build_object('key', ${tag.key}, 'value', ${tag.value}))
          filter (where ${tag.id} is not null),
        '[]'::json)`,
    })
    .from(asset)
    .leftJoin(assetTag, eq(assetTag.assetId, asset.id))
    .leftJoin(tag, eq(tag.id, assetTag.tagId))
    .where(whereStation(asset, scope))
    .groupBy(asset.id)
    .orderBy(...libraryOrder());
}

async function membersOf(db: Db | Tx, scope: StationScope, categoryIds: string[]) {
  const byCategory = new Map<string, CategoryMember[]>();
  if (categoryIds.length === 0) return byCategory;
  const rows = await db
    .select({
      categoryId: categoryMember.categoryId,
      assetId: categoryMember.assetId,
      mode: categoryMember.mode,
    })
    .from(categoryMember)
    .where(
      and(whereStation(categoryMember, scope), inArray(categoryMember.categoryId, categoryIds)),
    )
    .orderBy(asc(categoryMember.createdAt), asc(categoryMember.assetId));
  for (const row of rows) {
    const list = byCategory.get(row.categoryId) ?? [];
    list.push({ assetId: row.assetId, mode: row.mode });
    byCategory.set(row.categoryId, list);
  }
  return byCategory;
}

async function loadRow(db: Db | Tx, scope: StationScope, id: string): Promise<CategoryRow> {
  const [row] = await db
    .select()
    .from(category)
    .where(and(eq(category.id, id), whereStation(category, scope)));
  if (!row) throw new NotFoundError('category', id);
  return row;
}

export async function listCategories(
  db: Db,
  scope: StationScope,
  at = new Date(),
): Promise<CategoryList> {
  const rows = await db
    .select()
    .from(category)
    .where(whereStation(category, scope))
    .orderBy(sql`lower(${category.name})`, asc(category.id));
  const members = await membersOf(
    db,
    scope,
    rows.map((r) => r.id),
  );
  const categories = rows.map((row) => ({
    ...toCategory(row),
    members: members.get(row.id) ?? [],
  }));
  const counts = await countCategories(db, scope, categories, at);
  return {
    items: categories.map(({ members: _, ...c }, i) => ({
      ...c,
      counts: counts[i] as CategoryCounts,
    })),
  };
}

export async function getCategory(
  db: Db | Tx,
  scope: StationScope,
  id: string,
  at = new Date(),
): Promise<CategoryDetail> {
  const row = await loadRow(db, scope, id);
  const members = (await membersOf(db, scope, [id])).get(id) ?? [];
  const category = { ...toCategory(row), members };
  const [counts] = await countCategories(db, scope, [category], at);
  return { ...category, counts: counts as CategoryCounts };
}

/**
 * Members of a saved category at `at`, with the pure resolver: what schedulers (the log
 * generator, #50) pick from. Loads the station's candidates.
 */
export async function resolveCategoryMembers(
  db: Db,
  scope: StationScope,
  id: string,
  at: Date,
): Promise<CategoryMembership<LibraryCandidate>> {
  const row = await loadRow(db, scope, id);
  const [members, candidates] = await Promise.all([
    membersOf(db, scope, [id]),
    loadCandidates(db, scope),
  ]);
  return resolveCategory({ ...toCategory(row), members: members.get(id) ?? [] }, candidates, at);
}

function manualEffect(
  mode: CategoryMember['mode'],
  typeOk: boolean,
  byRule: boolean,
): ManualEffect {
  if (!typeOk) return 'wrong_type';
  if (mode === 'exclude') return byRule ? 'excluded' : 'redundant';
  return byRule ? 'redundant' : 'added';
}

type Paging = {
  playsPerDay?: number | undefined;
  limit: number;
  offset: number;
  manualLimit: number;
  manualOffset: number;
};

/** Counts, a page of members and a page of manual entries, from the database. */
async function preview(
  db: Db,
  scope: StationScope,
  input: CategoryMembershipInput,
  paging: Paging,
  at: Date,
): Promise<CategoryPreview> {
  const m = membershipSql(scope, input, at);
  const manualIds = input.members.map((x) => x.assetId);
  const modes = new Map(input.members.map((x) => [x.assetId, x.mode]));
  const [[counts], items, manual, [manualTotal]] = await Promise.all([
    countCategories(db, scope, [input], at),
    paging.limit === 0
      ? []
      : db
          .select({
            assetId: asset.id,
            title: asset.title,
            artists: asset.artists,
            year: asset.year,
            durationMs: asset.durationMs,
            byRule: sql<boolean>`${m.byRule}`,
            included: sql<boolean>`${m.included}`,
            schedulable: sql<boolean>`${m.schedulable}`,
          })
          .from(asset)
          .where(and(whereStation(asset, scope), m.member))
          .orderBy(...libraryOrder())
          .limit(paging.limit)
          .offset(paging.offset),
    manualIds.length === 0 || paging.manualLimit === 0
      ? []
      : db
          .select({
            assetId: asset.id,
            title: asset.title,
            artists: asset.artists,
            typeOk: sql<boolean>`${m.typeOk}`,
            byRule: sql<boolean>`${m.byRule}`,
          })
          .from(asset)
          .where(and(whereStation(asset, scope), inArray(asset.id, manualIds)))
          .orderBy(...libraryOrder())
          .limit(paging.manualLimit)
          .offset(paging.manualOffset),
    manualIds.length === 0
      ? [{ n: 0 }]
      : db
          .select({ n: sql<number>`count(*)`.mapWith(Number) })
          .from(asset)
          .where(and(whereStation(asset, scope), inArray(asset.id, manualIds))),
  ]);
  const total = counts as CategoryCounts;
  return {
    counts: total,
    turnoverDays: projectTurnoverDays(total.schedulable, paging.playsPerDay),
    items: items.map((i) => ({
      assetId: i.assetId,
      title: i.title,
      artists: i.artists,
      year: i.year,
      durationMs: i.durationMs,
      source: i.byRule && i.included ? 'both' : i.byRule ? 'rule' : 'manual',
      schedulable: i.schedulable,
    })),
    manual: manual.map((e) => {
      const mode = modes.get(e.assetId) ?? 'include';
      return {
        assetId: e.assetId,
        title: e.title,
        artists: e.artists,
        mode,
        effect: manualEffect(mode, e.typeOk, e.byRule),
      };
    }),
    manualTotal: manualTotal?.n ?? 0,
  };
}

export async function previewCategory(
  db: Db,
  scope: StationScope,
  id: string,
  query: CategoryPreviewQuery,
  at = new Date(),
): Promise<CategoryPreview> {
  const parsed = categoryPreviewQuerySchema.parse(query);
  const row = await loadRow(db, scope, id);
  const members = (await membersOf(db, scope, [id])).get(id) ?? [];
  return preview(db, scope, { ...toCategory(row), members }, parsed, at);
}

/** Preview of an unsaved category: the editor's live preview. */
export async function previewDraft(
  db: Db,
  scope: StationScope,
  draft: DraftPreview,
  at = new Date(),
): Promise<CategoryPreview> {
  const parsed = draftPreviewSchema.parse(draft);
  return preview(db, scope, parsed, parsed, at);
}

// --- Mutations ---------------------------------------------------------------------------

function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  while (current && typeof current === 'object') {
    if ((current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** `withAudit`, with a duplicate name answered as 409 `category_name_taken`. */
async function mutate<T>(db: Db, ctx: StationContext, fn: Parameters<typeof withAudit<T>>[2]) {
  try {
    return await withAudit(db, ctx, fn);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, 'category_name_taken', 'a category of this station has this name');
    }
    throw error;
  }
}

/** Manual entries must name assets of this station. */
async function checkMembers(tx: Tx, scope: StationScope, members: CategoryMember[]) {
  if (members.length === 0) return;
  const ids = members.map((m) => m.assetId);
  const found = await tx
    .select({ id: asset.id })
    .from(asset)
    .where(and(whereStation(asset, scope), inArray(asset.id, ids)));
  const known = new Set(found.map((r) => r.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new HttpError(400, 'unknown_asset', 'some members are not assets of this station', {
      assetIds: missing,
    });
  }
}

async function replaceMembers(
  tx: Tx,
  scope: StationScope,
  categoryId: string,
  members: CategoryMember[],
) {
  await checkMembers(tx, scope, members);
  await tx
    .delete(categoryMember)
    .where(and(eq(categoryMember.categoryId, categoryId), whereStation(categoryMember, scope)));
  if (members.length === 0) return;
  await tx.insert(categoryMember).values(
    members.map((m) => ({
      categoryId,
      assetId: m.assetId,
      mode: m.mode,
      orgId: scope.orgId,
      stationId: scope.stationId,
    })),
  );
}

/** Audited shape: the category's fields and its manual entries. */
const audited = (row: CategoryRow, members: CategoryMember[]) => ({
  ...toCategory(row),
  members,
});

export async function createCategory(
  db: Db,
  ctx: StationContext,
  input: CreateCategory,
): Promise<CategoryDetail> {
  const { members = [], ...fields } = createCategorySchema.parse(input);
  const id = await mutate(db, ctx, async (tx, audit) => {
    const [row] = await tx
      .insert(category)
      .values({
        ...CATEGORY_DEFAULTS,
        ...fields,
        orgId: ctx.scope.orgId,
        stationId: ctx.scope.stationId,
      })
      .returning();
    if (!row) throw new Error('category insert returned nothing');
    await replaceMembers(tx, ctx.scope, row.id, members);
    await audit({
      action: 'category.create',
      entity: { type: 'category', id: row.id },
      diff: auditDiff(null, audited(row, members)),
    });
    return row.id;
  });
  return getCategory(db, ctx.scope, id);
}

export async function updateCategory(
  db: Db,
  ctx: StationContext,
  id: string,
  patch: UpdateCategory,
): Promise<CategoryDetail> {
  const { members, ...fields } = updateCategorySchema.parse(patch);
  await mutate(db, ctx, async (tx, audit) => {
    const before = await loadRow(tx, ctx.scope, id);
    const membersBefore = (await membersOf(tx, ctx.scope, [id])).get(id) ?? [];
    // Always written, so a members-only edit moves `updatedAt` too.
    const [after] = await tx
      .update(category)
      .set({ ...fields, updatedAt: new Date() })
      .where(and(eq(category.id, id), whereStation(category, ctx.scope)))
      .returning();
    if (!after) throw new NotFoundError('category', id);
    if (members) await replaceMembers(tx, ctx.scope, id, members);
    await audit({
      action: 'category.update',
      entity: { type: 'category', id },
      diff: auditDiff(audited(before, membersBefore), audited(after, members ?? membersBefore)),
    });
  });
  return getCategory(db, ctx.scope, id);
}

export async function deleteCategory(db: Db, ctx: StationContext, id: string): Promise<void> {
  await mutate(db, ctx, async (tx, audit) => {
    const before = await loadRow(tx, ctx.scope, id);
    const membersBefore = (await membersOf(tx, ctx.scope, [id])).get(id) ?? [];
    await tx.delete(category).where(and(eq(category.id, id), whereStation(category, ctx.scope)));
    await audit({
      action: 'category.delete',
      entity: { type: 'category', id },
      diff: auditDiff(audited(before, membersBefore), null),
    });
  });
}
