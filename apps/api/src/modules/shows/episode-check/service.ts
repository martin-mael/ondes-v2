import {
  alert,
  type Db,
  episode,
  episodeCheck,
  logItem,
  logItemFallback,
  membership,
  type StationScope,
  show,
  showHost,
  station,
  unsafeScope,
  user,
  userAuth,
  whereStation,
} from '@ondes/db';
import {
  type Actor,
  type AlertSeverity,
  alertTypes,
  EPISODE_RESTORE_MIN_LEAD_MS,
  type EpisodeCheckStep,
  type EpisodeFallbackPolicy,
  type LogItemInput,
} from '@ondes/shared';
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { type Mailer, sendTemplate } from '../../../plugins/mail.ts';
import type { AlertService } from '../../alerts/service.ts';
import * as log from '../../log/repo.ts';
import { type LogEventSink, publishEdit } from '../../log/routes.ts';
import { updateEpisode } from '../repo.ts';
import { formatStationTime, missingEpisodeTemplate } from './emails.ts';
import { type FallbackDeps, type ResolvedFallback, resolveFallback } from './fallback.ts';

// Missing-episode alerts and fallbacks, api side (#47, ADR 0022). The worker's `episode-check`
// job records due steps in `episode_check`; this works them off, like an outbox:
// - `t48h` / `t6h`: raise `show.episode_missing` (info, then warning) for the dashboard and
//   email the show's hosts and the station's programmers, once each (`notified`);
// - `fallback`: put the show's fallback in the occurrence's empty log item, marked in
//   `log_item_fallback` (the as-run copies the mark), or raise the alert as critical when
//   nothing can air.
// `reconcile` resolves alerts whose audio arrived or whose slot is over, puts an episode whose
// audio arrived in time back in place of its fallback, and marks premieres that never got
// audio `missing`.
//
// Replicas claim rows with `FOR UPDATE SKIP LOCKED`; a claim older than 2 min is taken over.
// Every log and episode change goes through the log and shows repositories, audited as the
// system actor `episode-check`.

const ACTOR: Actor = { type: 'system', name: 'episode-check' };
const CLAIM_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 10;
/** An occurrence's log item starts within this much of the occurrence (retiming drift). */
const ITEM_MATCH_MS = 5 * 60 * 1000;

const SEVERITY: Record<Exclude<EpisodeCheckStep, 'fallback'>, AlertSeverity> = {
  t48h: 'info',
  t6h: 'warning',
};
const LEAD_TEXT: Record<Exclude<EpisodeCheckStep, 'fallback'>, string> = {
  t48h: 'in 48 hours',
  t6h: 'in 6 hours',
};
const POLICY_TEXT: Record<EpisodeFallbackPolicy, string> = {
  latest_episode: 'the latest episode airs again',
  episode: 'the episode chosen in the show settings airs again',
  clock_music: 'music from the clock airs',
  none: 'nothing is planned: the safety playlist plays',
};

type CheckRow = typeof episodeCheck.$inferSelect;

export type EpisodeCheckServiceOptions = {
  db: Db;
  alerts: AlertService;
  mailer: Mailer;
  /** Web app base URL, for links in emails. */
  appUrl: string;
  logger: FastifyBaseLogger;
  /** Where log edits are published (`app.rabbit.events`); omitted: not published. */
  logEvents?: LogEventSink;
  fallback: FallbackDeps;
  now?: () => Date;
};

export type EpisodeCheckService = ReturnType<typeof createEpisodeCheckService>;

export function createEpisodeCheckService(options: EpisodeCheckServiceOptions) {
  const { db, alerts, logger } = options;
  const now = options.now ?? (() => new Date());

  /** Claims up to `limit` pending steps, oldest first. */
  async function claim(limit: number): Promise<CheckRow[]> {
    const at = now();
    const stale = new Date(at.getTime() - CLAIM_TIMEOUT_MS);
    return db.transaction(async (tx) => {
      const ids = await tx
        .select({ id: episodeCheck.id })
        .from(episodeCheck)
        .where(
          and(
            isNull(episodeCheck.processedAt),
            or(isNull(episodeCheck.claimedAt), lt(episodeCheck.claimedAt, stale)),
          ),
        )
        .orderBy(asc(episodeCheck.createdAt))
        .limit(limit)
        .for('update', { skipLocked: true });
      if (!ids.length) return [];
      return tx
        .update(episodeCheck)
        .set({ claimedAt: at, attempts: sql`${episodeCheck.attempts} + 1` })
        .where(
          inArray(
            episodeCheck.id,
            ids.map((r) => r.id),
          ),
        )
        .returning();
    });
  }

  async function finish(id: string, result: string) {
    await db
      .update(episodeCheck)
      .set({ processedAt: now(), result, error: null })
      .where(eq(episodeCheck.id, id));
  }

  async function context(row: CheckRow) {
    const scope = unsafeScope(row.orgId, row.stationId);
    const [info] = await db
      .select({
        showName: show.name,
        stationName: station.name,
        timezone: station.timezone,
        policy: show.fallbackPolicy,
      })
      .from(show)
      .innerJoin(station, eq(station.id, show.stationId))
      .where(and(whereStation(show, scope), eq(show.id, row.showId)));
    const [premiere] = await db
      .select({ id: episode.id, assetId: episode.assetId })
      .from(episode)
      .where(
        and(
          whereStation(episode, scope),
          eq(episode.slotId, row.slotId),
          eq(episode.occurrenceDate, row.occurrenceDate),
        ),
      );
    return { scope, info, premiere: premiere ?? null };
  }

  const dedupeKey = (slotId: string, date: string) =>
    `${alertTypes.episodeMissing}:${slotId}:${date}`;

  const details = (row: CheckRow, extra: Record<string, unknown> = {}) => ({
    showId: row.showId,
    slotId: row.slotId,
    occurrenceDate: row.occurrenceDate,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    episodeId: row.episodeId,
    ...extra,
  });

  /** Hosts of the show and programmers of the station, with a verified address. */
  async function recipients(scope: StationScope, showId: string) {
    const verified = (q: ReturnType<typeof base>) =>
      q.innerJoin(userAuth, eq(userAuth.userId, user.id));
    const base = () => db.selectDistinct({ email: user.email, name: user.name }).from(user);
    const [hosts, programmers] = await Promise.all([
      verified(base())
        .innerJoin(showHost, eq(showHost.userId, user.id))
        .where(
          and(
            eq(showHost.showId, showId),
            whereStation(showHost, scope),
            isNotNull(userAuth.emailVerifiedAt),
          ),
        ),
      verified(base())
        .innerJoin(membership, eq(membership.userId, user.id))
        .where(
          and(
            eq(membership.orgId, scope.orgId),
            eq(membership.stationId, scope.stationId),
            eq(membership.role, 'programmer'),
            isNotNull(userAuth.emailVerifiedAt),
          ),
        ),
    ]);
    const byEmail = new Map([...hosts, ...programmers].map((r) => [r.email, r]));
    return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
  }

  async function alertStep(row: CheckRow & { step: 't48h' | 't6h' }) {
    const { scope, info, premiere } = await context(row);
    if (!info) return finish(row.id, 'show_gone');
    if (premiere?.assetId) return finish(row.id, 'episode_ready');
    const airsAt = formatStationTime(row.startsAt, info.timezone);
    const fallback = POLICY_TEXT[info.policy];
    await alerts.raise(scope, {
      type: alertTypes.episodeMissing,
      severity: SEVERITY[row.step],
      dedupeKey: dedupeKey(row.slotId, row.occurrenceDate),
      title: `Episode missing: ${info.showName}`,
      message: `${info.showName} airs ${LEAD_TEXT[row.step]}, ${airsAt}, and its episode has no audio yet. If it's still missing an hour before, ${fallback}.`,
      details: details(row, { step: row.step, fallbackPolicy: info.policy }),
    });
    const link = `${options.appUrl}/stations/${scope.stationId}/shows/${row.showId}`;
    const sent = new Set(row.notified);
    for (const r of await recipients(scope, row.showId)) {
      if (sent.has(r.email)) continue;
      await sendTemplate(options.mailer, r.email, missingEpisodeTemplate, {
        name: r.name,
        stationName: info.stationName,
        showName: info.showName,
        airsAt,
        lead: LEAD_TEXT[row.step],
        fallback,
        link,
      });
      // Recorded one by one: a retry after a failed send skips who already got it.
      await db
        .update(episodeCheck)
        .set({ notified: sql`array_append(${episodeCheck.notified}, ${r.email})` })
        .where(eq(episodeCheck.id, row.id));
    }
    return finish(row.id, 'alerted');
  }

  /** The occurrence's empty item: a top-level item of the slot, around its start, with no audio. */
  async function emptyItem(scope: StationScope, row: CheckRow, premiereId: string | null) {
    const [item] = await db
      .select()
      .from(logItem)
      .where(
        and(
          whereStation(logItem, scope),
          isNull(logItem.segmentId),
          gte(logItem.plannedStart, new Date(row.startsAt.getTime() - ITEM_MATCH_MS)),
          lt(logItem.plannedStart, row.endsAt),
          or(
            eq(logItem.originShowSlotId, row.slotId),
            premiereId ? eq(logItem.episodeId, premiereId) : undefined,
          ),
          isNull(logItem.assetId),
        ),
      )
      .orderBy(asc(logItem.plannedStart))
      .limit(1);
    return item ?? null;
  }

  /** The item's content with `fallback` in it; its place and timing stay. */
  function replacement(
    item: typeof logItem.$inferSelect,
    content: Pick<LogItemInput, 'kind' | 'assetId' | 'episodeId' | 'title'>,
  ): LogItemInput {
    return {
      ...content,
      plannedDurationMs: item.plannedDurationMs,
      timing: item.timing,
      anchorAt: item.anchorAt?.toISOString() ?? null,
      capMs: item.capMs,
      locked: item.locked,
    } as LogItemInput;
  }

  async function applyFallback(
    scope: StationScope,
    row: CheckRow,
    item: typeof logItem.$inferSelect,
    fallback: ResolvedFallback,
    missingEpisodeId: string | null,
  ) {
    // The mark goes first: if the edit then fails, the retry finds it and still edits; the
    // as-run only reads it for an item that airs with it.
    const mark = {
      orgId: scope.orgId,
      stationId: scope.stationId,
      slotId: row.slotId,
      occurrenceDate: row.occurrenceDate,
      kind: fallback.kind,
      episodeId: fallback.kind === 'clock_music' ? null : fallback.episodeId,
      missingEpisodeId,
    };
    await db
      .insert(logItemFallback)
      .values({ ...mark, logItemId: item.id })
      .onConflictDoNothing();
    const ctx = { actor: ACTOR, scope };
    if (fallback.kind === 'clock_music') {
      const [first, ...rest] = fallback.items;
      if (!first) return;
      let outcome = await log.replaceLogItem(db, ctx, item.id, {
        ...first,
        timing: item.timing,
        anchorAt: item.anchorAt?.toISOString() ?? null,
        capMs: item.capMs,
      } as LogItemInput);
      await publishEdit(options.logEvents, logger, scope.stationId, outcome);
      for (const next of rest) {
        outcome = await log.insertLogItem(db, ctx, { after: outcome.itemId }, next);
        // Every item of the fill airs as the fallback.
        await db
          .insert(logItemFallback)
          .values({ ...mark, logItemId: outcome.itemId })
          .onConflictDoNothing();
        await publishEdit(options.logEvents, logger, scope.stationId, outcome);
      }
      return;
    }
    const outcome = await log.replaceLogItem(
      db,
      ctx,
      item.id,
      replacement(item, {
        kind: 'episode',
        assetId: fallback.assetId,
        episodeId: fallback.episodeId,
        title: item.title,
      }),
    );
    await publishEdit(options.logEvents, logger, scope.stationId, outcome);
  }

  async function fallbackStep(row: CheckRow) {
    const { scope, info, premiere } = await context(row);
    if (!info) return finish(row.id, 'show_gone');
    if (premiere?.assetId) return finish(row.id, 'episode_ready');
    const [marked] = await db
      .select({ logItemId: logItemFallback.logItemId })
      .from(logItemFallback)
      .where(
        and(
          whereStation(logItemFallback, scope),
          eq(logItemFallback.slotId, row.slotId),
          eq(logItemFallback.occurrenceDate, row.occurrenceDate),
        ),
      )
      .limit(1);
    const item = await emptyItem(scope, row, premiere?.id ?? null);
    if (!item) {
      // Already in place (a retry after the edit committed), or nothing of the slot in the log.
      if (marked) return finish(row.id, 'fallback_applied');
      await critical(scope, row, info, 'its slot has no item in the log to put a fallback in');
      return finish(row.id, 'no_log_item');
    }
    const { policy, fallback } = await resolveFallback(
      db,
      scope,
      {
        showId: row.showId,
        missingEpisodeId: premiere?.id ?? null,
        occurrenceDate: row.occurrenceDate,
        startsAt: row.startsAt,
        durationMs: row.endsAt.getTime() - row.startsAt.getTime(),
      },
      options.fallback,
    );
    if (!fallback) {
      await critical(
        scope,
        row,
        info,
        policy === 'none'
          ? 'the show has no fallback: the safety playlist will play'
          : `its fallback (${policy}) has nothing to air: the safety playlist will play`,
      );
      return finish(row.id, 'no_fallback');
    }
    await applyFallback(scope, row, item, fallback, premiere?.id ?? null);
    await alerts.raise(scope, {
      type: alertTypes.episodeMissing,
      severity: 'warning',
      dedupeKey: dedupeKey(row.slotId, row.occurrenceDate),
      title: `Episode missing: ${info.showName}, fallback airs`,
      message: `${info.showName} airs ${formatStationTime(row.startsAt, info.timezone)} without its episode: ${POLICY_TEXT[fallback.kind]} instead.`,
      details: details(row, { step: 'fallback', fallback: fallback.kind, logItemId: item.id }),
    });
    logger.info(
      { stationId: scope.stationId, slotId: row.slotId, fallback: fallback.kind },
      'Episode fallback applied',
    );
    return finish(row.id, 'fallback_applied');
  }

  /** Nothing will air in the slot: critical, so the framework emails the alert managers. */
  async function critical(
    scope: StationScope,
    row: CheckRow,
    info: { showName: string; timezone: string },
    why: string,
  ) {
    await alerts.raise(scope, {
      type: alertTypes.episodeMissing,
      severity: 'critical',
      dedupeKey: dedupeKey(row.slotId, row.occurrenceDate),
      title: `Episode missing: ${info.showName}, no fallback`,
      message: `${info.showName} airs ${formatStationTime(row.startsAt, info.timezone)} without its episode, and ${why}.`,
      details: details(row, { step: 'fallback', fallback: null }),
    });
  }

  async function process(row: CheckRow) {
    try {
      if (row.step === 'fallback') await fallbackStep(row);
      else await alertStep(row as CheckRow & { step: 't48h' | 't6h' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, stepId: row.id, step: row.step }, 'Episode check step failed');
      // Released for a retry on a later sweep; given up after MAX_ATTEMPTS.
      await db
        .update(episodeCheck)
        .set(
          row.attempts >= MAX_ATTEMPTS
            ? { processedAt: now(), result: 'failed', error: message }
            : { claimedAt: null, error: message },
        )
        .where(eq(episodeCheck.id, row.id));
    }
  }

  /** Puts the episode back in place of its fallback when its audio arrived in time. */
  async function restore() {
    const cutoff = new Date(now().getTime() + EPISODE_RESTORE_MIN_LEAD_MS);
    const rows = await db
      .select({
        logItemId: logItemFallback.logItemId,
        orgId: logItemFallback.orgId,
        stationId: logItemFallback.stationId,
        kind: logItemFallback.kind,
        itemAssetId: logItem.assetId,
        premiereId: episode.id,
        premiereAssetId: episode.assetId,
        item: logItem,
      })
      .from(logItemFallback)
      .innerJoin(logItem, eq(logItem.id, logItemFallback.logItemId))
      .innerJoin(
        episode,
        and(
          eq(episode.slotId, logItemFallback.slotId),
          eq(episode.occurrenceDate, logItemFallback.occurrenceDate),
        ),
      )
      .where(and(gt(logItem.plannedStart, cutoff), isNotNull(episode.assetId)));
    for (const r of rows) {
      const scope = unsafeScope(r.orgId, r.stationId);
      // Clock music took several items: putting the episode back is the generator's (#50).
      if (r.kind === 'clock_music' || !r.premiereAssetId) continue;
      try {
        if (r.itemAssetId !== r.premiereAssetId) {
          const outcome = await log.replaceLogItem(
            db,
            { actor: ACTOR, scope },
            r.logItemId,
            replacement(r.item, {
              kind: 'episode',
              assetId: r.premiereAssetId,
              episodeId: r.premiereId,
              title: r.item.title,
            }),
          );
          await publishEdit(options.logEvents, logger, scope.stationId, outcome);
        }
        await db
          .delete(logItemFallback)
          .where(
            and(whereStation(logItemFallback, scope), eq(logItemFallback.logItemId, r.logItemId)),
          );
        logger.info({ stationId: r.stationId, logItemId: r.logItemId }, 'Episode restored');
      } catch (error) {
        logger.error({ err: error, logItemId: r.logItemId }, 'Episode restore failed');
      }
    }
  }

  /** Resolves open missing-episode alerts whose audio arrived or whose occurrence is over. */
  async function resolveAlerts() {
    const open = await db
      .select({ orgId: alert.orgId, stationId: alert.stationId, details: alert.details })
      .from(alert)
      .where(and(eq(alert.type, alertTypes.episodeMissing), isNull(alert.resolvedAt)));
    for (const a of open) {
      const scope = unsafeScope(a.orgId, a.stationId);
      const d = a.details as { slotId?: string; occurrenceDate?: string; endsAt?: string };
      if (!d.slotId || !d.occurrenceDate) continue;
      const key = dedupeKey(d.slotId, d.occurrenceDate);
      const [premiere] = await db
        .select({
          id: episode.id,
          showId: episode.showId,
          assetId: episode.assetId,
          status: episode.status,
        })
        .from(episode)
        .where(
          and(
            whereStation(episode, scope),
            eq(episode.slotId, d.slotId),
            eq(episode.occurrenceDate, d.occurrenceDate),
          ),
        );
      try {
        if (premiere?.assetId) {
          await alerts.resolve(scope, key, { reason: 'episode_ready' });
        } else if (d.endsAt && Date.parse(d.endsAt) <= now().getTime()) {
          // Its slot came and the audio wasn't there (contracts/shows.ts `missing`).
          if (premiere && premiere.status === 'planned') {
            await updateEpisode(db, { actor: ACTOR, scope }, premiere.showId, premiere.id, {
              status: 'missing',
            });
          }
          await alerts.resolve(scope, key, { reason: 'occurrence_ended' });
        }
      } catch (error) {
        logger.error({ err: error, dedupeKey: key }, 'Missing-episode alert reconcile failed');
      }
    }
  }

  return {
    /** Works off pending steps until none is left (or `max` were handled). */
    async processPending(max = 200): Promise<number> {
      let done = 0;
      while (done < max) {
        const rows = await claim(20);
        if (!rows.length) break;
        for (const row of rows) await process(row);
        done += rows.length;
      }
      return done;
    },
    async reconcile(): Promise<void> {
      await restore();
      await resolveAlerts();
    },
  };
}
