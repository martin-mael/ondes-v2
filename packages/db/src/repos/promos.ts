import type { PromoCandidate, PromoPlay, PromoSnapshot } from '@ondes/scheduling';
import { addDays, type LocalDate, localDayBounds } from '@ondes/shared';
import { and, asc, eq, gte, inArray, isNull, lt, notInArray, or } from 'drizzle-orm';
import { type MutationContext, withAudit } from '../audit.ts';
import type { Db, Executor } from '../client.ts';
import { asset, assetCues } from '../schema/library.ts';
import { logItem } from '../schema/log.ts';
import { promo, promoPlacement, vtPoolMember } from '../schema/promos.ts';
import { segue } from '../schema/segues.ts';
import { type StationScope, whereStation } from '../tenant.ts';

// Promo VTs (#60, ADR 0032) for the worker's log generator: the promos and their recent plays
// (`loadPromoSnapshot`, the input of `@ondes/scheduling` `createPromoPlacer`), and the day's
// placements once the day is written (`writePromoPlacements`). The api makes each placement's
// default segue when it hears `log.updated` (apps/api/src/modules/promos/placements.ts).

/** Plays this far back count for rotation (who aired least recently). */
const HISTORY_DAYS = 7;

/**
 * The station's promos with their pools and voice length, and the plays that count against
 * their caps: placements outside `dates`, and those inside that a regeneration keeps (their
 * segue was edited by a person, so their songs survive).
 */
export async function loadPromoSnapshot(
  db: Executor,
  scope: StationScope,
  options: { timeZone: string; dates: readonly LocalDate[] },
): Promise<PromoSnapshot> {
  const rows = await db
    .select({
      id: promo.id,
      assetId: promo.assetId,
      weight: promo.weight,
      maxPlaysPerDay: promo.maxPlaysPerDay,
      dayparts: promo.dayparts,
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
    .where(whereStation(promo, scope))
    .orderBy(asc(promo.id));
  const members = rows.length
    ? await db
        .select({ poolId: vtPoolMember.poolId, promoId: vtPoolMember.promoId })
        .from(vtPoolMember)
        .where(whereStation(vtPoolMember, scope))
    : [];
  const pools = new Map<string, string[]>();
  for (const m of members) pools.set(m.promoId, [...(pools.get(m.promoId) ?? []), m.poolId]);
  const promos: PromoCandidate[] = rows.map((r) => ({
    id: r.id,
    assetId: r.assetId,
    poolIds: pools.get(r.id) ?? [],
    weight: r.weight,
    maxPlaysPerDay: r.maxPlaysPerDay,
    dayparts: r.dayparts,
    startAt: r.startAt,
    killAt: r.killAt,
    enabled: r.enabled,
    playMs: voiceMs(r),
  }));

  const sorted = [...options.dates].sort();
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last || promos.length === 0)
    return { timeZone: options.timeZone, promos, plays: [] };
  const from = localDayBounds(addDays(first, -HISTORY_DAYS), options.timeZone).startsAt;
  const to = localDayBounds(addDays(last, 1), options.timeZone).endsAt;
  const played = await db
    .select({ promoId: promoPlacement.promoId, at: promoPlacement.plannedAt })
    .from(promoPlacement)
    .leftJoin(segue, eq(segue.id, promoPlacement.segueId))
    .where(
      and(
        whereStation(promoPlacement, scope),
        inArray(promoPlacement.status, ['pending', 'placed']),
        gte(promoPlacement.plannedAt, from),
        lt(promoPlacement.plannedAt, to),
        or(notInArray(promoPlacement.localDate, sorted), eq(segue.origin, 'manual')),
      ),
    );
  const plays: PromoPlay[] = played.map((p) => ({ promoId: p.promoId, at: p.at }));
  return { timeZone: options.timeZone, promos, plays };
}

/** The voice's play length: its cues, else the asset's length, else 30 s. */
function voiceMs(r: {
  durationMs: number | null;
  sampleRate: number | null;
  cueIn: number | null;
  cueOut: number | null;
}): number {
  if (r.sampleRate && r.cueOut !== null) {
    const length = r.cueOut - (r.cueIn ?? 0);
    if (length > 0) return Math.round((length * 1000) / r.sampleRate);
  }
  return r.durationMs ?? 30_000;
}

/** A placement of a written day: A and B by position in the day. */
export interface PromoPlacementInput {
  promoId: string;
  assetId: string;
  poolId: string;
  clockId: string;
  slotIndex: number;
  plannedAt: Date;
  fromPosition: number;
  toPosition: number;
}

export interface WrittenPromoPlacements {
  /** New `pending` placements. */
  placed: number;
  /** Earlier placements of the day dropped because the regeneration replaced their songs. */
  dropped: number;
}

/**
 * Records a written day's promo placements, `pending` until the api makes their segues. The
 * day's earlier placements whose songs the regeneration deleted are dropped (their segue, now
 * detached, is the api's to delete). A and B are read back by position, so this runs right
 * after `writeGeneratedDay`; a placement whose positions don't hold two consecutive songs any
 * more (the day was edited in between) is skipped. Audited `log_day.promos`.
 */
export async function writePromoPlacements(
  db: Db,
  ctx: MutationContext & { scope: StationScope },
  day: { logDayId: string; localDate: LocalDate },
  placements: readonly PromoPlacementInput[],
): Promise<WrittenPromoPlacements> {
  const { scope } = ctx;
  const staleWhere = and(
    whereStation(promoPlacement, scope),
    eq(promoPlacement.logDayId, day.logDayId),
    inArray(promoPlacement.status, ['pending', 'placed']),
    or(isNull(promoPlacement.fromItemId), isNull(promoPlacement.toItemId)),
  );
  if (placements.length === 0) {
    // Nothing to write: skip the transaction (and its audit row) unless something is stale.
    const [any] = await db
      .select({ id: promoPlacement.id })
      .from(promoPlacement)
      .where(staleWhere)
      .limit(1);
    if (!any) return { placed: 0, dropped: 0 };
  }
  return withAudit(db, ctx, async (tx, audit) => {
    const stale = await tx
      .update(promoPlacement)
      .set({ status: 'dropped', detail: 'regenerated: its songs were replaced' })
      .where(staleWhere)
      .returning({ id: promoPlacement.id });
    const positions = [...new Set(placements.flatMap((p) => [p.fromPosition, p.toPosition]))];
    const items = positions.length
      ? await tx
          .select({ id: logItem.id, position: logItem.position, kind: logItem.kind })
          .from(logItem)
          .where(
            and(
              whereStation(logItem, scope),
              eq(logItem.logDayId, day.logDayId),
              isNull(logItem.segmentId),
              inArray(logItem.position, positions),
            ),
          )
      : [];
    const at = new Map(items.map((i) => [i.position, i]));
    const rows = placements.flatMap((p) => {
      const a = at.get(p.fromPosition);
      const b = at.get(p.toPosition);
      if (!a || !b || a.kind !== 'song' || b.kind !== 'song') return [];
      return [
        {
          orgId: scope.orgId,
          stationId: scope.stationId,
          promoId: p.promoId,
          assetId: p.assetId,
          poolId: p.poolId,
          logDayId: day.logDayId,
          localDate: day.localDate,
          fromItemId: a.id,
          toItemId: b.id,
          clockId: p.clockId,
          slotIndex: p.slotIndex,
          plannedAt: p.plannedAt,
        },
      ];
    });
    if (rows.length) await tx.insert(promoPlacement).values(rows);
    await audit({
      action: 'log_day.promos',
      entity: { type: 'log_day', id: day.logDayId },
      diff: {
        placed: { from: null, to: rows.length },
        dropped: { from: null, to: stale.length },
      },
    });
    return { placed: rows.length, dropped: stale.length };
  });
}
