import {
  asset,
  auditDiff,
  type Db,
  type Executor,
  island,
  logItem,
  type MutationContext,
  NotFoundError,
  type StationScope,
  segue,
  showHost,
  showSlot,
  type Tx,
  whereStation,
  withAudit,
} from '@ondes/db';
import {
  type Actor,
  type CreateSegue,
  createSegueSchema,
  type Island as IslandDto,
  type IslandSummary,
  type ListIslandsQuery,
  type ListSeguesQuery,
  listIslandsQuerySchema,
  type Segue,
  type UpdateSegue,
  updateSegueSchema,
} from '@ondes/shared';
import { and, asc, desc, eq, gte, inArray, lt, or } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';
import { type IslandRow, type SyncResult, type SyncSeeds, syncSegues } from './sync.ts';

// Segues and islands (#55): reads, and the audited segue writes. Every write re-syncs the
// chains it touches (`sync.ts`) in the same transaction, so a response always carries the
// segue's status and island as they are now. Islands have no write route: they are derived.
//
// A and B are checked at save time (in the station, top-level, playing an asset); being
// consecutive is the sync's call, so a segue saved on items that aren't consecutive is kept but
// `detached` (the editor shows why). Voice assets must exist in the station; a voice without a
// playout copy yet leaves the segue `waiting`.

export interface StationContext extends MutationContext {
  actor: Actor;
  scope: StationScope;
}

type SegueRow = typeof segue.$inferSelect;

export function toIslandSummary(row: IslandRow): IslandSummary {
  return {
    id: row.id,
    stationId: row.stationId,
    hash: row.hash,
    status: row.status,
    head: {
      itemId: row.headItemId,
      assetId: row.headAssetId,
      joinSample: row.headJoinSample,
      hasBody: row.headHasBody,
    },
    tail: {
      itemId: row.tailItemId,
      assetId: row.tailAssetId,
      joinSample: row.tailJoinSample,
      hasBody: row.tailHasBody,
    },
    segueIds: row.segueIds,
    itemIds: row.itemIds,
    lengthSamples: row.lengthSamples,
    storageKey: row.storageKey,
    error: row.error,
    renderedAt: row.renderedAt,
    updatedAt: row.updatedAt,
  };
}

function toSegue(row: SegueRow, islandRow: IslandRow | null): Segue {
  return {
    id: row.id,
    stationId: row.stationId,
    fromItemId: row.fromItemId,
    toItemId: row.toItemId,
    fromAssetId: row.fromAssetId,
    toAssetId: row.toAssetId,
    out: row.outLane,
    in: row.inLane,
    voices: row.voices,
    origin: row.origin,
    status: row.status,
    problem:
      row.problemCode && row.problemMessage
        ? { code: row.problemCode, message: row.problemMessage }
        : null,
    island: islandRow ? toIslandSummary(islandRow) : null,
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function withIslands(db: Executor, scope: StationScope, rows: SegueRow[]) {
  const ids = [...new Set(rows.flatMap((r) => (r.islandId ? [r.islandId] : [])))];
  const islands = ids.length
    ? await db
        .select()
        .from(island)
        .where(and(whereStation(island, scope), inArray(island.id, ids)))
    : [];
  const byId = new Map(islands.map((i) => [i.id, i]));
  return rows.map((r) => toSegue(r, r.islandId ? (byId.get(r.islandId) ?? null) : null));
}

async function segueRow(db: Executor, scope: StationScope, segueId: string, lock = false) {
  const query = db
    .select()
    .from(segue)
    .where(and(eq(segue.id, segueId), whereStation(segue, scope)));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new NotFoundError('segue', segueId);
  return row;
}

export async function getSegue(db: Executor, scope: StationScope, segueId: string) {
  const [dto] = await withIslands(db, scope, [await segueRow(db, scope, segueId)]);
  return dto as Segue;
}

export async function listSegues(
  db: Executor,
  scope: StationScope,
  query: ListSeguesQuery,
): Promise<Segue[]> {
  let rows: SegueRow[];
  if ('itemId' in query) {
    rows = await db
      .select()
      .from(segue)
      .where(
        and(
          whereStation(segue, scope),
          or(eq(segue.fromItemId, query.itemId), eq(segue.toItemId, query.itemId)),
        ),
      );
  } else if ('status' in query) {
    rows = await db
      .select()
      .from(segue)
      .where(and(whereStation(segue, scope), eq(segue.status, query.status)))
      .orderBy(desc(segue.updatedAt))
      .limit(500);
  } else {
    rows = (
      await db
        .select({ segue })
        .from(segue)
        .innerJoin(logItem, eq(logItem.id, segue.fromItemId))
        .where(
          and(
            whereStation(segue, scope),
            whereStation(logItem, scope),
            gte(logItem.plannedStart, new Date(query.from)),
            lt(logItem.plannedStart, new Date(query.to)),
          ),
        )
        .orderBy(asc(logItem.plannedStart))
    ).map((r) => r.segue);
  }
  return withIslands(db, scope, rows);
}

// --- Writes ------------------------------------------------------------------------------

/** A and B: in the station, top-level items that play an asset. Returns their assets. */
async function checkItems(tx: Tx, scope: StationScope, fromItemId: string, toItemId: string) {
  if (fromItemId === toItemId)
    throw new HttpError(422, 'invalid_segue', 'A and B are the same item');
  const rows = await tx
    .select({
      id: logItem.id,
      kind: logItem.kind,
      assetId: logItem.assetId,
      segmentId: logItem.segmentId,
    })
    .from(logItem)
    .where(and(whereStation(logItem, scope), inArray(logItem.id, [fromItemId, toItemId])));
  const get = (id: string, name: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new NotFoundError('log_item', id);
    if (row.segmentId !== null || row.kind === 'segment' || !row.assetId) {
      throw new HttpError(
        422,
        'invalid_segue',
        `${name} must be a top-level item playing an asset`,
      );
    }
    return row.assetId;
  };
  return { fromAssetId: get(fromItemId, 'A'), toAssetId: get(toItemId, 'B') };
}

async function checkVoiceAssets(tx: Tx, scope: StationScope, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const rows = await tx
    .select({ id: asset.id })
    .from(asset)
    .where(and(whereStation(asset, scope), inArray(asset.id, unique)));
  const found = new Set(rows.map((r) => r.id));
  const missing = unique.find((id) => !found.has(id));
  if (missing) throw new HttpError(422, 'invalid_segue', `voice asset ${missing} not found`);
}

/** One segue per transition: the unique keys on A and B. */
function conflictOf(error: unknown): never {
  const e = error as { cause?: { code?: string; constraint_name?: string }; code?: string };
  const code = e.cause?.code ?? e.code;
  if (code === '23505') {
    throw new HttpError(409, 'segue_exists', 'this transition already has a segue');
  }
  throw error;
}

/**
 * `voice_track:write_own` (presenters): A or B belongs to a show the user hosts (the item's
 * origin show slot). `voice_track:write` needs no check.
 */
export async function hostsItems(
  db: Executor,
  scope: StationScope,
  userId: string,
  itemIds: string[],
): Promise<boolean> {
  if (!itemIds.length) return false;
  const [row] = await db
    .select({ id: logItem.id })
    .from(logItem)
    .innerJoin(showSlot, eq(showSlot.id, logItem.originShowSlotId))
    .innerJoin(showHost, and(eq(showHost.showId, showSlot.showId), eq(showHost.userId, userId)))
    .where(and(whereStation(logItem, scope), inArray(logItem.id, itemIds)))
    .limit(1);
  return row !== undefined;
}

export type SegueWrite = { segue: Segue | null; sync: SyncResult };

const auditable = (row: SegueRow) => ({
  fromItemId: row.fromItemId,
  toItemId: row.toItemId,
  fromAssetId: row.fromAssetId,
  toAssetId: row.toAssetId,
  outLane: row.outLane,
  inLane: row.inLane,
  voices: row.voices,
  origin: row.origin,
  version: row.version,
});

async function write(
  db: Db,
  ctx: StationContext,
  fn: (
    tx: Tx,
    audit: Parameters<Parameters<typeof withAudit>[2]>[1],
  ) => Promise<{
    segueId: string | null;
    seeds: SyncSeeds;
  }>,
): Promise<SegueWrite> {
  try {
    return await withAudit(db, ctx, async (tx, audit) => {
      const { segueId, seeds } = await fn(tx, audit);
      const sync = await syncSegues(tx, ctx.scope, seeds);
      return { segue: segueId ? await getSegue(tx, ctx.scope, segueId) : null, sync };
    });
  } catch (error) {
    conflictOf(error);
  }
}

export async function createSegue(
  db: Db,
  ctx: StationContext,
  input: CreateSegue,
): Promise<SegueWrite> {
  const parsed = createSegueSchema.parse(input);
  return write(db, ctx, async (tx, audit) => {
    const assets = await checkItems(tx, ctx.scope, parsed.fromItemId, parsed.toItemId);
    await checkVoiceAssets(
      tx,
      ctx.scope,
      parsed.voices.map((v) => v.assetId),
    );
    const [row] = await tx
      .insert(segue)
      .values({
        orgId: ctx.scope.orgId,
        stationId: ctx.scope.stationId,
        fromItemId: parsed.fromItemId,
        toItemId: parsed.toItemId,
        ...assets,
        outLane: parsed.out,
        inLane: parsed.in,
        voices: parsed.voices,
        origin: parsed.origin,
        createdBy: ctx.actor.type === 'user' ? ctx.actor.userId : null,
      })
      .returning();
    if (!row) throw new Error('insert returned no row');
    await audit({
      action: 'segue.create',
      entity: { type: 'segue', id: row.id },
      diff: auditDiff(null, auditable(row)),
    });
    return { segueId: row.id, seeds: { segueIds: [row.id] } };
  });
}

export async function updateSegue(
  db: Db,
  ctx: StationContext,
  segueId: string,
  input: UpdateSegue,
): Promise<SegueWrite> {
  const parsed = updateSegueSchema.parse(input);
  return write(db, ctx, async (tx, audit) => {
    const before = await segueRow(tx, ctx.scope, segueId, true);
    if (parsed.version !== undefined && parsed.version !== before.version) {
      throw new HttpError(
        409,
        'version_conflict',
        `the segue is at version ${before.version}; reload it before saving`,
      );
    }
    const fromItemId = parsed.fromItemId ?? before.fromItemId;
    const toItemId = parsed.toItemId ?? before.toItemId;
    if (!fromItemId || !toItemId) {
      throw new HttpError(422, 'invalid_segue', 'A or B was deleted: choose the items again');
    }
    // Saving re-reads A's and B's assets: it re-attaches a segue detached by `asset_changed`.
    const assets = await checkItems(tx, ctx.scope, fromItemId, toItemId);
    await checkVoiceAssets(
      tx,
      ctx.scope,
      parsed.voices.map((v) => v.assetId),
    );
    const [after] = await tx
      .update(segue)
      .set({
        fromItemId,
        toItemId,
        ...assets,
        outLane: parsed.out,
        inLane: parsed.in,
        voices: parsed.voices,
        origin: parsed.origin ?? before.origin,
        version: before.version + 1,
      })
      .where(and(eq(segue.id, segueId), whereStation(segue, ctx.scope)))
      .returning();
    if (!after) throw new NotFoundError('segue', segueId);
    await audit({
      action: 'segue.update',
      entity: { type: 'segue', id: segueId },
      diff: auditDiff(auditable(before), auditable(after)),
    });
    const itemIds = [before.fromItemId, before.toItemId].filter((id): id is string => !!id);
    return { segueId, seeds: { segueIds: [segueId], itemIds } };
  });
}

export async function deleteSegue(
  db: Db,
  ctx: StationContext,
  segueId: string,
): Promise<SegueWrite & { deleted: SegueRow }> {
  let deleted: SegueRow | undefined;
  const result = await write(db, ctx, async (tx, audit) => {
    const before = await segueRow(tx, ctx.scope, segueId, true);
    await tx.delete(segue).where(and(eq(segue.id, segueId), whereStation(segue, ctx.scope)));
    await audit({
      action: 'segue.delete',
      entity: { type: 'segue', id: segueId },
      diff: auditDiff(auditable(before), null),
    });
    deleted = before;
    // The neighbours' chains may split; the island goes if nothing else renders it.
    const itemIds = [before.fromItemId, before.toItemId].filter((id): id is string => !!id);
    return { segueId: null, seeds: { itemIds } };
  });
  return { ...result, deleted: deleted as SegueRow };
}

// --- Islands -----------------------------------------------------------------------------

export async function getIsland(
  db: Executor,
  scope: StationScope,
  islandId: string,
): Promise<IslandDto> {
  const [row] = await db
    .select()
    .from(island)
    .where(and(eq(island.id, islandId), whereStation(island, scope)));
  if (!row) throw new NotFoundError('island', islandId);
  return { ...toIslandSummary(row), spec: row.spec };
}

export async function listIslands(
  db: Executor,
  scope: StationScope,
  input: ListIslandsQuery,
): Promise<IslandSummary[]> {
  const query = listIslandsQuerySchema.parse(input);
  const rows = await db
    .select()
    .from(island)
    .where(
      and(whereStation(island, scope), query.status ? eq(island.status, query.status) : undefined),
    )
    .orderBy(asc(island.updatedAt))
    .limit(query.limit);
  return rows.map(toIslandSummary);
}
