import {
  asset,
  auditDiff,
  category,
  clock,
  clockSlot,
  type Db,
  type MutationContext,
  NotFoundError,
  type StationScope,
  type Tx,
  vtPool,
  whereStation,
  withAudit,
} from '@ondes/db';
import { resolveCategory } from '@ondes/scheduling';
import {
  type CategoryDetail,
  type Clock,
  type ClockDetail,
  type ClockList,
  type ClockPreview,
  type ClockPreviewAsset,
  type ClockPreviewQuery,
  type ClockSlot,
  type CreateClock,
  clockPreviewQuerySchema,
  clockSlotSchema,
  createClockSchema,
  type DraftClockEstimate,
  type DraftClockPreview,
  type DuplicateClock,
  draftClockEstimateSchema,
  draftClockPreviewSchema,
  duplicateClockSchema,
  estimateClock,
  type SlotReference,
  slotCategoryId,
  slotPoolId,
  type UpdateClock,
  updateClockSchema,
} from '@ondes/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';
import { getCategory, type LibraryCandidate, loadCandidates } from '../rotation/repo.ts';
import { releaseClockFromGrid } from './grid-repo.ts';
import {
  type FixedPlacement,
  findPickSlots,
  type PickRequest,
  type PickSlotsFn,
  randomPicker,
  rulesPicker,
  seededRandom,
} from './preview.ts';

// Clocks (#39): storage, timing estimate and sample-hour preview. Every function takes the
// station scope and filters on it; mutations run in `withAudit`. The slot list is replaced
// whole on each save (positions are slot indexes). The estimate uses each category's average
// member length; the preview picks real assets and times the hour with their lengths.

export interface StationContext extends MutationContext {
  scope: StationScope;
}

type ClockRow = typeof clock.$inferSelect;
type SlotRow = typeof clockSlot.$inferSelect;

function toSlot(row: SlotRow): ClockSlot {
  const base = { kind: row.kind, label: row.label, durationMs: row.durationMs };
  // Checked against the contract on the way out: the row's columns depend on its kind.
  return clockSlotSchema.parse({
    ...base,
    ...(row.kind === 'asset' ? { assetId: row.assetId } : {}),
    ...(['category', 'jingle', 'fill', 'vt'].includes(row.kind)
      ? { categoryId: row.categoryId }
      : {}),
    ...(row.kind === 'vt'
      ? { mode: row.vtMode, ...(row.poolId ? { poolId: row.poolId } : {}) }
      : {}),
    ...(row.kind === 'marker'
      ? { timing: row.timing, offsetMs: row.offsetMs, capMs: row.capMs }
      : {}),
  });
}

function toSlotRow(slot: ClockSlot, position: number, clockId: string, scope: StationScope) {
  return {
    clockId,
    position,
    orgId: scope.orgId,
    stationId: scope.stationId,
    kind: slot.kind,
    label: slot.label,
    durationMs: slot.durationMs,
    // Not `slot.categoryId`: a placeholder VT keeps no category (and none is checked).
    categoryId: slotCategoryId(slot),
    assetId: slot.kind === 'asset' ? slot.assetId : null,
    vtMode: slot.kind === 'vt' ? slot.mode : null,
    poolId: slotPoolId(slot),
    timing: slot.kind === 'marker' ? slot.timing : null,
    offsetMs: slot.kind === 'marker' ? slot.offsetMs : null,
    capMs: slot.kind === 'marker' ? slot.capMs : null,
  };
}

function toClock(row: ClockRow, slots: ClockSlot[]): Clock {
  return {
    id: row.id,
    orgId: row.orgId,
    stationId: row.stationId,
    name: row.name,
    description: row.description,
    color: row.color,
    targetDurationMs: row.targetDurationMs,
    slots,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function slotsOf(db: Db | Tx, scope: StationScope, clockIds: string[]) {
  const byClock = new Map<string, ClockSlot[]>();
  if (clockIds.length === 0) return byClock;
  const rows = await db
    .select()
    .from(clockSlot)
    .where(and(whereStation(clockSlot, scope), inArray(clockSlot.clockId, clockIds)))
    .orderBy(asc(clockSlot.clockId), asc(clockSlot.position));
  for (const row of rows) {
    const list = byClock.get(row.clockId) ?? [];
    list.push(toSlot(row));
    byClock.set(row.clockId, list);
  }
  return byClock;
}

async function loadRow(db: Db | Tx, scope: StationScope, id: string): Promise<ClockRow> {
  const [row] = await db
    .select()
    .from(clock)
    .where(and(eq(clock.id, id), whereStation(clock, scope)));
  if (!row) throw new NotFoundError('clock', id);
  return row;
}

// --- References and estimate -------------------------------------------------------------

interface References {
  categories: Map<string, SlotReference>;
  assets: Map<string, SlotReference>;
  /** VT pools of promo slots (#60): a promo is voiced over a transition, so no length. */
  pools: Map<string, SlotReference>;
}

/**
 * The categories and assets `slots` point at, in this station: their type and length (a
 * category's average member length, from members with a known length).
 */
async function loadReferences(
  db: Db | Tx,
  scope: StationScope,
  slots: readonly ClockSlot[],
): Promise<References> {
  const categoryIds = [...new Set(slots.map(slotCategoryId).filter((id) => id !== null))];
  const assetIds = [
    ...new Set(slots.flatMap((s) => (s.kind === 'asset' && s.assetId ? [s.assetId] : []))),
  ];
  const poolIds = [...new Set(slots.map(slotPoolId).filter((id) => id !== null))];
  const [categories, assets, pools] = await Promise.all([
    categoryIds.length === 0 ? [] : categoryAverages(db, scope, categoryIds),
    assetIds.length === 0
      ? []
      : db
          .select({ id: asset.id, type: asset.type, durationMs: asset.durationMs })
          .from(asset)
          .where(and(whereStation(asset, scope), inArray(asset.id, assetIds))),
    poolIds.length === 0
      ? []
      : db
          .select({ id: vtPool.id })
          .from(vtPool)
          .where(and(whereStation(vtPool, scope), inArray(vtPool.id, poolIds))),
  ]);
  return {
    pools: new Map(
      pools.map((p) => [p.id, { exists: true, durationMs: 0, assetType: 'vt' as const }]),
    ),
    categories: new Map(categories),
    assets: new Map(
      assets.map((a) => [a.id, { exists: true, durationMs: a.durationMs, assetType: a.type }]),
    ),
  };
}

/** Average length of each category's members, resolved like the scheduler resolves them. */
async function categoryAverages(
  db: Db | Tx,
  scope: StationScope,
  ids: string[],
): Promise<[string, SlotReference][]> {
  const rows = await db
    .select({ id: category.id })
    .from(category)
    .where(and(whereStation(category, scope), inArray(category.id, ids)));
  if (rows.length === 0) return [];
  const candidates = await loadCandidates(db, scope);
  const at = new Date();
  return Promise.all(
    rows.map(async ({ id }): Promise<[string, SlotReference]> => {
      const detail = await getCategory(db, scope, id, at);
      const { members } = resolveCategory(detail, candidates, at);
      const known = members.filter((m) => m.asset.durationMs !== null);
      const total = known.reduce((sum, m) => sum + (m.asset.durationMs ?? 0), 0);
      return [
        id,
        {
          exists: true,
          durationMs: known.length > 0 ? total / known.length : null,
          assetType: detail.assetType,
        },
      ];
    }),
  );
}

const missing: SlotReference = { exists: false, durationMs: null, assetType: null };

function referenceOf(refs: References, slot: ClockSlot): SlotReference | undefined {
  if (slot.kind === 'asset')
    return slot.assetId ? (refs.assets.get(slot.assetId) ?? missing) : undefined;
  const poolId = slotPoolId(slot);
  if (poolId) return refs.pools.get(poolId) ?? missing;
  const id = slotCategoryId(slot);
  return id ? (refs.categories.get(id) ?? missing) : undefined;
}

function estimateWith(refs: References, c: { targetDurationMs: number; slots: ClockSlot[] }) {
  return estimateClock(c, (slot) => referenceOf(refs, slot));
}

async function withEstimates(db: Db | Tx, scope: StationScope, clocks: Clock[]) {
  const refs = await loadReferences(
    db,
    scope,
    clocks.flatMap((c) => c.slots),
  );
  return clocks.map((c) => ({ ...c, estimate: estimateWith(refs, c) }));
}

// --- Reads -------------------------------------------------------------------------------

export async function listClocks(db: Db, scope: StationScope): Promise<ClockList> {
  const rows = await db
    .select()
    .from(clock)
    .where(whereStation(clock, scope))
    .orderBy(sql`lower(${clock.name})`, asc(clock.id));
  const slots = await slotsOf(
    db,
    scope,
    rows.map((r) => r.id),
  );
  const clocks = rows.map((row) => toClock(row, slots.get(row.id) ?? []));
  return { items: await withEstimates(db, scope, clocks) };
}

/** A saved clock and its slots, without the estimate: what the log generator (#50) reads. */
export async function loadClock(db: Db | Tx, scope: StationScope, id: string): Promise<Clock> {
  const row = await loadRow(db, scope, id);
  return toClock(row, (await slotsOf(db, scope, [id])).get(id) ?? []);
}

export async function getClock(db: Db | Tx, scope: StationScope, id: string): Promise<ClockDetail> {
  const [detail] = await withEstimates(db, scope, [await loadClock(db, scope, id)]);
  return detail as ClockDetail;
}

/** The timeline of an unsaved clock: the editor's live estimate. */
export async function estimateDraft(db: Db, scope: StationScope, draft: DraftClockEstimate) {
  const parsed = draftClockEstimateSchema.parse(draft);
  const refs = await loadReferences(db, scope, parsed.slots);
  return estimateWith(refs, parsed);
}

// --- Preview -----------------------------------------------------------------------------

export interface PreviewOptions {
  /**
   * #38's `pickSlots`: found at runtime by default (`findPickSlots`); `null` forces the random
   * fallback.
   */
  pickSlots?: PickSlotsFn | null;
}

interface PreviewInput {
  targetDurationMs: number;
  slots: ClockSlot[];
  at?: Date | undefined;
  seed?: string | undefined;
}

/**
 * A plausible sample hour, in two passes. First the clock's own estimate (category averages,
 * markers, fills) gives each slot its air time; the category slots are picked at those times,
 * in one batch, with the hour's fixed items as history. Then the hour is retimed with the real
 * lengths. Fill slots stay elastic: the generator back-times them (#46), so the preview shows
 * the stretch they cover rather than one track.
 */
async function preview(
  db: Db,
  scope: StationScope,
  input: PreviewInput,
  options: PreviewOptions,
): Promise<ClockPreview> {
  const at = input.at ?? new Date();
  const seed = input.seed ?? crypto.randomUUID().slice(0, 8);
  const refs = await loadReferences(db, scope, input.slots);
  const planned = estimateWith(refs, input);
  const airsAt = (index: number) => new Date(at.getTime() + (planned.slots[index]?.startMs ?? 0));

  const library = await loadCandidates(db, scope);
  const byId = new Map(library.map((c) => [c.id, c]));
  const fixed = new Map<number, FixedPlacement>();
  const requests: PickRequest[] = [];
  for (const [slotIndex, slot] of input.slots.entries()) {
    if (slot.kind === 'asset') {
      const asset = slot.assetId ? byId.get(slot.assetId) : undefined;
      if (asset) fixed.set(slotIndex, { asset, at: airsAt(slotIndex) });
      continue;
    }
    if (slot.kind === 'fill') continue;
    const categoryId = slotCategoryId(slot);
    // Unknown categories (deleted, another station's) carry a `missing_reference` warning.
    if (categoryId && refs.categories.has(categoryId)) {
      requests.push({ categoryId, slotIndex, at: airsAt(slotIndex) });
    }
  }

  const pickSlots = options.pickSlots === undefined ? await findPickSlots() : options.pickSlots;
  const picker = pickSlots
    ? rulesPicker(pickSlots, db, scope, {
        seed,
        assetTypeOf: (id) => refs.categories.get(id)?.assetType ?? 'song',
      })
    : randomPicker(membersAt(db, scope, library), seededRandom(seed));
  const picks = await picker.pickAll(requests, [...fixed.values()]);
  const picked = new Map(requests.map((r, i) => [r.slotIndex, picks[i] ?? null]));

  const items = input.slots.map((slot, slotIndex) => {
    const pick = picked.get(slotIndex);
    const placement = fixed.get(slotIndex);
    const asset = pick?.asset ?? (placement ? summaryOf(placement.asset) : null);
    return {
      slotIndex,
      kind: slot.kind,
      asset,
      source: pick ? picker.source : placement ? ('fixed' as const) : null,
      problem: pick === null ? ('empty_category' as const) : null,
      relaxedRules: pick?.relaxedRules ?? [],
    };
  });

  // Retime with the picked lengths rather than the slots' nominal ones. A picked asset has its
  // category's type, so reference warnings are the clock's own.
  const timed = input.slots.map((slot, i) =>
    items[i]?.asset ? { ...slot, durationMs: null } : slot,
  );
  const estimate = estimateClock({ ...input, slots: timed }, (slot, i) => {
    const asset = items[i]?.asset;
    return asset
      ? { exists: true, durationMs: asset.durationMs, assetType: asset.type }
      : referenceOf(refs, slot);
  });

  return {
    items: items.map((item, i) => ({
      ...item,
      startMs: estimate.slots[i]?.startMs ?? 0,
      durationMs: estimate.slots[i]?.durationMs ?? 0,
    })),
    estimate,
    airsAt: at,
    seed,
  };
}

const summaryOf = (asset: LibraryCandidate): ClockPreviewAsset => ({
  id: asset.id,
  type: asset.type,
  title: asset.title,
  artists: asset.artists,
  durationMs: asset.durationMs,
});

/** Schedulable members of a category at an instant (start/kill windows), for random picks. */
function membersAt(db: Db, scope: StationScope, library: LibraryCandidate[]) {
  const details = new Map<string, Promise<CategoryDetail>>();
  return async (categoryId: string, when: Date) => {
    let detail = details.get(categoryId);
    if (!detail) {
      detail = getCategory(db, scope, categoryId, when);
      details.set(categoryId, detail);
    }
    return resolveCategory(await detail, library, when)
      .members.filter((m) => m.schedulable)
      .map((m) => m.asset);
  };
}

export async function previewClock(
  db: Db,
  scope: StationScope,
  id: string,
  query: ClockPreviewQuery,
  options: PreviewOptions = {},
): Promise<ClockPreview> {
  const parsed = clockPreviewQuerySchema.parse(query);
  const saved = await loadClock(db, scope, id);
  return preview(db, scope, { ...saved, ...parsed }, options);
}

export async function previewDraft(
  db: Db,
  scope: StationScope,
  draft: DraftClockPreview,
  options: PreviewOptions = {},
): Promise<ClockPreview> {
  return preview(db, scope, draftClockPreviewSchema.parse(draft), options);
}

// --- Mutations ---------------------------------------------------------------------------

/** A unique violation of the station's clock names (not of any other unique key). */
function isNameTaken(err: unknown): boolean {
  let current: unknown = err;
  while (current && typeof current === 'object') {
    const pg = current as { code?: string; constraint_name?: string };
    if (pg.code === '23505' && pg.constraint_name === 'clock_station_name_key') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** `withAudit`, with a duplicate name answered as 409 `clock_name_taken`. */
async function mutate<T>(db: Db, ctx: StationContext, fn: Parameters<typeof withAudit<T>>[2]) {
  try {
    return await withAudit(db, ctx, fn);
  } catch (error) {
    if (isNameTaken(error)) {
      throw new HttpError(409, 'clock_name_taken', 'a clock of this station has this name');
    }
    throw error;
  }
}

/** Slots may only name categories, assets and VT pools of this station. */
async function checkReferences(tx: Tx, scope: StationScope, slots: readonly ClockSlot[]) {
  const refs = await loadReferences(tx, scope, slots);
  const categoryIds = slots.map(slotCategoryId).filter((id) => id !== null);
  const unknownCategories = [...new Set(categoryIds.filter((id) => !refs.categories.has(id)))];
  if (unknownCategories.length > 0) {
    throw new HttpError(400, 'unknown_category', 'some slots name unknown categories', {
      categoryIds: unknownCategories,
    });
  }
  const poolIds = slots.map(slotPoolId).filter((id) => id !== null);
  const unknownPools = [...new Set(poolIds.filter((id) => !refs.pools.has(id)))];
  if (unknownPools.length > 0) {
    throw new HttpError(400, 'unknown_pool', 'some slots name unknown VT pools', {
      poolIds: unknownPools,
    });
  }
  const assetIds = slots.flatMap((s) => (s.kind === 'asset' && s.assetId ? [s.assetId] : []));
  const unknownAssets = [...new Set(assetIds.filter((id) => !refs.assets.has(id)))];
  if (unknownAssets.length > 0) {
    throw new HttpError(400, 'unknown_asset', 'some slots name unknown assets', {
      assetIds: unknownAssets,
    });
  }
}

async function replaceSlots(tx: Tx, scope: StationScope, clockId: string, slots: ClockSlot[]) {
  await checkReferences(tx, scope, slots);
  await tx
    .delete(clockSlot)
    .where(and(eq(clockSlot.clockId, clockId), whereStation(clockSlot, scope)));
  if (slots.length === 0) return;
  await tx.insert(clockSlot).values(slots.map((s, i) => toSlotRow(s, i, clockId, scope)));
}

async function insertClock(
  tx: Tx,
  ctx: StationContext,
  fields: {
    name: string;
    description?: string | null | undefined;
    color?: string | null | undefined;
    targetDurationMs: number;
  },
  slots: ClockSlot[],
) {
  const [row] = await tx
    .insert(clock)
    .values({ ...fields, orgId: ctx.scope.orgId, stationId: ctx.scope.stationId })
    .returning();
  if (!row) throw new Error('clock insert returned nothing');
  await replaceSlots(tx, ctx.scope, row.id, slots);
  return row;
}

export async function createClock(
  db: Db,
  ctx: StationContext,
  input: CreateClock,
): Promise<ClockDetail> {
  const { slots, ...fields } = createClockSchema.parse(input);
  const id = await mutate(db, ctx, async (tx, audit) => {
    const row = await insertClock(tx, ctx, fields, slots);
    await audit({
      action: 'clock.create',
      entity: { type: 'clock', id: row.id },
      diff: auditDiff(null, toClock(row, slots)),
    });
    return row.id;
  });
  return getClock(db, ctx.scope, id);
}

export async function updateClock(
  db: Db,
  ctx: StationContext,
  id: string,
  patch: UpdateClock,
): Promise<ClockDetail> {
  const { slots, version, ...fields } = updateClockSchema.parse(patch);
  await mutate(db, ctx, async (tx, audit) => {
    // Locked until commit: a concurrent save waits here, then sees the new version.
    const [locked] = await tx
      .select()
      .from(clock)
      .where(and(eq(clock.id, id), whereStation(clock, ctx.scope)))
      .for('update');
    if (!locked) throw new NotFoundError('clock', id);
    if (locked.version !== version) {
      throw new HttpError(409, 'edit_conflict', 'the clock was changed since this version', {
        version: locked.version,
      });
    }
    const before = toClock(locked, (await slotsOf(tx, ctx.scope, [id])).get(id) ?? []);
    // Always written, so a slots-only edit moves `updatedAt` and `version` too.
    const [after] = await tx
      .update(clock)
      .set({ ...fields, version: locked.version + 1, updatedAt: new Date() })
      .where(and(eq(clock.id, id), whereStation(clock, ctx.scope)))
      .returning();
    if (!after) throw new NotFoundError('clock', id);
    if (slots) await replaceSlots(tx, ctx.scope, id, slots);
    await audit({
      action: 'clock.update',
      entity: { type: 'clock', id },
      diff: auditDiff(before, toClock(after, slots ?? before.slots)),
    });
  });
  return getClock(db, ctx.scope, id);
}

/** A copy named "<name> (copy)", "<name> (copy 2)"…, unless a name is given. */
export async function duplicateClock(
  db: Db,
  ctx: StationContext,
  id: string,
  input: DuplicateClock,
): Promise<ClockDetail> {
  const { name } = duplicateClockSchema.parse(input);
  const newId = await mutate(db, ctx, async (tx, audit) => {
    const source = await loadClock(tx, ctx.scope, id);
    const copyName = name ?? (await freeCopyName(tx, ctx.scope, source.name));
    const row = await insertClock(
      tx,
      ctx,
      {
        name: copyName,
        description: source.description,
        color: source.color,
        targetDurationMs: source.targetDurationMs,
      },
      source.slots,
    );
    await audit({
      action: 'clock.create',
      entity: { type: 'clock', id: row.id },
      diff: auditDiff(null, { ...toClock(row, source.slots), duplicatedFrom: id }),
    });
    return row.id;
  });
  return getClock(db, ctx.scope, newId);
}

async function freeCopyName(tx: Tx, scope: StationScope, name: string): Promise<string> {
  const taken = new Set(
    (await tx.select({ name: clock.name }).from(clock).where(whereStation(clock, scope))).map((r) =>
      r.name.toLowerCase(),
    ),
  );
  const base = name.slice(0, 85);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${base} (copy)` : `${base} (copy ${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export async function deleteClock(db: Db, ctx: StationContext, id: string): Promise<void> {
  await mutate(db, ctx, async (tx, audit) => {
    const before = await loadClock(tx, ctx.scope, id);
    // The weekly grid (#40) may refuse; painted hours go with the clock.
    await releaseClockFromGrid(tx, ctx.scope, id);
    await tx.delete(clock).where(and(eq(clock.id, id), whereStation(clock, ctx.scope)));
    await audit({
      action: 'clock.delete',
      entity: { type: 'clock', id },
      diff: auditDiff(before, null),
    });
  });
}
