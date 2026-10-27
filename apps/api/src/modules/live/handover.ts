import { randomUUID } from 'node:crypto';
import {
  type Db,
  liveHandover,
  NotFoundError,
  type StationScope,
  streamer,
  whereStation,
  withAudit,
} from '@ondes/db';
import type {
  Actor,
  LiveHandover,
  LiveHandoverFailure,
  LiveHandoverStatus,
  RealtimeEvent,
} from '@ondes/shared';
import { and, asc, eq, gte, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';
import { type LiveSwitchEngineLookup, type LiveSwitcher, openLiveSession } from './switching.ts';

// Scheduled DJ handovers (#66, ADR 0038). A member schedules "at 23:00, DJ B takes the air with
// a 3 s crossfade"; at that time the api finds the input B is connected on and hands the air to
// it through the switcher (`goLive`, trigger `manual`: the slot takeover never undoes it).
//
// Every replica runs `sweep` with the switcher's (every 5 s). It arms a timer for each pending
// handover due within the next `LOOKAHEAD_MS`, so the switch lands on time rather than up to a
// sweep late; scheduling one that is due sooner arms it at once. Whichever replica's timer fires
// first claims the row (`pending` → `running`); the others find it claimed and do nothing.
// A handover more than `MISSED_MS` late (no api was running) fails `missed` instead of switching
// at a time nobody chose; a claim left `running` past `MISSED_MS` (its replica died) fails
// `interrupted`.

const LOOKAHEAD_MS = 10_000;
const MISSED_MS = 60_000;
/** The furthest ahead a handover may be scheduled. */
const HORIZON_MS = 24 * 3600_000;

const SYSTEM: Actor = { type: 'system', name: 'live-handover' };

type Logger = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

type Ctx = { actor: Actor; scope: StationScope };

/** A row that left the expected status before this replica could update it. */
class StatusMoved extends Error {}
type HandoverRow = typeof liveHandover.$inferSelect;

export type LiveHandoversOptions = {
  db: Db;
  switcher: Pick<LiveSwitcher, 'goLive'>;
  engineFor?: LiveSwitchEngineLookup;
  publish?: (event: RealtimeEvent) => unknown;
  logger: Logger;
  now?: () => Date;
};

export type LiveHandovers = {
  /** The pending and running handovers, and those that ended in the last 24 h, by time. */
  list(scope: StationScope): Promise<LiveHandover[]>;
  schedule(
    ctx: Ctx,
    input: { streamerId: string; at: Date; fadeMs: number },
  ): Promise<LiveHandover>;
  /** 409 once it ran (or is running). */
  cancel(ctx: Ctx, id: string): Promise<LiveHandover>;
  /** Arms the timers of handovers due soon; fails missed and interrupted ones. */
  sweep(scope: StationScope): Promise<void>;
  /** Carries out one handover now, if it is still pending (the timers call this). */
  run(scope: StationScope, id: string): Promise<void>;
  /** Clears this replica's timers. */
  close(): void;
};

export function createLiveHandovers(options: LiveHandoversOptions): LiveHandovers {
  const { db, logger } = options;
  const now = () => options.now?.() ?? new Date();
  const timers = new Map<string, NodeJS.Timeout>();

  async function names(stationId: string, ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    const rows = await db
      .select({ id: streamer.id, displayName: streamer.displayName })
      .from(streamer)
      .where(and(eq(streamer.stationId, stationId), inArray(streamer.id, [...new Set(ids)])));
    return new Map(rows.map((r) => [r.id, r.displayName]));
  }

  function toHandover(row: HandoverRow, byId: Map<string, string>): LiveHandover {
    const name = byId.get(row.streamerId);
    return {
      id: row.id,
      streamer: name === undefined ? null : { id: row.streamerId, displayName: name },
      at: row.at,
      fadeMs: row.fadeMs,
      status: row.status,
      reason: row.reason,
      sessionId: row.sessionId,
      createdAt: row.createdAt,
    };
  }

  async function publish(scope: StationScope, id: string, status: LiveHandoverStatus) {
    if (!options.publish) return;
    try {
      await options.publish({
        id: randomUUID(),
        stationId: scope.stationId,
        at: now().toISOString(),
        type: 'live.handover.changed',
        data: { handoverId: id, status },
      });
    } catch (err) {
      logger.warn({ err, stationId: scope.stationId }, 'Publishing a handover event failed');
    }
  }

  function arm(scope: StationScope, row: Pick<HandoverRow, 'id' | 'at'>) {
    if (timers.has(row.id)) return;
    const timer = setTimeout(
      () => {
        timers.delete(row.id);
        run(scope, row.id).catch((err: unknown) =>
          logger.error({ err, stationId: scope.stationId, handoverId: row.id }, 'Handover failed'),
        );
      },
      Math.max(0, row.at.getTime() - now().getTime()),
    );
    timer.unref();
    timers.set(row.id, timer);
  }

  /** Ends a running (or, for `missed`, pending) handover. False if it was no longer in `from`. */
  async function finish(
    scope: StationScope,
    row: HandoverRow,
    from: LiveHandoverStatus,
    to: 'done' | 'failed',
    outcome: { reason?: LiveHandoverFailure; sessionId?: string },
  ) {
    const ended = await withAudit(db, { actor: SYSTEM, scope }, async (tx, audit) => {
      const [updated] = await tx
        .update(liveHandover)
        .set({
          status: to,
          reason: outcome.reason ?? null,
          sessionId: outcome.sessionId ?? null,
          endedAt: now(),
        })
        .where(and(eq(liveHandover.id, row.id), eq(liveHandover.status, from)))
        .returning();
      // Ended meanwhile (another replica): nothing to write; the transaction rolls back.
      if (!updated) throw new StatusMoved();
      await audit({
        action: to === 'done' ? 'live_handover.run' : 'live_handover.fail',
        entity: { type: 'live_handover', id: row.id },
        diff: {
          status: { from, to },
          ...(outcome.reason ? { reason: { from: null, to: outcome.reason } } : {}),
          ...(outcome.sessionId ? { sessionId: { from: null, to: outcome.sessionId } } : {}),
        },
      });
      return updated;
    }).catch((err: unknown) => {
      if (err instanceof StatusMoved) return undefined;
      throw err;
    });
    if (ended) await publish(scope, row.id, to);
    return !!ended;
  }

  /** The failure an error of the switch maps to. */
  function failureOf(err: unknown): LiveHandoverFailure {
    if (!(err instanceof HttpError)) return 'error';
    if (err.code === 'streamer_not_allowed') return 'streamer_not_allowed';
    if (err.code === 'live_input_not_connected') return 'not_connected';
    if (err.code === 'engine_unavailable') return 'engine_unavailable';
    return 'error';
  }

  async function run(scope: StationScope, id: string) {
    const [claimed] = await db
      .update(liveHandover)
      .set({ status: 'running', claimedAt: now() })
      .where(
        and(
          eq(liveHandover.id, id),
          whereStation(liveHandover, scope),
          eq(liveHandover.status, 'pending'),
        ),
      )
      .returning();
    if (!claimed) return; // another replica, or cancelled
    await publish(scope, id, 'running');
    if (now().getTime() - claimed.at.getTime() > MISSED_MS) {
      await finish(scope, claimed, 'running', 'failed', { reason: 'missed' });
      return;
    }

    const engine = options.engineFor ? await options.engineFor(scope.stationId) : undefined;
    const state = await engine?.state().catch(() => undefined);
    if (!state) {
      await finish(scope, claimed, 'running', 'failed', { reason: 'engine_unavailable' });
      return;
    }
    // The input the DJ is connected on now: they may have picked any free mount.
    const slot = state.live.inputs?.find(
      (i) => i.connected && i.streamer_id === claimed.streamerId,
    );
    if (!slot) {
      await finish(scope, claimed, 'running', 'failed', { reason: 'not_connected' });
      return;
    }
    // Already on air there (put on by hand before the time): nothing to switch.
    const open = await openLiveSession(db, scope.stationId);
    if (
      open &&
      open.input === slot.input &&
      open.streamerId === claimed.streamerId &&
      state.live.on_air === slot.input
    ) {
      await finish(scope, claimed, 'running', 'done', { sessionId: open.id });
      return;
    }
    try {
      const session = await options.switcher.goLive(
        { actor: SYSTEM, scope },
        slot.input,
        'manual',
        undefined,
        { fadeMs: claimed.fadeMs },
      );
      await finish(scope, claimed, 'running', 'done', { sessionId: session.id });
      logger.info(
        { stationId: scope.stationId, handoverId: id, input: slot.input },
        'Scheduled handover done',
      );
    } catch (err) {
      const reason = failureOf(err);
      if (reason === 'error') {
        logger.error({ err, stationId: scope.stationId, handoverId: id }, 'Handover failed');
      }
      await finish(scope, claimed, 'running', 'failed', { reason });
    }
  }

  return {
    async list(scope) {
      const since = new Date(now().getTime() - HORIZON_MS);
      const rows = await db
        .select()
        .from(liveHandover)
        .where(
          and(
            whereStation(liveHandover, scope),
            or(
              inArray(liveHandover.status, ['pending', 'running']),
              gte(liveHandover.endedAt, since),
            ),
          ),
        )
        .orderBy(asc(liveHandover.at), asc(liveHandover.createdAt));
      const byId = await names(
        scope.stationId,
        rows.map((r) => r.streamerId),
      );
      return rows.map((r) => toHandover(r, byId));
    },

    async schedule(ctx, input) {
      const t = now().getTime();
      if (input.at.getTime() <= t) {
        throw new HttpError(400, 'live_handover_in_past', 'a handover must be in the future');
      }
      if (input.at.getTime() > t + HORIZON_MS) {
        throw new HttpError(400, 'live_handover_too_far', 'a handover is at most 24 h ahead');
      }
      const [dj] = await db
        .select({ id: streamer.id, displayName: streamer.displayName })
        .from(streamer)
        .where(and(eq(streamer.id, input.streamerId), whereStation(streamer, ctx.scope)));
      if (!dj) throw new NotFoundError('streamer', input.streamerId);
      const row = await withAudit(db, ctx, async (tx, audit) => {
        const [created] = await tx
          .insert(liveHandover)
          .values({
            orgId: ctx.scope.orgId,
            stationId: ctx.scope.stationId,
            streamerId: dj.id,
            at: input.at,
            fadeMs: input.fadeMs,
            createdBy: ctx.actor.type === 'user' ? ctx.actor.userId : null,
          })
          .returning();
        if (!created) throw new Error('live handover insert returned nothing');
        await audit({
          action: 'live_handover.create',
          entity: { type: 'live_handover', id: created.id },
          diff: {
            streamerId: { from: null, to: dj.id },
            at: { from: null, to: input.at.toISOString() },
            fadeMs: { from: null, to: input.fadeMs },
          },
        });
        return created;
      });
      if (row.at.getTime() - now().getTime() <= LOOKAHEAD_MS) arm(ctx.scope, row);
      await publish(ctx.scope, row.id, 'pending');
      return toHandover(row, new Map([[dj.id, dj.displayName]]));
    },

    async cancel(ctx, id) {
      const [existing] = await db
        .select()
        .from(liveHandover)
        .where(and(eq(liveHandover.id, id), whereStation(liveHandover, ctx.scope)));
      if (!existing) throw new NotFoundError('live_handover', id);
      const row = await withAudit(db, ctx, async (tx, audit) => {
        const [updated] = await tx
          .update(liveHandover)
          .set({ status: 'cancelled', endedAt: now() })
          .where(and(eq(liveHandover.id, id), eq(liveHandover.status, 'pending')))
          .returning();
        if (!updated) {
          throw new HttpError(409, 'live_handover_ended', `the handover is ${existing.status}`);
        }
        await audit({
          action: 'live_handover.cancel',
          entity: { type: 'live_handover', id },
          diff: { status: { from: 'pending', to: 'cancelled' } },
        });
        return updated;
      });
      clearTimeout(timers.get(id));
      timers.delete(id);
      await publish(ctx.scope, id, 'cancelled');
      return toHandover(row, await names(ctx.scope.stationId, [row.streamerId]));
    },

    async sweep(scope) {
      const t = now().getTime();
      const due = await db
        .select()
        .from(liveHandover)
        .where(
          and(
            whereStation(liveHandover, scope),
            eq(liveHandover.status, 'pending'),
            lte(liveHandover.at, new Date(t + LOOKAHEAD_MS)),
          ),
        );
      for (const row of due) {
        if (t - row.at.getTime() > MISSED_MS) {
          await finish(scope, row, 'pending', 'failed', { reason: 'missed' });
        } else {
          arm(scope, row);
        }
      }
      const stale = await db
        .select()
        .from(liveHandover)
        .where(
          and(
            whereStation(liveHandover, scope),
            eq(liveHandover.status, 'running'),
            or(isNull(liveHandover.claimedAt), lt(liveHandover.claimedAt, new Date(t - MISSED_MS))),
          ),
        );
      for (const row of stale) {
        await finish(scope, row, 'running', 'failed', { reason: 'interrupted' });
      }
    },

    run,

    close() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
