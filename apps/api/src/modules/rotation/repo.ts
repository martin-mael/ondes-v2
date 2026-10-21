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
  type CategoryDetail,
  type CategoryList,
  type CategoryMember,
  type CategoryPreview,
  type CategoryPreviewQuery,
  type CreateCategory,
  categoryPreviewQuerySchema,
  createCategorySchema,
  type DraftPreview,
  draftPreviewSchema,
  type TagKey,
  type UpdateCategory,
  updateCategorySchema,
} from '@ondes/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';

// Categories (#37): storage and membership. Every function takes the station scope and
// filters on it; mutations run in `withAudit`. Members are resolved on read with
// @ondes/scheduling's `resolveCategory` against the station's library, so a tag edit changes
// membership at once and the preview, the list counts and (later) the log generator agree.

export interface StationContext extends MutationContext {
  scope: StationScope;
}

type CategoryRow = typeof category.$inferSelect;

/** A library asset as membership sees it, plus what the preview shows. */
export interface LibraryCandidate extends CategoryCandidate {
  title: string;
  artists: string[];
}

function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    orgId: row.orgId,
    stationId: row.stationId,
    name: row.name,
    description: row.description,
    color: row.color,
    assetType: row.assetType,
    rule: row.rule ?? null,
    rotationOrder: row.rotationOrder,
    searchDepthPercent: row.searchDepthPercent,
    restMinutes: row.restMinutes,
    maxPlaysPerDay: row.maxPlaysPerDay,
    maxPlaysPerWeek: row.maxPlaysPerWeek,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The station's assets with their tags, by first artist then title: the candidates of every
 * category of the station. One query, whatever the number of categories.
 */
export async function loadCandidates(
  db: Db | Tx,
  scope: StationScope,
): Promise<LibraryCandidate[]> {
  const rows = await db
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
    .orderBy(
      sql`lower(coalesce(${asset.artists}[1], ''))`,
      sql`lower(${asset.title})`,
      asc(asset.id),
    );
  return rows;
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

export async function listCategories(db: Db, scope: StationScope): Promise<CategoryList> {
  const rows = await db
    .select()
    .from(category)
    .where(whereStation(category, scope))
    .orderBy(sql`lower(${category.name})`, asc(category.id));
  const [members, candidates] = await Promise.all([
    membersOf(
      db,
      scope,
      rows.map((r) => r.id),
    ),
    loadCandidates(db, scope),
  ]);
  return {
    items: rows.map((row) => {
      const input = { ...toCategory(row), members: members.get(row.id) ?? [] };
      return { ...toCategory(row), counts: resolveCategory(input, candidates).counts };
    }),
  };
}

export async function getCategory(
  db: Db,
  scope: StationScope,
  id: string,
): Promise<CategoryDetail> {
  const row = await loadRow(db, scope, id);
  const [members, candidates] = await Promise.all([
    membersOf(db, scope, [id]),
    loadCandidates(db, scope),
  ]);
  const list = members.get(id) ?? [];
  const resolved = resolveCategory({ ...toCategory(row), members: list }, candidates);
  return { ...toCategory(row), members: list, counts: resolved.counts };
}

/**
 * Members of a saved category, resolved now (or at `at`). For consumers that schedule from a
 * category (clocks, the log generator).
 */
export async function resolveCategoryMembers(
  db: Db,
  scope: StationScope,
  id: string,
  at?: Date,
): Promise<CategoryMembership<LibraryCandidate>> {
  const row = await loadRow(db, scope, id);
  const [members, candidates] = await Promise.all([
    membersOf(db, scope, [id]),
    loadCandidates(db, scope),
  ]);
  return resolveCategory(
    { ...toCategory(row), members: members.get(id) ?? [] },
    candidates,
    at ? { at } : {},
  );
}

function toPreview(
  membership: CategoryMembership<LibraryCandidate>,
  query: { playsPerDay?: number | undefined; limit: number; offset: number },
): CategoryPreview {
  return {
    counts: membership.counts,
    turnoverDays: projectTurnoverDays(membership.counts.schedulable, query.playsPerDay),
    items: membership.members.slice(query.offset, query.offset + query.limit).map((m) => ({
      assetId: m.asset.id,
      title: m.asset.title,
      artists: m.asset.artists,
      year: m.asset.year,
      durationMs: m.asset.durationMs,
      source: m.source,
      schedulable: m.schedulable,
    })),
    manual: membership.manual.map((m) => ({
      assetId: m.asset.id,
      title: m.asset.title,
      artists: m.asset.artists,
      mode: m.mode,
      effect: m.effect,
    })),
  };
}

export async function previewCategory(
  db: Db,
  scope: StationScope,
  id: string,
  query: CategoryPreviewQuery,
): Promise<CategoryPreview> {
  const parsed = categoryPreviewQuerySchema.parse(query);
  return toPreview(await resolveCategoryMembers(db, scope, id), parsed);
}

/** Preview of an unsaved category: the editor's live preview. */
export async function previewDraft(
  db: Db,
  scope: StationScope,
  draft: DraftPreview,
): Promise<CategoryPreview> {
  const parsed = draftPreviewSchema.parse(draft);
  const input: CategoryMembershipInput = parsed;
  return toPreview(resolveCategory(input, await loadCandidates(db, scope)), parsed);
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
