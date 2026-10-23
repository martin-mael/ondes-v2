import {
  asRunEntry,
  asset,
  auditDiff,
  type Db,
  type Executor,
  type MutationContext,
  NotFoundError,
  promo,
  promoPlacement,
  type StationScope,
  show,
  station,
  type Tx,
  updateAsset,
  vtPool,
  vtPoolMember,
  whereStation,
  withAudit,
} from '@ondes/db';
import {
  addDays,
  type CreatePromo,
  type CreateVtPool,
  createPromoSchema,
  createVtPoolSchema,
  daysBetween,
  type ListPromosQuery,
  type LocalDate,
  listPromosQuerySchema,
  localDateOf,
  localDayBounds,
  PROMO_PLAYS_MAX_DAYS,
  type Promo,
  type PromoPlayCounts,
  type PromoPlays,
  type PromoPlaysQuery,
  promoPlaysQuerySchema,
  promoStatus,
  type UpdatePromo,
  type UpdateVtPool,
  updatePromoSchema,
  updateVtPoolSchema,
  type VtPool,
} from '@ondes/shared';
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';
import { uuidArray } from '../library/search-repo.ts';

// Promo VTs and VT pools (#60, ADR 0032): storage and play counts. Every function takes the
// station scope and filters on it; every mutation runs in `withAudit`. A promo's validity is
// its asset's `startAt`/`killAt`: writing them goes through the library's `updateAsset` (its own
// audit row) inside the promo's transaction.
//
// Plays: planned ones are the generator's placements (`promo_placement`, pending or placed, from
// now on); aired ones come from the as-run, as a `vt` item playing the asset or as a voice of a
// transition (`as_run_entry.transition.voices`), counted when the voice started before its entry
// left the air.

export interface StationContext extends MutationContext {
  scope: StationScope;
}

type PoolRow = typeof vtPool.$inferSelect;
type PromoRow = typeof promo.$inferSelect;

async function timeZoneOf(db: Executor, scope: StationScope): Promise<string> {
  const [row] = await db
    .select({ timezone: station.timezone })
    .from(station)
    .where(and(eq(station.id, scope.stationId), eq(station.orgId, scope.orgId)));
  if (!row) throw new NotFoundError('station', scope.stationId);
  return row.timezone;
}

/** A timestamp parameter for raw SQL (the driver takes strings there, not `Date`s). */
const ts = (at: Date) => sql`${at.toISOString()}::timestamptz`;

function pgCode(error: unknown): string | undefined {
  const e = error as { cause?: { code?: string }; code?: string };
  return e.cause?.code ?? e.code;
}

// --- Pools ---------------------------------------------------------------------------------

export async function listPools(db: Executor, scope: StationScope, now = new Date()) {
  const rows = await db
    .select()
    .from(vtPool)
    .where(whereStation(vtPool, scope))
    .orderBy(asc(sql`lower(${vtPool.name})`));
  const counts = rows.length
    ? await db
        .select({
          poolId: vtPoolMember.poolId,
          promoCount: sql<number>`count(*)::int`,
          activeCount: sql<number>`(count(*) filter (where ${promo.enabled}
            and (${asset.startAt} is null or ${asset.startAt} <= ${ts(now)})
            and (${asset.killAt} is null or ${asset.killAt} > ${ts(now)})))::int`,
        })
        .from(vtPoolMember)
        .innerJoin(promo, eq(promo.id, vtPoolMember.promoId))
        .innerJoin(asset, eq(asset.id, promo.assetId))
        .where(whereStation(vtPoolMember, scope))
        .groupBy(vtPoolMember.poolId)
    : [];
  const byPool = new Map(counts.map((c) => [c.poolId, c]));
  return rows.map((row) => toPool(row, byPool.get(row.id)));
}

function toPool(row: PoolRow, counts?: { promoCount: number; activeCount: number }): VtPool {
  return {
    id: row.id,
    stationId: row.stationId,
    name: row.name,
    description: row.description,
    color: row.color,
    promoCount: counts?.promoCount ?? 0,
    activeCount: counts?.activeCount ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getPool(db: Executor, scope: StationScope, poolId: string) {
  const pool = (await listPools(db, scope)).find((p) => p.id === poolId);
  if (!pool) throw new NotFoundError('vt_pool', poolId);
  return pool;
}

const poolNameTaken = (error: unknown) => {
  if (pgCode(error) === '23505') {
    throw new HttpError(409, 'name_taken', 'a VT pool with this name already exists');
  }
  throw error;
};

const auditablePool = (row: PoolRow) => ({
  name: row.name,
  description: row.description,
  color: row.color,
});

export async function createPool(db: Db, ctx: StationContext, input: CreateVtPool) {
  const values = createVtPoolSchema.parse(input);
  const id = await withAudit(db, ctx, async (tx, audit) => {
    const [row] = await tx
      .insert(vtPool)
      .values({ orgId: ctx.scope.orgId, stationId: ctx.scope.stationId, ...values })
      .returning();
    if (!row) throw new Error('insert returned no row');
    await audit({
      action: 'vt_pool.create',
      entity: { type: 'vt_pool', id: row.id },
      diff: auditDiff(null, auditablePool(row)),
    });
    return row.id;
  }).catch(poolNameTaken);
  return getPool(db, ctx.scope, id);
}

export async function updatePool(db: Db, ctx: StationContext, poolId: string, input: UpdateVtPool) {
  const values = updateVtPoolSchema.parse(input);
  await withAudit(db, ctx, async (tx, audit) => {
    const before = await poolRow(tx, ctx.scope, poolId);
    const [after] = await tx
      .update(vtPool)
      .set(values)
      .where(and(eq(vtPool.id, poolId), whereStation(vtPool, ctx.scope)))
      .returning();
    if (!after) throw new NotFoundError('vt_pool', poolId);
    await audit({
      action: 'vt_pool.update',
      entity: { type: 'vt_pool', id: poolId },
      diff: auditDiff(auditablePool(before), auditablePool(after)),
    });
  }).catch(poolNameTaken);
  return getPool(db, ctx.scope, poolId);
}

/** Deletes a pool. Its clock slots lose their pool (`set null`): the clock shows a warning. */
export async function deletePool(db: Db, ctx: StationContext, poolId: string) {
  await withAudit(db, ctx, async (tx, audit) => {
    const before = await poolRow(tx, ctx.scope, poolId);
    await tx.delete(vtPool).where(and(eq(vtPool.id, poolId), whereStation(vtPool, ctx.scope)));
    await audit({
      action: 'vt_pool.delete',
      entity: { type: 'vt_pool', id: poolId },
      diff: auditDiff(auditablePool(before), null),
    });
  });
}

async function poolRow(tx: Executor, scope: StationScope, poolId: string, lock = true) {
  const query = tx
    .select()
    .from(vtPool)
    .where(and(eq(vtPool.id, poolId), whereStation(vtPool, scope)));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new NotFoundError('vt_pool', poolId);
  return row;
}

// --- Promos --------------------------------------------------------------------------------

/** The station's promos, with their asset, pools and play counts. */
export async function listPromos(
  db: Executor,
  scope: StationScope,
  query: ListPromosQuery = {},
  now = new Date(),
): Promise<Promo[]> {
  const q = listPromosQuerySchema.parse(query);
  const promos = await loadPromos(db, scope, undefined, now);
  return promos.filter(
    (p) => (!q.poolId || p.poolIds.includes(q.poolId)) && (!q.status || p.status === q.status),
  );
}

export async function getPromo(
  db: Executor,
  scope: StationScope,
  promoId: string,
  now = new Date(),
) {
  const [found] = await loadPromos(db, scope, [promoId], now);
  if (!found) throw new NotFoundError('promo', promoId);
  return found;
}

async function loadPromos(
  db: Executor,
  scope: StationScope,
  ids: string[] | undefined,
  now: Date,
): Promise<Promo[]> {
  const rows = await db
    .select({
      promo,
      title: asset.title,
      assetType: asset.type,
      durationMs: asset.durationMs,
      startAt: asset.startAt,
      killAt: asset.killAt,
      showName: show.name,
    })
    .from(promo)
    .innerJoin(asset, eq(asset.id, promo.assetId))
    .leftJoin(show, eq(show.id, promo.showId))
    .where(and(whereStation(promo, scope), ids ? inArray(promo.id, ids) : undefined))
    .orderBy(asc(asset.title), asc(promo.id));
  if (rows.length === 0) return [];
  const promoIds = rows.map((r) => r.promo.id);
  const members = await db
    .select({ poolId: vtPoolMember.poolId, promoId: vtPoolMember.promoId })
    .from(vtPoolMember)
    .where(and(whereStation(vtPoolMember, scope), inArray(vtPoolMember.promoId, promoIds)));
  const pools = new Map<string, string[]>();
  for (const m of members) pools.set(m.promoId, [...(pools.get(m.promoId) ?? []), m.poolId]);
  const counts = await playCounts(
    db,
    scope,
    rows.map((r) => ({ promoId: r.promo.id, assetId: r.promo.assetId })),
    now,
  );
  return rows.map((r) => ({
    id: r.promo.id,
    stationId: r.promo.stationId,
    assetId: r.promo.assetId,
    title: r.title,
    assetType: r.assetType,
    durationMs: r.durationMs,
    startAt: r.startAt,
    killAt: r.killAt,
    showId: r.promo.showId,
    showName: r.showName,
    eventName: r.promo.eventName,
    eventAt: r.promo.eventAt,
    weight: r.promo.weight,
    maxPlaysPerDay: r.promo.maxPlaysPerDay,
    dayparts: r.promo.dayparts,
    poolIds: (pools.get(r.promo.id) ?? []).sort(),
    enabled: r.promo.enabled,
    status: promoStatus({ enabled: r.promo.enabled, startAt: r.startAt, killAt: r.killAt }, now),
    plays: counts.get(r.promo.id) ?? emptyCounts(),
    version: r.promo.version,
    createdAt: r.promo.createdAt,
    updatedAt: r.promo.updatedAt,
  }));
}

const emptyCounts = (): PromoPlayCounts => ({
  airedToday: 0,
  aired7d: 0,
  airedTotal: 0,
  planned: 0,
  lastAiredAt: null,
});

/**
 * Aired plays of these assets: `vt` items playing them, and voices of the transitions they
 * were part of (counted when the voice started before its entry left the air).
 */
function airedPlays(scope: StationScope, assetIds: string[]) {
  const ids = uuidArray(assetIds);
  return sql`
    select e.id as entry_id, e.asset_id, e.started_at as at
      from ${asRunEntry} e
     where e.station_id = ${scope.stationId} and e.kind = 'vt' and e.asset_id = any(${ids})
    union all
    select e.id as entry_id, (v->>'assetId')::uuid as asset_id,
           e.started_at + ((v->>'offsetMs')::int * interval '1 millisecond') as at
      from ${asRunEntry} e
      cross join lateral jsonb_array_elements(e.transition->'voices') v
     where e.station_id = ${scope.stationId}
       and e.transition is not null
       and (v->>'assetId')::uuid = any(${ids})
       and (e.ended_at is null
            or e.started_at + ((v->>'offsetMs')::int * interval '1 millisecond') < e.ended_at)`;
}

async function playCounts(
  db: Executor,
  scope: StationScope,
  promos: { promoId: string; assetId: string }[],
  now: Date,
): Promise<Map<string, PromoPlayCounts>> {
  const timeZone = await timeZoneOf(db, scope);
  const today = localDayBounds(localDateOf(now, timeZone), timeZone).startsAt;
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const aired = (await db.execute(sql`
    select p.asset_id,
           count(*) filter (where p.at >= ${ts(today)})::int as today,
           count(*) filter (where p.at >= ${ts(weekAgo)})::int as week,
           count(*)::int as total,
           max(p.at) as last
      from (${airedPlays(
        scope,
        promos.map((p) => p.assetId),
      )}) p
     group by p.asset_id`)) as unknown as {
    asset_id: string;
    today: number;
    week: number;
    total: number;
    last: string | Date | null;
  }[];
  const planned = await db
    .select({ promoId: promoPlacement.promoId, count: sql<number>`count(*)::int` })
    .from(promoPlacement)
    .where(
      and(
        whereStation(promoPlacement, scope),
        inArray(
          promoPlacement.promoId,
          promos.map((p) => p.promoId),
        ),
        inArray(promoPlacement.status, ['pending', 'placed']),
        gte(promoPlacement.plannedAt, now),
      ),
    )
    .groupBy(promoPlacement.promoId);
  const byAsset = new Map(aired.map((a) => [a.asset_id, a]));
  const plannedBy = new Map(planned.map((p) => [p.promoId, p.count]));
  return new Map(
    promos.map((p) => {
      const a = byAsset.get(p.assetId);
      return [
        p.promoId,
        {
          airedToday: a?.today ?? 0,
          aired7d: a?.week ?? 0,
          airedTotal: a?.total ?? 0,
          planned: plannedBy.get(p.promoId) ?? 0,
          lastAiredAt: a?.last ? new Date(a.last) : null,
        },
      ];
    }),
  );
}

/** A promo's plays, planned and aired, between two station-local dates (inclusive). */
export async function promoPlays(
  db: Executor,
  scope: StationScope,
  promoId: string,
  query: PromoPlaysQuery = {},
  now = new Date(),
): Promise<PromoPlays> {
  const q = promoPlaysQuerySchema.parse(query);
  const [row] = await db
    .select({ assetId: promo.assetId })
    .from(promo)
    .where(and(eq(promo.id, promoId), whereStation(promo, scope)));
  if (!row) throw new NotFoundError('promo', promoId);
  const timeZone = await timeZoneOf(db, scope);
  const today = localDateOf(now, timeZone);
  const from: LocalDate = q.from ?? addDays(today, -7);
  const to: LocalDate = q.to ?? addDays(today, 7);
  if (to < from) throw new HttpError(422, 'invalid_range', '`to` is before `from`');
  if (daysBetween(from, to) >= PROMO_PLAYS_MAX_DAYS) {
    throw new HttpError(
      422,
      'invalid_range',
      `at most ${PROMO_PLAYS_MAX_DAYS} days of plays at a time`,
    );
  }
  const start = localDayBounds(from, timeZone).startsAt;
  const end = localDayBounds(to, timeZone).endsAt;

  const placements = await db
    .select()
    .from(promoPlacement)
    .where(
      and(
        whereStation(promoPlacement, scope),
        eq(promoPlacement.promoId, promoId),
        gte(promoPlacement.plannedAt, start),
        lt(promoPlacement.plannedAt, end),
      ),
    )
    .orderBy(asc(promoPlacement.plannedAt));
  const aired = (await db.execute(sql`
    select p.entry_id, p.at from (${airedPlays(scope, [row.assetId])}) p
     where p.at >= ${ts(start)} and p.at < ${ts(end)}
     order by p.at`)) as unknown as { entry_id: string; at: string | Date }[];

  const items: PromoPlays['items'] = [
    // A placement whose transition has aired shows as its as-run play instead.
    ...placements
      .filter((p) => p.status === 'dropped' || p.plannedAt >= now)
      .map((p) => ({
        kind: 'planned' as const,
        playedAt: p.plannedAt,
        localDate: p.localDate,
        placementId: p.id,
        placementStatus: p.status,
        fromItemId: p.fromItemId,
        toItemId: p.toItemId,
        segueId: p.segueId,
        asRunEntryId: null,
        detail: p.detail,
      })),
    ...aired.map((a) => ({
      kind: 'aired' as const,
      playedAt: new Date(a.at),
      localDate: localDateOf(new Date(a.at), timeZone),
      placementId: null,
      placementStatus: null,
      fromItemId: null,
      toItemId: null,
      segueId: null,
      asRunEntryId: a.entry_id,
      detail: null,
    })),
  ].sort((a, b) => a.playedAt.getTime() - b.playedAt.getTime());
  const byDay = new Map<LocalDate, number>();
  for (const a of aired) {
    const date = localDateOf(new Date(a.at), timeZone);
    byDay.set(date, (byDay.get(date) ?? 0) + 1);
  }
  const airedByDay: PromoPlays['airedByDay'] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    airedByDay.push({ date: d, count: byDay.get(d) ?? 0 });
  }
  return { promoId, from, to, items, airedByDay };
}

const auditablePromo = (row: PromoRow, poolIds: string[]) => ({
  assetId: row.assetId,
  showId: row.showId,
  eventName: row.eventName,
  eventAt: row.eventAt,
  weight: row.weight,
  maxPlaysPerDay: row.maxPlaysPerDay,
  dayparts: row.dayparts,
  enabled: row.enabled,
  poolIds,
  version: row.version,
});

/** The pools and show a promo names must be the station's. */
async function checkReferences(
  tx: Tx,
  scope: StationScope,
  refs: { poolIds?: string[] | undefined; showId?: string | null | undefined },
) {
  if (refs.poolIds?.length) {
    const found = await tx
      .select({ id: vtPool.id })
      .from(vtPool)
      .where(and(whereStation(vtPool, scope), inArray(vtPool.id, refs.poolIds)));
    if (found.length !== refs.poolIds.length) {
      throw new HttpError(422, 'unknown_pool', 'a VT pool is not in this station');
    }
  }
  if (refs.showId) {
    const [found] = await tx
      .select({ id: show.id })
      .from(show)
      .where(and(eq(show.id, refs.showId), whereStation(show, scope)));
    if (!found) throw new HttpError(422, 'unknown_show', 'the show is not in this station');
  }
}

/**
 * A start or kill date sent alone is checked against the other one the asset has: the kill date
 * must come after the start (422, not the library's own conflict).
 */
async function checkValidity(
  tx: Tx,
  scope: StationScope,
  assetId: string,
  values: { startAt?: Date | null | undefined; killAt?: Date | null | undefined },
) {
  const [row] = await tx
    .select({ startAt: asset.startAt, killAt: asset.killAt })
    .from(asset)
    .where(and(eq(asset.id, assetId), whereStation(asset, scope)));
  if (!row) throw new NotFoundError('asset', assetId);
  const startAt = values.startAt !== undefined ? values.startAt : row.startAt;
  const killAt = values.killAt !== undefined ? values.killAt : row.killAt;
  if (startAt && killAt && killAt.getTime() <= startAt.getTime()) {
    throw new HttpError(422, 'invalid_validity', 'the kill date must be after the start date');
  }
}

async function setPools(tx: Tx, scope: StationScope, promoId: string, poolIds: string[]) {
  await tx
    .delete(vtPoolMember)
    .where(and(whereStation(vtPoolMember, scope), eq(vtPoolMember.promoId, promoId)));
  if (poolIds.length) {
    await tx.insert(vtPoolMember).values(
      poolIds.map((poolId) => ({
        poolId,
        promoId,
        orgId: scope.orgId,
        stationId: scope.stationId,
      })),
    );
  }
}

/** Makes a `vt` asset of the station a promo. 409 if it already is one. */
export async function createPromo(db: Db, ctx: StationContext, input: CreatePromo) {
  const values = createPromoSchema.parse(input);
  const id = await withAudit(db, ctx, async (tx, audit) => {
    const [target] = await tx
      .select({ id: asset.id, type: asset.type })
      .from(asset)
      .where(and(eq(asset.id, values.assetId), whereStation(asset, ctx.scope)));
    if (!target) throw new HttpError(422, 'unknown_asset', 'the asset is not in this station');
    if (target.type !== 'vt') {
      throw new HttpError(422, 'not_a_voice_track', 'a promo must be a voice track (vt) asset');
    }
    await checkReferences(tx, ctx.scope, values);
    if (values.startAt !== undefined || values.killAt !== undefined) {
      await checkValidity(tx, ctx.scope, values.assetId, values);
      await updateAsset(tx, ctx, values.assetId, {
        ...(values.startAt !== undefined ? { startAt: values.startAt } : {}),
        ...(values.killAt !== undefined ? { killAt: values.killAt } : {}),
      });
    }
    const [row] = await tx
      .insert(promo)
      .values({
        orgId: ctx.scope.orgId,
        stationId: ctx.scope.stationId,
        assetId: values.assetId,
        showId: values.showId,
        eventName: values.eventName,
        eventAt: values.eventAt,
        weight: values.weight,
        maxPlaysPerDay: values.maxPlaysPerDay,
        dayparts: values.dayparts,
        enabled: values.enabled,
      })
      .returning();
    if (!row) throw new Error('insert returned no row');
    await setPools(tx, ctx.scope, row.id, values.poolIds);
    await audit({
      action: 'promo.create',
      entity: { type: 'promo', id: row.id },
      diff: auditDiff(null, auditablePromo(row, values.poolIds)),
    });
    return row.id;
  }).catch((error: unknown) => {
    if (pgCode(error) === '23505') {
      throw new HttpError(409, 'promo_exists', 'this voice track is already a promo');
    }
    throw error;
  });
  return getPromo(db, ctx.scope, id);
}

export async function updatePromo(
  db: Db,
  ctx: StationContext,
  promoId: string,
  input: UpdatePromo,
) {
  const values = updatePromoSchema.parse(input);
  await withAudit(db, ctx, async (tx, audit) => {
    const [before] = await tx
      .select()
      .from(promo)
      .where(and(eq(promo.id, promoId), whereStation(promo, ctx.scope)))
      .for('update');
    if (!before) throw new NotFoundError('promo', promoId);
    if (values.version !== undefined && values.version !== before.version) {
      throw new HttpError(
        409,
        'version_conflict',
        `the promo is at version ${before.version}; reload it before saving`,
      );
    }
    await checkReferences(tx, ctx.scope, values);
    const beforePools = (
      await tx
        .select({ poolId: vtPoolMember.poolId })
        .from(vtPoolMember)
        .where(and(whereStation(vtPoolMember, ctx.scope), eq(vtPoolMember.promoId, promoId)))
    )
      .map((m) => m.poolId)
      .sort();
    if (values.startAt !== undefined || values.killAt !== undefined) {
      await checkValidity(tx, ctx.scope, before.assetId, values);
      await updateAsset(tx, ctx, before.assetId, {
        ...(values.startAt !== undefined ? { startAt: values.startAt } : {}),
        ...(values.killAt !== undefined ? { killAt: values.killAt } : {}),
      });
    }
    const [after] = await tx
      .update(promo)
      .set({
        ...(values.showId !== undefined ? { showId: values.showId } : {}),
        ...(values.eventName !== undefined ? { eventName: values.eventName } : {}),
        ...(values.eventAt !== undefined ? { eventAt: values.eventAt } : {}),
        ...(values.weight !== undefined ? { weight: values.weight } : {}),
        ...(values.maxPlaysPerDay !== undefined ? { maxPlaysPerDay: values.maxPlaysPerDay } : {}),
        ...(values.dayparts !== undefined ? { dayparts: values.dayparts } : {}),
        ...(values.enabled !== undefined ? { enabled: values.enabled } : {}),
        version: before.version + 1,
      })
      .where(and(eq(promo.id, promoId), whereStation(promo, ctx.scope)))
      .returning();
    if (!after) throw new NotFoundError('promo', promoId);
    const afterPools = values.poolIds ? [...values.poolIds].sort() : beforePools;
    if (values.poolIds) await setPools(tx, ctx.scope, promoId, values.poolIds);
    await audit({
      action: 'promo.update',
      entity: { type: 'promo', id: promoId },
      diff: auditDiff(auditablePromo(before, beforePools), auditablePromo(after, afterPools)),
    });
  });
  return getPromo(db, ctx.scope, promoId);
}

/** Deletes a promo (the asset stays in the library). Its placements go with it. */
export async function deletePromo(db: Db, ctx: StationContext, promoId: string) {
  await withAudit(db, ctx, async (tx, audit) => {
    const [before] = await tx
      .select()
      .from(promo)
      .where(and(eq(promo.id, promoId), whereStation(promo, ctx.scope)))
      .for('update');
    if (!before) throw new NotFoundError('promo', promoId);
    await tx.delete(promo).where(and(eq(promo.id, promoId), whereStation(promo, ctx.scope)));
    await audit({
      action: 'promo.delete',
      entity: { type: 'promo', id: promoId },
      diff: auditDiff(auditablePromo(before, []), null),
    });
  });
}
