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
  whereStation,
  withAudit,
} from '@ondes/db';
import { resolveCategory } from '@ondes/scheduling';
import {
  type Clock,
  type ClockDetail,
  type ClockList,
  type ClockPreview,
  type ClockPreviewItem,
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
  type UpdateClock,
  updateClockSchema,
} from '@ondes/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';
import { getCategory, type LibraryCandidate, loadCandidates } from '../rotation/repo.ts';
import {
  type PreviewPicker,
  type PreviewPlacement,
  randomPicker,
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
    ...(row.kind === 'vt' ? { mode: row.vtMode } : {}),
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
    categoryId: 'categoryId' in slot ? slot.categoryId : null,
    assetId: slot.kind === 'asset' ? slot.assetId : null,
    vtMode: slot.kind === 'vt' ? slot.mode : null,
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
  const [categories, assets] = await Promise.all([
    categoryIds.length === 0 ? [] : categoryAverages(db, scope, categoryIds),
    assetIds.length === 0
      ? []
      : db
          .select({ id: asset.id, type: asset.type, durationMs: asset.durationMs })
          .from(asset)
          .where(and(whereStation(asset, scope), inArray(asset.id, assetIds))),
  ]);
  return {
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
  /** #38's picker; the random fallback without it. */
  picker?: PreviewPicker;
}

/**
 * A plausible sample hour: each picking slot filled from its category, each asset slot with
 * its asset, timed with the real lengths. Same seed and library, same picks (random picker).
 */
async function preview(
  db: Db,
  scope: StationScope,
  input: {
    targetDurationMs: number;
    slots: ClockSlot[];
    at?: Date | undefined;
    seed?: string | undefined;
  },
  options: PreviewOptions,
): Promise<ClockPreview> {
  const at = input.at ?? new Date();
  const seed = input.seed ?? crypto.randomUUID().slice(0, 8);
  const refs = await loadReferences(db, scope, input.slots);

  let candidates: Promise<LibraryCandidate[]> | undefined;
  const members = new Map<string, Promise<LibraryCandidate[]>>();
  const membersOf = (categoryId: string, when: Date) => {
    let list = members.get(categoryId);
    if (!list) {
      candidates ??= loadCandidates(db, scope);
      list = Promise.all([getCategory(db, scope, categoryId, when), candidates]).then(
        ([detail, all]) =>
          resolveCategory(detail, all, when)
            .members.filter((m) => m.schedulable)
            .map((m) => m.asset),
      );
      members.set(categoryId, list);
    }
    return list;
  };
  const picker = options.picker ?? randomPicker(membersOf, seededRandom(seed));

  const fixed = await fixedAssets(db, scope, input.slots);
  const history: PreviewPlacement[] = [];
  const items: Omit<ClockPreviewItem, 'startMs' | 'durationMs'>[] = [];
  let elapsed = 0;
  for (const [slotIndex, slot] of input.slots.entries()) {
    const startsAt = new Date(at.getTime() + elapsed);
    const item: (typeof items)[number] = {
      slotIndex,
      kind: slot.kind,
      asset: null,
      source: null,
      problem: null,
      relaxedRules: [],
    };
    const categoryId = slotCategoryId(slot);
    let picked: LibraryCandidate | undefined;
    if (slot.kind === 'asset' && slot.assetId) {
      picked = fixed.get(slot.assetId);
      if (picked) item.source = 'fixed';
    } else if (categoryId && refs.categories.has(categoryId)) {
      const pick = await picker.pick({ categoryId, slotIndex, at: startsAt, history });
      if (pick) {
        picked = pick.asset;
        item.source = picker.source;
        item.relaxedRules = pick.relaxedRules;
      } else {
        item.problem = 'empty_category';
      }
    }
    if (picked) {
      item.asset = {
        id: picked.id,
        type: picked.type,
        title: picked.title,
        artists: picked.artists,
        durationMs: picked.durationMs,
      };
      history.push({ asset: picked, categoryId, slotIndex, startsAt });
      elapsed += picked.durationMs ?? 0;
    } else {
      elapsed += slot.durationMs ?? 0;
    }
    items.push(item);
  }

  // Time the hour with the picked lengths rather than the slots' nominal ones. Unsized fills
  // stay elastic. A picked asset has its category's type, so reference warnings are the
  // clock's own.
  const timed = input.slots.map((slot, i) =>
    items[i]?.asset && slot.kind !== 'fill' ? { ...slot, durationMs: null } : slot,
  );
  const estimate = estimateClock({ ...input, slots: timed }, (slot, i) => {
    const picked = items[i]?.asset;
    return picked && slot.kind !== 'fill'
      ? { exists: true, durationMs: picked.durationMs, assetType: picked.type }
      : referenceOf(refs, slot);
  });

  return {
    items: items.map((item, i) => ({
      ...item,
      startMs: estimate.slots[i]?.startMs ?? 0,
      durationMs: estimate.slots[i]?.durationMs ?? 0,
    })),
    estimate,
    at,
    seed,
  };
}

/** The assets asset slots name, in this station, as candidates. */
async function fixedAssets(db: Db, scope: StationScope, slots: readonly ClockSlot[]) {
  const ids = [
    ...new Set(slots.flatMap((s) => (s.kind === 'asset' && s.assetId ? [s.assetId] : []))),
  ];
  const found = new Map<string, LibraryCandidate>();
  if (ids.length === 0) return found;
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
      addedAt: asset.createdAt,
    })
    .from(asset)
    .where(and(whereStation(asset, scope), inArray(asset.id, ids)));
  for (const row of rows) found.set(row.id, { ...row, tags: [] });
  return found;
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

function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  while (current && typeof current === 'object') {
    if ((current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** `withAudit`, with a duplicate name answered as 409 `clock_name_taken`. */
async function mutate<T>(db: Db, ctx: StationContext, fn: Parameters<typeof withAudit<T>>[2]) {
  try {
    return await withAudit(db, ctx, fn);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, 'clock_name_taken', 'a clock of this station has this name');
    }
    throw error;
  }
}

/** Slots may only name categories and assets of this station. */
async function checkReferences(tx: Tx, scope: StationScope, slots: readonly ClockSlot[]) {
  const refs = await loadReferences(tx, scope, slots);
  const categoryIds = slots.map(slotCategoryId).filter((id) => id !== null);
  const unknownCategories = [...new Set(categoryIds.filter((id) => !refs.categories.has(id)))];
  if (unknownCategories.length > 0) {
    throw new HttpError(400, 'unknown_category', 'some slots name unknown categories', {
      categoryIds: unknownCategories,
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
  const { slots, ...fields } = updateClockSchema.parse(patch);
  await mutate(db, ctx, async (tx, audit) => {
    const before = await loadClock(tx, ctx.scope, id);
    // Always written, so a slots-only edit moves `updatedAt` too.
    const [after] = await tx
      .update(clock)
      .set({ ...fields, updatedAt: new Date() })
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
    await tx.delete(clock).where(and(eq(clock.id, id), whereStation(clock, ctx.scope)));
    await audit({
      action: 'clock.delete',
      entity: { type: 'clock', id },
      diff: auditDiff(before, null),
    });
  });
}
