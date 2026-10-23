import {
  type Db,
  episode,
  liveSession,
  liveSlotCheck,
  logItem,
  logItemFallback,
  type StationScope,
  showSlot,
  station,
  streamerShow,
  whereStation,
  withAudit,
} from '@ondes/db';
import { type Actor, alertTypes, type LogItemInput } from '@ondes/shared';
import { and, asc, eq, gt, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { AlertService } from '../alerts/service.ts';
import * as log from '../log/repo.ts';
import { type LogEventSink, publishEdit } from '../log/routes.ts';
import { formatStationTime } from '../shows/episode-check/emails.ts';
import { type FallbackDeps, resolveFallback } from '../shows/episode-check/fallback.ts';
import { markLiveEpisodeMissing } from '../shows/live-slots.ts';
import { getOccurrences } from '../shows/repo.ts';

// Live slots nobody came on air for (#65, ADR 0033). Each api replica runs `sweep` with the
// live switcher's, per running station:
// - a live occurrence still running, past its start + grace, in which no DJ went on air yet is
//   **missed**: the `live.slot_missed` alert is raised and the show's fallback (ADR 0022's
//   `fallbackPolicy`, resolved now for the rest of the slot) goes into the log in place of
//   what's left of the slot's `live_slot` item. A DJ who connects later still takes the air:
//   live overrides the queue, and the feeder resumes the log at the current time afterwards;
// - an occurrence that ended (within the last `LOOKBACK_MS`, or any time for an occurrence
//   that has a check row, after an outage) with no DJ on air marks its planned episode
//   `missing`; the alert resolves (`occurrence_ended`).
// "A DJ on air" is a session bound to the occurrence, or any live session of one of the
// show's streamers overlapping it (a DJ on air before the slot whose session the switcher
// hadn't bound yet). It is checked again right before acting, so a takeover committing during
// the sweep doesn't get a fallback.
// Each step runs once across replicas: a `live_slot_check` row per occurrence, claimed with
// `update … where missed_at is null` / `closed_at is null`.

const ACTOR: Actor = { type: 'system', name: 'live-slot-check' };
/**
 * How far back ended occurrences with no check row are closed. Rows already there (a missed
 * slot) are closed whatever their age.
 */
const LOOKBACK_MS = 24 * 3600 * 1000;
/** A slot's `live_slot` log item starts within this much of the occurrence (retiming drift). */
const ITEM_MATCH_MS = 5 * 60 * 1000;

export type LiveSlotCheckOptions = {
  db: Db;
  alerts?: AlertService;
  fallback: FallbackDeps;
  logEvents?: LogEventSink;
  logger: FastifyBaseLogger;
  now?: () => Date;
};

export type LiveSlotCheck = ReturnType<typeof createLiveSlotCheck>;

export const liveSlotMissedKey = (slotId: string, date: string) =>
  `${alertTypes.liveSlotMissed}:${slotId}:${date}`;

type Occurrence = {
  slotId: string;
  date: string;
  showId: string;
  showName: string;
  startsAt: Date;
  endsAt: Date;
  graceMs: number;
};

export function createLiveSlotCheck(options: LiveSlotCheckOptions) {
  const { db, logger } = options;
  const now = options.now ?? (() => new Date());

  async function ensureRow(scope: StationScope, o: Omit<Occurrence, 'showName' | 'graceMs'>) {
    await db
      .insert(liveSlotCheck)
      .values({
        slotId: o.slotId,
        occurrenceDate: o.date,
        orgId: scope.orgId,
        stationId: scope.stationId,
        startsAt: o.startsAt,
        endsAt: o.endsAt,
      })
      .onConflictDoNothing();
  }

  const key = (scope: StationScope, o: { slotId: string; date: string }) =>
    and(
      whereStation(liveSlotCheck, scope),
      eq(liveSlotCheck.slotId, o.slotId),
      eq(liveSlotCheck.occurrenceDate, o.date),
    );

  /**
   * Whether a DJ went on air in the occurrence (up to `at`): a session bound to it, or a live
   * session of one of the show's streamers overlapping it.
   */
  async function hadDj(scope: StationScope, o: Omit<Occurrence, 'showName' | 'graceMs'>, at: Date) {
    const until = new Date(Math.min(at.getTime(), o.endsAt.getTime()));
    const [row] = await db
      .select({ id: liveSession.id })
      .from(liveSession)
      .where(
        and(
          eq(liveSession.stationId, scope.stationId),
          or(
            and(eq(liveSession.slotId, o.slotId), eq(liveSession.occurrenceDate, o.date)),
            and(
              sql`${liveSession.streamerId} in (select ${streamerShow.streamerId} from ${streamerShow} where ${streamerShow.showId} = ${o.showId})`,
              lt(liveSession.startedAt, until),
              or(isNull(liveSession.endedAt), gt(liveSession.endedAt, o.startsAt)),
            ),
          ),
        ),
      )
      .limit(1);
    return !!row;
  }

  /** The slot's `live_slot` item in the log, if it's still there and untouched. */
  async function liveItem(scope: StationScope, o: Occurrence) {
    const [item] = await db
      .select()
      .from(logItem)
      .where(
        and(
          whereStation(logItem, scope),
          isNull(logItem.segmentId),
          eq(logItem.kind, 'live_slot'),
          eq(logItem.originShowSlotId, o.slotId),
          gte(logItem.plannedStart, new Date(o.startsAt.getTime() - ITEM_MATCH_MS)),
          lt(logItem.plannedStart, o.endsAt),
        ),
      )
      .orderBy(asc(logItem.plannedStart))
      .limit(1);
    return item ?? null;
  }

  async function timezoneOf(scope: StationScope) {
    const [row] = await db
      .select({ timezone: station.timezone })
      .from(station)
      .where(eq(station.id, scope.stationId));
    return row?.timezone ?? 'UTC';
  }

  /**
   * Cuts the slot's `live_slot` item at `at` and puts the fallback after it, for the rest of
   * the slot, in one transaction; marks every fallback item like ADR 0022 does (the as-run
   * copies the mark). The kind it put in, or null when nothing could air.
   */
  async function applyFallback(scope: StationScope, o: Occurrence, at: Date) {
    const item = await liveItem(scope, o);
    const itemStart = item?.plannedStart;
    if (!item || !itemStart) return { kind: null, reason: 'no_log_item' as const };
    const remaining = o.endsAt.getTime() - at.getTime();
    const [planned] = await db
      .select({ id: episode.id })
      .from(episode)
      .where(
        and(
          whereStation(episode, scope),
          eq(episode.slotId, o.slotId),
          eq(episode.occurrenceDate, o.date),
        ),
      );
    const { policy, fallback } = await resolveFallback(
      db,
      scope,
      {
        showId: o.showId,
        missingEpisodeId: planned?.id ?? null,
        occurrenceDate: o.date,
        startsAt: at,
        durationMs: remaining,
      },
      options.fallback,
    );
    if (!fallback) return { kind: null, reason: 'no_fallback' as const, policy };
    const items: LogItemInput[] =
      fallback.kind === 'clock_music'
        ? fallback.items
        : [
            {
              kind: 'episode',
              assetId: fallback.assetId,
              episodeId: fallback.episodeId,
              plannedDurationMs: remaining,
              title: item.title,
            },
          ];
    const ctx = { actor: ACTOR, scope };
    const outcomes = await db.transaction(async (tx) => {
      // The log repository's edits take a `Db`; inside this transaction they run as savepoints.
      const inTx = tx as unknown as Db;
      const done: log.LogEditOutcome[] = [];
      // The live slot keeps its start and anchor and ends now: the feeder stops holding.
      let outcome = await log.replaceLogItem(inTx, ctx, item.id, {
        kind: 'live_slot',
        plannedDurationMs: Math.max(0, at.getTime() - itemStart.getTime()),
        liveSlotId: item.liveSlotId,
        title: item.title,
        timing: item.timing,
        anchorAt: item.anchorAt?.toISOString() ?? null,
        capMs: item.capMs,
        locked: item.locked,
      });
      done.push(outcome);
      for (const next of items) {
        outcome = await log.insertLogItem(inTx, ctx, { after: outcome.itemId }, next);
        done.push(outcome);
        const assetId = outcome.result.item?.assetId;
        if (assetId) {
          await tx.insert(logItemFallback).values({
            logItemId: outcome.itemId,
            orgId: scope.orgId,
            stationId: scope.stationId,
            slotId: o.slotId,
            occurrenceDate: o.date,
            kind: fallback.kind,
            assetId,
            episodeId: fallback.kind === 'clock_music' ? null : fallback.episodeId,
            missingEpisodeId: planned?.id ?? null,
          });
        }
      }
      return done;
    });
    for (const outcome of outcomes) {
      await publishEdit(options.logEvents, logger, scope.stationId, outcome);
    }
    return { kind: fallback.kind, reason: null, policy };
  }

  async function missed(scope: StationScope, o: Occurrence, at: Date) {
    await ensureRow(scope, o);
    const [claimed] = await db
      .update(liveSlotCheck)
      .set({ missedAt: at })
      .where(and(key(scope, o), isNull(liveSlotCheck.missedAt)))
      .returning();
    if (!claimed) return;
    // Checked again now the step is ours: a DJ who took the air during the sweep wins.
    if (await hadDj(scope, o, now())) {
      await db.update(liveSlotCheck).set({ missedAt: null }).where(key(scope, o));
      return;
    }
    let result: Awaited<ReturnType<typeof applyFallback>>;
    try {
      result = await applyFallback(scope, o, at);
    } catch (err) {
      // A locked or edited item, a log error: the alert still says the DJ isn't there.
      logger.error({ err, stationId: scope.stationId, slotId: o.slotId }, 'Live fallback failed');
      result = { kind: null, reason: 'no_log_item' };
    }
    await db.update(liveSlotCheck).set({ fallback: result.kind }).where(key(scope, o));
    const when = formatStationTime(o.startsAt, await timezoneOf(scope));
    await options.alerts?.raise(scope, {
      type: alertTypes.liveSlotMissed,
      severity: result.kind ? 'warning' : 'critical',
      dedupeKey: liveSlotMissedKey(o.slotId, o.date),
      title: `No DJ on air: ${o.showName}`,
      message: result.kind
        ? `Nobody went on air for ${o.showName} (${when}): its fallback (${result.kind}) airs for the rest of the slot.`
        : `Nobody went on air for ${o.showName} (${when}), and no fallback could be put in its place: the safety playlist plays.`,
      details: {
        showId: o.showId,
        slotId: o.slotId,
        occurrenceDate: o.date,
        startsAt: o.startsAt.toISOString(),
        endsAt: o.endsAt.toISOString(),
        fallback: result.kind,
        i18n: result.kind
          ? {
              key: 'liveSlotMissed.fallback',
              params: {
                show: o.showName,
                startsAt: o.startsAt.toISOString(),
                fallback: result.kind,
              },
            }
          : {
              key: 'liveSlotMissed.noFallback',
              params: {
                show: o.showName,
                startsAt: o.startsAt.toISOString(),
                reason: result.reason,
              },
            },
      },
    });
    logger.info(
      { stationId: scope.stationId, slotId: o.slotId, fallback: result.kind },
      'Live slot missed',
    );
    // A DJ who came while the fallback went in: their session's resolve may have run before
    // this raise, so resolve here too.
    if (await hadDj(scope, o, now())) {
      await options.alerts?.resolve(scope, liveSlotMissedKey(o.slotId, o.date), {
        reason: 'dj_on_air',
      });
    }
  }

  async function close(scope: StationScope, o: Omit<Occurrence, 'showName' | 'graceMs'>, at: Date) {
    await ensureRow(scope, o);
    const [claimed] = await db
      .update(liveSlotCheck)
      .set({ closedAt: at })
      .where(and(key(scope, o), isNull(liveSlotCheck.closedAt)))
      .returning();
    if (!claimed) return;
    if (!(await hadDj(scope, o, at))) {
      await withAudit(db, { actor: ACTOR, scope }, async (tx, audit) => {
        const marked = await markLiveEpisodeMissing(tx, scope, audit, o);
        // Nothing planned to mark: the audit row still records the empty occurrence.
        if (!marked) {
          await audit({
            action: 'show_slot.live_missed',
            entity: { type: 'show_slot', id: o.slotId },
            diff: { occurrenceDate: { from: null, to: o.date } },
          });
        }
      });
    }
    await options.alerts?.resolve(scope, liveSlotMissedKey(o.slotId, o.date), {
      reason: 'occurrence_ended',
    });
  }

  return {
    /** Live occurrences of the station past their grace or ended. Idempotent. */
    async sweep(scope: StationScope) {
      const at = now();
      const t = at.getTime();
      const { occurrences } = await getOccurrences(db, scope, {
        from: new Date(t - LOOKBACK_MS),
        to: new Date(t + 1000),
      });
      const live: Occurrence[] = occurrences
        .filter((o) => o.type === 'live' && o.startsAt.getTime() <= t)
        .map((o) => ({
          slotId: o.slotId,
          date: o.date,
          showId: o.show.id,
          showName: o.show.name,
          startsAt: o.startsAt,
          endsAt: o.endsAt,
          graceMs: o.live?.graceMs ?? 0,
        }));
      const rows = await db
        .select({
          slotId: liveSlotCheck.slotId,
          date: liveSlotCheck.occurrenceDate,
          startsAt: liveSlotCheck.startsAt,
          endsAt: liveSlotCheck.endsAt,
          missedAt: liveSlotCheck.missedAt,
          closedAt: liveSlotCheck.closedAt,
          showId: showSlot.showId,
        })
        .from(liveSlotCheck)
        .innerJoin(showSlot, eq(showSlot.id, liveSlotCheck.slotId))
        .where(
          and(
            whereStation(liveSlotCheck, scope),
            or(
              // Open rows of any age (an outage longer than the lookback), and the rows of
              // the occurrences in view.
              isNull(liveSlotCheck.closedAt),
              live.length
                ? inArray(
                    liveSlotCheck.slotId,
                    live.map((o) => o.slotId),
                  )
                : undefined,
            ),
          ),
        );
      const byKey = new Map(rows.map((r) => [`${r.slotId}/${r.date}`, r]));
      for (const o of live) {
        const row = byKey.get(`${o.slotId}/${o.date}`);
        if (row?.closedAt) continue;
        if (o.endsAt.getTime() <= t) {
          await close(scope, o, at);
        } else if (!row?.missedAt && t >= o.startsAt.getTime() + o.graceMs) {
          if (!(await hadDj(scope, o, at))) await missed(scope, o, at);
        }
      }
      // Open rows whose occurrence is out of view (older than the lookback, or its slot
      // changed since): closed from what the row says.
      const inView = new Set(live.map((o) => `${o.slotId}/${o.date}`));
      for (const r of rows) {
        if (r.closedAt || r.endsAt.getTime() > t || inView.has(`${r.slotId}/${r.date}`)) continue;
        await close(scope, { ...r, date: r.date }, at);
      }
    },

    /** A DJ went on air in the occurrence: the missed alert resolves. */
    async onSlotLive(scope: StationScope, occurrence: { slotId: string; date: string }) {
      await options.alerts?.resolve(scope, liveSlotMissedKey(occurrence.slotId, occurrence.date), {
        reason: 'dj_on_air',
      });
    },
  };
}
