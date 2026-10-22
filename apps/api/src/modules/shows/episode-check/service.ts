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
  type EpisodeFallbackKind,
  type EpisodeFallbackPolicy,
  type LogItemInput,
} from '@ondes/shared';
import { and, asc, eq, gt, gte, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
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
//   nothing can air. With no item for the slot yet, it waits for one until the slot starts.
// `reconcile` resolves alerts whose audio arrived or whose slot is over, puts an episode whose
// audio arrived in time back in place of its fallback, and marks premieres that never got
// audio `missing`.
//
// Claims: `FOR UPDATE SKIP LOCKED`, in air order (start, then t48h, t6h, fallback). A claim
// older than `CLAIM_TIMEOUT_MS` is taken over, so every write checks the claim is still ours.
// A failed step backs off through `retry_at` and is given up after `MAX_ATTEMPTS`.
// Every log and episode change goes through the log and shows repositories, audited as the
// system actor `episode-check`.
//
// Dashboard text: the alert's title and message are English and set when the alert opens (or
// escalates: a repeat raise only merges `details`); `details.i18n` carries the current message
// key and its parameters for the web app to render in the viewer's language.

const ACTOR: Actor = { type: 'system', name: 'episode-check' };
const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;
/** Backoff after the n-th failure: 30 s, 1 min, 2 min, … up to 15 min. */
const backoffMs = (attempts: number) => Math.min(30_000 * 2 ** (attempts - 1), 15 * 60 * 1000);
/** How often a fallback with no log item for its slot looks again, until the slot starts. */
const LOG_WAIT_MS = 60 * 1000;
const MAX_RESTORE_ATTEMPTS = 5;
/** An occurrence's log item starts within this much of the occurrence (retiming drift). */
const ITEM_MATCH_MS = 5 * 60 * 1000;

type AlertStep = Exclude<EpisodeCheckStep, 'fallback'>;
const SEVERITY: Record<AlertStep, AlertSeverity> = { t48h: 'info', t6h: 'warning' };
const LEAD_TEXT: Record<AlertStep, string> = { t48h: 'in 48 hours', t6h: 'in 6 hours' };
const POLICY_TEXT: Record<EpisodeFallbackPolicy, string> = {
  latest_episode: 'the latest episode airs again',
  episode: 'the episode chosen in the show settings airs again',
  clock_music: 'music from the clock airs',
  none: 'nothing is planned: the safety playlist plays',
};

/** Steps of one occurrence run in this order. */
const stepRank = sql`case ${episodeCheck.step} when 't48h' then 0 when 't6h' then 1 else 2 end`;

type CheckRow = typeof episodeCheck.$inferSelect;
type ItemRow = typeof logItem.$inferSelect;

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

  // --- Claims ----------------------------------------------------------------------------

  /** Claims up to `limit` pending steps whose time has come, in air order. */
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
            or(isNull(episodeCheck.retryAt), lte(episodeCheck.retryAt, at)),
            or(isNull(episodeCheck.claimedAt), lt(episodeCheck.claimedAt, stale)),
          ),
        )
        .orderBy(asc(episodeCheck.startsAt), asc(stepRank), asc(episodeCheck.createdAt))
        .limit(limit)
        .for('update', { skipLocked: true });
      const claimed: CheckRow[] = [];
      for (const { id } of ids) {
        const [row] = await tx
          .update(episodeCheck)
          .set({ claimedAt: at })
          .where(eq(episodeCheck.id, id))
          .returning();
        if (row) claimed.push(row);
      }
      return claimed;
    });
  }

  /** The row, while this claim still holds it (no other replica took it over). */
  const ours = (row: CheckRow) =>
    and(
      eq(episodeCheck.id, row.id),
      row.claimedAt ? eq(episodeCheck.claimedAt, row.claimedAt) : isNull(episodeCheck.claimedAt),
    );

  async function stillOurs(row: CheckRow): Promise<boolean> {
    const [found] = await db.select({ id: episodeCheck.id }).from(episodeCheck).where(ours(row));
    return !!found;
  }

  async function finish(row: CheckRow, result: string) {
    await db.update(episodeCheck).set({ processedAt: now(), result, error: null }).where(ours(row));
  }

  /** Back to pending, not before `retryAt`. */
  async function release(
    row: CheckRow,
    retryAt: Date,
    fields: Partial<Pick<CheckRow, 'attempts' | 'error'>> = {},
  ) {
    await db
      .update(episodeCheck)
      .set({ claimedAt: null, retryAt, ...fields })
      .where(ours(row));
  }

  // --- Context ---------------------------------------------------------------------------

  async function context(row: CheckRow) {
    // The ids come from the row this claim just read.
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

  type Info = NonNullable<Awaited<ReturnType<typeof context>>['info']>;

  const dedupeKey = (slotId: string, date: string) =>
    `${alertTypes.episodeMissing}:${slotId}:${date}`;

  /** Alert details, with the message key and parameters the web app renders (FR, EN). */
  const details = (
    row: CheckRow,
    info: Info,
    i18n: { key: string; params?: Record<string, unknown> },
    extra: Record<string, unknown> = {},
  ) => ({
    showId: row.showId,
    slotId: row.slotId,
    occurrenceDate: row.occurrenceDate,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    episodeId: row.episodeId,
    ...extra,
    i18n: {
      key: i18n.key,
      params: { show: info.showName, startsAt: row.startsAt.toISOString(), ...i18n.params },
    },
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

  // --- Alert steps -----------------------------------------------------------------------

  async function alertStep(row: CheckRow, step: AlertStep) {
    const { scope, info, premiere } = await context(row);
    if (!info) return finish(row, 'show_gone');
    if (premiere?.assetId) return finish(row, 'episode_ready');
    // The fallback already ran (steps of one occurrence can be claimed by two replicas):
    // a "6 hours ahead" alert would only overwrite its news.
    const [fallbackDone] = await db
      .select({ id: episodeCheck.id })
      .from(episodeCheck)
      .where(
        and(
          whereStation(episodeCheck, scope),
          eq(episodeCheck.slotId, row.slotId),
          eq(episodeCheck.occurrenceDate, row.occurrenceDate),
          eq(episodeCheck.step, 'fallback'),
          isNotNull(episodeCheck.processedAt),
        ),
      );
    if (fallbackDone) return finish(row, 'superseded');

    const airsAt = formatStationTime(row.startsAt, info.timezone);
    const fallback = POLICY_TEXT[info.policy];
    await alerts.raise(scope, {
      type: alertTypes.episodeMissing,
      severity: SEVERITY[step],
      dedupeKey: dedupeKey(row.slotId, row.occurrenceDate),
      title: `Episode missing: ${info.showName}`,
      message: `${info.showName} airs ${LEAD_TEXT[step]}, ${airsAt}, and its episode has no audio yet. If it's still missing an hour before, ${fallback}.`,
      details: details(
        row,
        info,
        { key: 'episodeMissing.ahead', params: { lead: step, policy: info.policy } },
        { step, fallbackPolicy: info.policy },
      ),
    });
    const link = `${options.appUrl}/stations/${scope.stationId}/shows/${row.showId}`;
    const sent = new Set(row.notified);
    for (const r of await recipients(scope, row.showId)) {
      if (sent.has(r.email)) continue;
      // Another replica took the step over (this one was too slow): it sends the rest.
      if (!(await stillOurs(row))) return;
      await sendTemplate(options.mailer, r.email, missingEpisodeTemplate, {
        name: r.name,
        stationName: info.stationName,
        showName: info.showName,
        airsAt,
        lead: LEAD_TEXT[step],
        fallback,
        link,
      });
      // Recorded one by one: a retry after a failed send skips who already got it.
      await db
        .update(episodeCheck)
        .set({ notified: sql`array_append(${episodeCheck.notified}, ${r.email})` })
        .where(eq(episodeCheck.id, row.id));
    }
    return finish(row, 'alerted');
  }

  // --- Fallback step ---------------------------------------------------------------------

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

  /** New content for `item`, in its place and with its timing. */
  function replacement(
    item: ItemRow,
    content: { kind: 'episode'; assetId: string; episodeId: string },
  ): LogItemInput {
    return {
      ...content,
      title: item.title,
      plannedDurationMs: item.plannedDurationMs,
      timing: item.timing,
      anchorAt: item.anchorAt?.toISOString() ?? null,
      capMs: item.capMs,
      locked: item.locked,
    };
  }

  /**
   * Puts the fallback in the item and marks what it put there, in one transaction: a clock
   * music fill lands whole or not at all. The events go out after the commit.
   */
  async function applyFallback(
    scope: StationScope,
    row: CheckRow,
    item: ItemRow,
    fallback: ResolvedFallback,
    missingEpisodeId: string | null,
  ) {
    const mark = {
      orgId: scope.orgId,
      stationId: scope.stationId,
      slotId: row.slotId,
      occurrenceDate: row.occurrenceDate,
      kind: fallback.kind,
      episodeId: fallback.kind === 'clock_music' ? null : fallback.episodeId,
      missingEpisodeId,
    };
    const ctx = { actor: ACTOR, scope };
    const outcomes = await db.transaction(async (tx) => {
      // The log repository's edits take a `Db`; inside this transaction they run as savepoints.
      const inTx = tx as unknown as Db;
      const done: log.LogEditOutcome[] = [];
      const marked = async (outcome: log.LogEditOutcome) => {
        done.push(outcome);
        const assetId = outcome.result.item?.assetId;
        if (assetId) {
          await tx.insert(logItemFallback).values({ ...mark, logItemId: outcome.itemId, assetId });
        }
      };
      if (fallback.kind === 'clock_music') {
        const [first, ...rest] = fallback.items;
        if (!first) return done;
        let outcome = await log.replaceLogItem(inTx, ctx, item.id, {
          ...first,
          timing: item.timing,
          anchorAt: item.anchorAt?.toISOString() ?? null,
          capMs: item.capMs,
        });
        await marked(outcome);
        for (const next of rest) {
          outcome = await log.insertLogItem(inTx, ctx, { after: outcome.itemId }, next);
          await marked(outcome);
        }
        return done;
      }
      await marked(
        await log.replaceLogItem(
          inTx,
          ctx,
          item.id,
          replacement(item, {
            kind: 'episode',
            assetId: fallback.assetId,
            episodeId: fallback.episodeId,
          }),
        ),
      );
      return done;
    });
    for (const outcome of outcomes) {
      await publishEdit(options.logEvents, logger, scope.stationId, outcome);
    }
  }

  /** "Fallback airs": raised after the edit, and again by a retry that finds it done. */
  async function fallbackAlert(
    scope: StationScope,
    row: CheckRow,
    info: Info,
    kind: EpisodeFallbackKind,
    logItemId: string,
  ) {
    await alerts.raise(scope, {
      type: alertTypes.episodeMissing,
      severity: 'warning',
      dedupeKey: dedupeKey(row.slotId, row.occurrenceDate),
      // A raise on the open alert only merges `details` (#33): the title and message stay the
      // first ones, and `details.i18n` / `fallback` carry what airs now.
      title: `Episode missing: ${info.showName}`,
      message: `${info.showName} airs ${formatStationTime(row.startsAt, info.timezone)} without its episode: ${POLICY_TEXT[kind]} instead.`,
      details: details(
        row,
        info,
        { key: 'episodeMissing.fallback', params: { fallback: kind } },
        { step: 'fallback', fallback: kind, logItemId },
      ),
    });
  }

  /** Nothing will air in the slot: critical, so the framework emails the alert managers. */
  async function critical(
    scope: StationScope,
    row: CheckRow,
    info: Info,
    reason: 'no_log_item' | 'no_fallback',
    why: string,
  ) {
    await alerts.raise(scope, {
      type: alertTypes.episodeMissing,
      severity: 'critical',
      dedupeKey: dedupeKey(row.slotId, row.occurrenceDate),
      title: `Episode missing: ${info.showName}, no fallback`,
      message: `${info.showName} airs ${formatStationTime(row.startsAt, info.timezone)} without its episode, and ${why}.`,
      details: details(
        row,
        info,
        { key: 'episodeMissing.noFallback', params: { reason, policy: info.policy } },
        { step: 'fallback', fallback: null },
      ),
    });
  }

  async function fallbackStep(row: CheckRow) {
    const { scope, info, premiere } = await context(row);
    if (!info) return finish(row, 'show_gone');
    if (premiere?.assetId) return finish(row, 'episode_ready');
    const item = await emptyItem(scope, row, premiere?.id ?? null);
    if (!item) {
      // Already in place: a retry after the edit committed. The alert may not have followed.
      const [marked] = await db
        .select({ logItemId: logItemFallback.logItemId, kind: logItemFallback.kind })
        .from(logItemFallback)
        .where(
          and(
            whereStation(logItemFallback, scope),
            eq(logItemFallback.slotId, row.slotId),
            eq(logItemFallback.occurrenceDate, row.occurrenceDate),
          ),
        )
        .limit(1);
      if (marked) {
        await fallbackAlert(scope, row, info, marked.kind, marked.logItemId);
        return finish(row, 'fallback_applied');
      }
      // Nothing of the slot in the log yet (the generator, #50, writes it): look again until
      // the slot starts, then give up loudly.
      if (now() < row.startsAt) {
        return release(row, new Date(now().getTime() + LOG_WAIT_MS), { error: null });
      }
      await critical(
        scope,
        row,
        info,
        'no_log_item',
        'its slot has no item in the log to put a fallback in',
      );
      return finish(row, 'no_log_item');
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
        'no_fallback',
        policy === 'none'
          ? 'the show has no fallback: the safety playlist will play'
          : `its fallback (${policy}) has nothing to air: the safety playlist will play`,
      );
      return finish(row, 'no_fallback');
    }
    if (!(await stillOurs(row))) return;
    await applyFallback(scope, row, item, fallback, premiere?.id ?? null);
    await fallbackAlert(scope, row, info, fallback.kind, item.id);
    logger.info(
      { stationId: scope.stationId, slotId: row.slotId, fallback: fallback.kind },
      'Episode fallback applied',
    );
    return finish(row, 'fallback_applied');
  }

  async function process(row: CheckRow) {
    try {
      if (row.step === 'fallback') await fallbackStep(row);
      else await alertStep(row, row.step);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = row.attempts + 1;
      logger.error(
        { err: error, stepId: row.id, step: row.step, attempts },
        'Episode check step failed',
      );
      if (attempts >= MAX_ATTEMPTS) {
        await db
          .update(episodeCheck)
          .set({ processedAt: now(), result: 'failed', error: message, attempts })
          .where(ours(row));
      } else {
        // On a later sweep, not this one: a transient error doesn't burn the attempts.
        await release(row, new Date(now().getTime() + backoffMs(attempts)), {
          attempts,
          error: message,
        });
      }
    }
  }

  // --- Reconcile -------------------------------------------------------------------------

  /**
   * The stations that have rows in `table`. Only the station ids are read across tenants;
   * each station's rows are then read with its scope.
   */
  async function stationsOf(
    table: typeof logItemFallback | typeof alert,
    where?: ReturnType<typeof and>,
  ): Promise<StationScope[]> {
    const rows = await db
      .selectDistinct({ orgId: table.orgId, stationId: table.stationId })
      .from(table)
      .where(where);
    return rows.map((r) => unsafeScope(r.orgId, r.stationId));
  }

  /**
   * Puts the premiere back in place of its fallback when its audio arrived in time. An item
   * an operator changed since (it no longer plays what the fallback put there) is theirs: its
   * mark goes, the item stays.
   */
  async function restore() {
    const cutoff = new Date(now().getTime() + EPISODE_RESTORE_MIN_LEAD_MS);
    const stations = await stationsOf(
      logItemFallback,
      lt(logItemFallback.restoreAttempts, MAX_RESTORE_ATTEMPTS),
    );
    for (const scope of stations) {
      const rows = await db
        .select({
          mark: logItemFallback,
          item: logItem,
          premiereId: episode.id,
          premiereAssetId: episode.assetId,
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
        .where(
          and(
            whereStation(logItemFallback, scope),
            whereStation(logItem, scope),
            whereStation(episode, scope),
            gt(logItem.plannedStart, cutoff),
            isNotNull(episode.assetId),
            lt(logItemFallback.restoreAttempts, MAX_RESTORE_ATTEMPTS),
          ),
        );
      for (const { mark, item, premiereId, premiereAssetId } of rows) {
        // Clock music took several items: putting the episode back is the generator's (#50).
        if (mark.kind === 'clock_music' || !premiereAssetId) continue;
        const forget = () =>
          db
            .delete(logItemFallback)
            .where(
              and(whereStation(logItemFallback, scope), eq(logItemFallback.logItemId, item.id)),
            );
        try {
          if (item.assetId === premiereAssetId) {
            // Restored already (the mark outlived a crash).
          } else if (item.assetId !== mark.assetId) {
            logger.info({ logItemId: item.id }, 'Fallback item changed by hand: left as is');
          } else {
            const outcome = await log.replaceLogItem(
              db,
              { actor: ACTOR, scope },
              item.id,
              replacement(item, {
                kind: 'episode',
                assetId: premiereAssetId,
                episodeId: premiereId,
              }),
            );
            await publishEdit(options.logEvents, logger, scope.stationId, outcome);
            logger.info({ stationId: scope.stationId, logItemId: item.id }, 'Episode restored');
          }
          await forget();
        } catch (error) {
          logger.error({ err: error, logItemId: item.id }, 'Episode restore failed');
          await db
            .update(logItemFallback)
            .set({ restoreAttempts: sql`${logItemFallback.restoreAttempts} + 1` })
            .where(
              and(whereStation(logItemFallback, scope), eq(logItemFallback.logItemId, item.id)),
            );
        }
      }
    }
  }

  /** Resolves open missing-episode alerts whose audio arrived or whose occurrence is over. */
  async function resolveAlerts() {
    const openAlerts = and(eq(alert.type, alertTypes.episodeMissing), isNull(alert.resolvedAt));
    for (const scope of await stationsOf(alert, openAlerts)) {
      const open = await db
        .select({ details: alert.details })
        .from(alert)
        .where(and(whereStation(alert, scope), openAlerts));
      for (const a of open) {
        const d = a.details as { slotId?: string; occurrenceDate?: string; endsAt?: string };
        if (!d.slotId || !d.occurrenceDate) continue;
        const key = dedupeKey(d.slotId, d.occurrenceDate);
        try {
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
  }

  return {
    /** Works off the steps that are due until none is left (or `max` were handled). */
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
