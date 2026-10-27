import {
  asset,
  assetCues,
  auditDiff,
  type Db,
  logItem,
  type MutationContext,
  promo,
  promoPlacement,
  type StationScope,
  segue,
  vtPoolMember,
  whereStation,
  withAudit,
} from '@ondes/db';
import type { JobPublisher } from '@ondes/queue';
import {
  type Actor,
  defaultPromoLanes,
  PLAYOUT_SAMPLE_RATE,
  type PlacementMedia,
  type PromoPlacementStatus,
  promoValidOnAir,
  promoVoiceMs,
  type SegueMedia,
} from '@ondes/shared';
import { and, eq, gte, inArray, isNotNull, or } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { type EventSink, eventsOf, publishAll } from '../segues/events.ts';
import { segueMedia } from '../segues/media.ts';
import { requestRenders } from '../segues/render.ts';
import { createSegue, deleteSegue } from '../segues/repo.ts';

// Promo placements → default segues (#60, ADR 0032). The worker's generator writes each
// placement `pending` with its day; this makes its segue with the segues module's own
// `createSegue` (checks, audit, island sync, renders), voiced and ducked by
// `defaultPromoLanes` from A's and B's cue markers. Runs on every `log.updated` (the promos
// plugin's durable queue) for the days it names, and after a promo edit for that promo.
//
// It also keeps placements honest:
// - a `pending` one that can't air any more (its promo expired, was disabled or left the pool;
//   its songs are gone or no longer consecutive; the transition already has a segue) is
//   `dropped`, with why;
// - a `placed` one whose segue was deleted is `dropped`;
// - a `dropped` one that still has its generated (`auto`) segue gets it deleted, so a promo
//   that may not air leaves nothing on air. A segue a person saved (`manual`) is theirs: kept.

export const PROMOS_ACTOR: Actor = { type: 'system', name: 'promos' };

export type PlacementDeps = {
  db: Db;
  events?: EventSink | undefined;
  jobs?: JobPublisher | undefined;
  logger: FastifyBaseLogger;
};

export type PlacementSyncResult = { placed: number; dropped: number; seguesDeleted: number };

type PlacementRow = typeof promoPlacement.$inferSelect;

/**
 * Re-checks the coming placements of these log days, or of one promo. Only transitions still
 * ahead (`plannedAt >= now`): what aired, or should have, is history, and a past day edited or
 * regenerated after a promo's kill date keeps its record.
 */
export async function syncPromoPlacements(
  deps: PlacementDeps,
  scope: StationScope,
  filter: { logDayIds: string[] } | { promoId: string },
  now = new Date(),
): Promise<PlacementSyncResult> {
  const where =
    'logDayIds' in filter
      ? filter.logDayIds.length
        ? inArray(promoPlacement.logDayId, filter.logDayIds)
        : undefined
      : eq(promoPlacement.promoId, filter.promoId);
  const result: PlacementSyncResult = { placed: 0, dropped: 0, seguesDeleted: 0 };
  if (!where) return result;
  const rows = await deps.db
    .select()
    .from(promoPlacement)
    .where(
      and(
        whereStation(promoPlacement, scope),
        where,
        gte(promoPlacement.plannedAt, now),
        or(
          inArray(promoPlacement.status, ['pending', 'placed']),
          isNotNull(promoPlacement.segueId),
        ),
      ),
    );
  if (rows.length === 0) return result;
  const ctx = { actor: PROMOS_ACTOR, scope };

  // A placed one whose segue is gone. A placed one whose promo can't air there any more is
  // dropped too (then its segue deleted below).
  const eligibility = await eligibilityOf(deps.db, scope, rows);
  for (const row of rows) {
    if (row.status === 'placed' && row.segueId === null) {
      await setStatus(deps.db, ctx, row, 'dropped', 'its segue was deleted');
      row.status = 'dropped';
      result.dropped++;
    } else if (row.status !== 'dropped') {
      const why = eligibility(row);
      if (why) {
        await setStatus(deps.db, ctx, row, 'dropped', why);
        row.status = 'dropped';
        row.detail = why;
        result.dropped++;
      }
    }
  }

  for (const row of rows.filter((r) => r.status === 'dropped' && r.segueId !== null)) {
    if (await deleteGeneratedSegue(deps, ctx, row)) result.seguesDeleted++;
  }

  for (const row of rows.filter((r) => r.status === 'pending')) {
    const outcome = await place(deps, ctx, row);
    if (outcome === 'placed') result.placed++;
    else if (outcome === 'dropped') result.dropped++;
  }
  return result;
}

/**
 * Why each placement's promo can't air there any more, or null. Validity is checked over the
 * voice's air window (`promoValidOnAir`, the generator's own check): exactly, from its segue's
 * voice lane, once it has one; else wherever the default segue may put it.
 */
async function eligibilityOf(db: Db, scope: StationScope, rows: PlacementRow[]) {
  const promoIds = [...new Set(rows.map((r) => r.promoId))];
  const segueIds = rows.flatMap((r) => (r.segueId ? [r.segueId] : []));
  const [promos, members, segues] = await Promise.all([
    db
      .select({
        id: promo.id,
        enabled: promo.enabled,
        startAt: asset.startAt,
        killAt: asset.killAt,
        durationMs: asset.durationMs,
        sampleRate: assetCues.sampleRate,
        cueIn: assetCues.cueIn,
        cueOut: assetCues.cueOut,
      })
      .from(promo)
      .innerJoin(asset, eq(asset.id, promo.assetId))
      .leftJoin(assetCues, eq(assetCues.assetId, promo.assetId))
      .where(and(whereStation(promo, scope), inArray(promo.id, promoIds))),
    db
      .select({ poolId: vtPoolMember.poolId, promoId: vtPoolMember.promoId })
      .from(vtPoolMember)
      .where(and(whereStation(vtPoolMember, scope), inArray(vtPoolMember.promoId, promoIds))),
    segueIds.length
      ? db
          .select({ id: segue.id, voices: segue.voices })
          .from(segue)
          .where(and(whereStation(segue, scope), inArray(segue.id, segueIds)))
      : [],
  ]);
  const byId = new Map(promos.map((p) => [p.id, p]));
  const voicesBySegue = new Map(segues.map((s) => [s.id, s.voices]));
  const inPool = new Set(members.map((m) => `${m.poolId}:${m.promoId}`));
  return (row: PlacementRow): string | null => {
    const p = byId.get(row.promoId);
    if (!p) return 'the promo was deleted';
    if (!p.enabled) return 'the promo was disabled';
    if (row.poolId && !inPool.has(`${row.poolId}:${row.promoId}`)) return 'the promo left the pool';
    const voice = row.segueId
      ? voicesBySegue.get(row.segueId)?.find((v) => v.assetId === row.assetId)
      : undefined;
    const startMs = voice ? (voice.start * 1000) / PLAYOUT_SAMPLE_RATE : undefined;
    if (!promoValidOnAir(p, row.plannedAt, promoVoiceMs(p), startMs)) {
      return 'outside the promo’s start and kill dates';
    }
    if (row.fromItemId === null || row.toItemId === null) return 'its songs were replaced';
    return null;
  };
}

async function setStatus(
  db: Db,
  ctx: MutationContext & { scope: StationScope },
  row: PlacementRow,
  status: PromoPlacementStatus,
  detail: string | null,
  segueId: string | null = row.segueId,
) {
  await withAudit(db, ctx, async (tx, audit) => {
    await tx
      .update(promoPlacement)
      .set({ status, detail, segueId })
      .where(and(eq(promoPlacement.id, row.id), whereStation(promoPlacement, ctx.scope)));
    await audit({
      action: 'promo_placement.update',
      entity: { type: 'promo_placement', id: row.id },
      diff: auditDiff(
        { status: row.status, detail: row.detail, segueId: row.segueId },
        { status, detail, segueId },
      ),
    });
  });
}

/** Deletes a dropped placement's segue if the generator made it and nobody saved it since. */
async function deleteGeneratedSegue(
  deps: PlacementDeps,
  ctx: MutationContext & { scope: StationScope },
  row: PlacementRow,
): Promise<boolean> {
  if (!row.segueId) return false;
  const [s] = await deps.db
    .select({ origin: segue.origin, voices: segue.voices })
    .from(segue)
    .where(and(eq(segue.id, row.segueId), whereStation(segue, ctx.scope)));
  if (s?.origin !== 'auto' || !s.voices.some((v) => v.assetId === row.assetId)) return false;
  const { sync, deleted } = await deleteSegue(deps.db, ctx, row.segueId);
  await publishAll(
    deps.events,
    eventsOf(ctx.scope, sync, {
      change: 'deleted',
      segue: {
        segueId: deleted.id,
        status: null,
        problem: null,
        islandId: null,
        fromItemId: deleted.fromItemId,
        toItemId: deleted.toItemId,
      },
    }),
    deps.logger,
  );
  await requestRenders(deps.jobs, ctx.scope, sync, deps.logger);
  return true;
}

/** Makes a pending placement's default segue. */
async function place(
  deps: PlacementDeps,
  ctx: MutationContext & { scope: StationScope },
  row: PlacementRow,
): Promise<'placed' | 'dropped' | 'waiting'> {
  const { db } = deps;
  const { scope } = ctx;
  if (!row.fromItemId || !row.toItemId) return 'waiting';
  const items = await db
    .select({
      id: logItem.id,
      logDayId: logItem.logDayId,
      position: logItem.position,
      segmentId: logItem.segmentId,
      assetId: logItem.assetId,
    })
    .from(logItem)
    .where(and(whereStation(logItem, scope), inArray(logItem.id, [row.fromItemId, row.toItemId])));
  const a = items.find((i) => i.id === row.fromItemId);
  const b = items.find((i) => i.id === row.toItemId);
  if (!a?.assetId || !b?.assetId || a.logDayId !== b.logDayId || b.position !== a.position + 1) {
    await setStatus(db, ctx, row, 'dropped', 'its songs are no longer consecutive');
    return 'dropped';
  }

  // One segue per transition. One that is already ours (an earlier attempt) is adopted.
  const existing = await db
    .select({ id: segue.id, from: segue.fromItemId, to: segue.toItemId, voices: segue.voices })
    .from(segue)
    .where(
      and(whereStation(segue, scope), or(eq(segue.fromItemId, a.id), eq(segue.toItemId, b.id))),
    );
  const ours = existing.find(
    (s) => s.from === a.id && s.to === b.id && s.voices.some((v) => v.assetId === row.assetId),
  );
  if (ours) {
    await setStatus(db, ctx, row, 'placed', null, ours.id);
    return 'placed';
  }
  if (existing.length) {
    await setStatus(db, ctx, row, 'dropped', 'the transition already has a segue');
    return 'dropped';
  }

  const media = await segueMedia(db, scope, { itemIds: [a.id, b.id], assetIds: [row.assetId] });
  const aMedia = media.items[a.id];
  const bMedia = media.items[b.id];
  const voice = media.assets[row.assetId];
  // No playout copy yet: try again on the next log or library change.
  if (!aMedia || !bMedia || !voice) {
    deps.logger.debug({ placementId: row.id }, 'promo placement waits for media');
    return 'waiting';
  }
  const markers = await markersOf(db, scope, [a.assetId, b.assetId]);
  const lanes = defaultPromoLanes(
    placementMedia(aMedia, markers.get(a.assetId)),
    placementMedia(bMedia, markers.get(b.assetId)),
    { assetId: row.assetId, cueIn: voice.cueIn, cueOut: voice.cueOut },
  );
  const { segue: created, sync } = await createSegue(db, ctx, {
    fromItemId: a.id,
    toItemId: b.id,
    ...lanes,
    origin: 'auto',
  });
  if (!created) throw new Error('created segue missing');
  await setStatus(db, ctx, row, 'placed', null, created.id);
  await publishAll(
    deps.events,
    eventsOf(scope, sync, {
      change: 'created',
      segue: {
        segueId: created.id,
        status: created.status,
        problem: created.problem,
        islandId: created.island?.id ?? null,
        fromItemId: created.fromItemId,
        toItemId: created.toItemId,
      },
    }),
    deps.logger,
  );
  await requestRenders(deps.jobs, scope, sync, deps.logger);
  return 'placed';
}

type Markers = {
  sampleRate: number;
  outroStart: number | null;
  introEnd: number | null;
  crossStartNext: number | null;
};

async function markersOf(db: Db, scope: StationScope, assetIds: string[]) {
  const rows = await db
    .select({
      assetId: assetCues.assetId,
      sampleRate: assetCues.sampleRate,
      outroStart: assetCues.outroStart,
      introEnd: assetCues.introEnd,
      crossStartNext: assetCues.crossStartNext,
    })
    .from(assetCues)
    .where(and(whereStation(assetCues, scope), inArray(assetCues.assetId, assetIds)));
  return new Map<string, Markers>(rows.map((r) => [r.assetId, r]));
}

/** The lane's effective cues with its markers, rescaled to the playout copy's rate. */
function placementMedia(media: SegueMedia, markers: Markers | undefined): PlacementMedia {
  const scale = markers ? media.sampleRate / markers.sampleRate : 1;
  const at = (samples: number | null | undefined) =>
    samples === null || samples === undefined ? null : Math.round(samples * scale);
  return {
    cueIn: media.cueIn,
    cueOut: media.cueOut,
    outroStart: at(markers?.outroStart),
    introEnd: at(markers?.introEnd),
    crossStartNext: at(markers?.crossStartNext),
  };
}

/**
 * Before a promo or a pool is deleted: their coming placements are dropped and their generated
 * segues deleted, so nothing of them is left to air (a deleted pool sets its placements' pool to
 * null, and the re-check could no longer tell they came from it).
 */
export async function retirePlacements(
  deps: PlacementDeps,
  scope: StationScope,
  of: { promoId: string } | { poolId: string },
  now = new Date(),
): Promise<PlacementSyncResult> {
  const ctx = { actor: PROMOS_ACTOR, scope };
  const [match, reason] =
    'promoId' in of
      ? [eq(promoPlacement.promoId, of.promoId), 'the promo was deleted']
      : [eq(promoPlacement.poolId, of.poolId), 'the pool was deleted'];
  const rows = await deps.db
    .select()
    .from(promoPlacement)
    .where(
      and(
        whereStation(promoPlacement, scope),
        match,
        gte(promoPlacement.plannedAt, now),
        or(
          inArray(promoPlacement.status, ['pending', 'placed']),
          isNotNull(promoPlacement.segueId),
        ),
      ),
    );
  const result: PlacementSyncResult = { placed: 0, dropped: 0, seguesDeleted: 0 };
  for (const row of rows) {
    if (row.status !== 'dropped') {
      await setStatus(deps.db, ctx, row, 'dropped', reason);
      result.dropped++;
    }
    if (await deleteGeneratedSegue(deps, ctx, row)) result.seguesDeleted++;
  }
  return result;
}
