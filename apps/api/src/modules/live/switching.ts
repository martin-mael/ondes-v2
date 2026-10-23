import { randomUUID } from 'node:crypto';
import {
  type Db,
  type Executor,
  liveSession,
  type StationScope,
  station,
  streamer,
  streamerShow,
  unsafeScope,
  withAudit,
  writeAudit,
} from '@ondes/db';
import type {
  Actor,
  EngineState,
  LiveSession,
  LiveSessionEndReason,
  LiveSessionTrigger,
  LiveStatus,
  RealtimeEvent,
} from '@ondes/shared';
import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';
import { getOccurrences } from '../shows/repo.ts';
import { statusOf } from './repo.ts';

// Live switching (#64, ADR 0027). The station engine has a pool of harbor inputs; this decides
// which DJ is on air and keeps a `live_session` row per stretch of air a DJ holds:
// - `goLive`: opens the gate on an input (a handover if another DJ is on air), with a new
//   session id the engine reports on the live as-run entries;
// - `returnToAutomation`: closes the gate; the engine plays the return file and resumes the
//   log at the current time (its side, ADR 0027);
// - engine events: a DJ who connects during a live slot of one of their shows goes on air at
//   once (`trigger: slot`); the DJ on air hanging up or an engine restart closes the session;
// - `sweep` (every few seconds, on each replica): the same takeover for a DJ who connected
//   before their slot, and closing a session the engine no longer has (a missed event).
//
// Every api replica receives the engine events and runs the sweep. The partial unique index on
// open sessions arbitrates: one replica opens the session, the others hit the index and back
// off. Closing is idempotent (`where ended_at is null`).

/** The part of the engine adapter this needs (`app.engineLifecycle.adapterFor`). */
export type LiveSwitchEngine = {
  state(): Promise<EngineState>;
  setLive(enabled: boolean, options?: { input?: number; sessionId?: string }): Promise<void>;
  disconnectLive(input: number): Promise<boolean>;
};
export type LiveSwitchEngineLookup = (stationId: string) => Promise<LiveSwitchEngine | undefined>;

type Logger = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

export type LiveSwitcherOptions = {
  db: Db;
  engineFor?: LiveSwitchEngineLookup;
  /** The RabbitMQ events fanout (`live.session.*`). */
  publish?: (event: RealtimeEvent) => unknown;
  logger: Logger;
  now?: () => Date;
  /**
   * Called by the sweep for a streamer connected on an input who may no longer be (disabled,
   * expired or deleted since they connected): the revoker, which also retries a revocation
   * whose hang-up failed.
   */
  onNotAllowed?: (
    scope: StationScope,
    streamerId: string,
    reason: 'disabled' | 'expired' | 'deleted',
  ) => Promise<unknown>;
};

/** A session younger than this is left alone by the sweep: its engine call may be on the way. */
const SWEEP_GRACE_MS = 10_000;

type Ctx = { actor: Actor; scope: StationScope };
type SessionRow = typeof liveSession.$inferSelect;

export type LiveSwitcher = {
  status(scope: StationScope, liveEnabled: boolean): Promise<LiveStatus>;
  /** Puts the DJ connected on `input` on air. 409 if nobody may go on air there. */
  goLive(ctx: Ctx, input: number, trigger?: LiveSessionTrigger): Promise<LiveSession>;
  /** Hands the air back to automation. The closed session, if one was open. */
  returnToAutomation(ctx: Ctx, reason?: LiveSessionEndReason): Promise<LiveSession | null>;
  /** Hangs up the DJ on `input` (a kick). False if nobody was connected there. */
  disconnect(ctx: Ctx, input: number): Promise<boolean>;
  /** Closes the open session if `streamerId` holds it (revocation). */
  endSessionOf(ctx: Ctx, streamerId: string, reason: LiveSessionEndReason): Promise<boolean>;
  /** A real-time event from the fanout. Never throws. */
  onEvent(event: RealtimeEvent): Promise<void>;
  /** Takeover for DJs waiting in their slot, and clean-up of stale sessions, for one station. */
  sweep(scope: StationScope): Promise<void>;
};

const SYSTEM: Actor = { type: 'system', name: 'live' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres unique violation (the open-session index): another replica opened one. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: unknown } | undefined;
  if (e?.code === '23505') return true;
  return e?.cause ? isUniqueViolation(e.cause) : false;
}

/** A streamer id the engine reported, if it is a uuid (anything else is not ours). */
function streamerIdOf(value: string | null | undefined): string | null {
  return value && UUID.test(value) ? value : null;
}

export async function openLiveSession(
  db: Executor,
  stationId: string,
): Promise<SessionRow | undefined> {
  const [row] = await db
    .select()
    .from(liveSession)
    .where(and(eq(liveSession.stationId, stationId), isNull(liveSession.endedAt)));
  return row;
}

async function streamerNames(db: Executor, stationId: string, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return new Map<string, string>();
  const rows = await db
    .select({ id: streamer.id, displayName: streamer.displayName })
    .from(streamer)
    .where(and(eq(streamer.stationId, stationId), inArray(streamer.id, wanted)));
  return new Map(rows.map((r) => [r.id, r.displayName]));
}

function toSession(row: SessionRow, names: Map<string, string>): LiveSession {
  const name = row.streamerId ? names.get(row.streamerId) : undefined;
  return {
    id: row.id,
    streamer: row.streamerId && name ? { id: row.streamerId, displayName: name } : null,
    input: row.input,
    trigger: row.trigger,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    endReason: row.endReason,
  };
}

export function createLiveSwitcher(options: LiveSwitcherOptions): LiveSwitcher {
  const { db, engineFor, logger } = options;
  const now = () => options.now?.() ?? new Date();

  async function engineOf(stationId: string): Promise<LiveSwitchEngine> {
    const engine = engineFor ? await engineFor(stationId) : undefined;
    if (!engine) {
      throw new HttpError(409, 'engine_unavailable', 'the station engine is not running');
    }
    return engine;
  }

  async function publish(scope: StationScope, event: RealtimeEvent) {
    if (!options.publish) return;
    try {
      await options.publish(event);
    } catch (err) {
      logger.warn({ err, stationId: scope.stationId }, 'Publishing a live session event failed');
    }
  }

  const envelope = (scope: StationScope) => ({
    id: randomUUID(),
    stationId: scope.stationId,
    at: now().toISOString(),
  });

  async function publishEnded(scope: StationScope, row: SessionRow) {
    if (!row.endReason) return;
    await publish(scope, {
      ...envelope(scope),
      type: 'live.session.ended',
      data: {
        sessionId: row.id,
        streamerId: row.streamerId,
        input: row.input,
        reason: row.endReason,
      },
    });
  }

  /** Closes the open session if `match` accepts it. The closed row, or undefined. */
  async function closeOpen(
    ctx: Ctx,
    reason: LiveSessionEndReason,
    match: (row: SessionRow) => boolean = () => true,
  ): Promise<SessionRow | undefined> {
    const open = await openLiveSession(db, ctx.scope.stationId);
    if (!open || !match(open)) return undefined;
    const closed = await withAudit(db, ctx, async (tx, audit) => {
      const [row] = await tx
        .update(liveSession)
        .set({ endedAt: now(), endReason: reason })
        .where(and(eq(liveSession.id, open.id), isNull(liveSession.endedAt)))
        .returning();
      if (row) {
        await audit({
          action: 'live.session.end',
          entity: { type: 'live_session', id: row.id },
          diff: { endReason: { from: null, to: reason } },
        });
      }
      return row;
    });
    if (closed) await publishEnded(ctx.scope, closed);
    return closed;
  }

  /** The live slot of one of the streamer's shows running at `at`: its start, or null. */
  async function liveSlotStart(scope: StationScope, streamerId: string, at: Date) {
    const allowed = await db
      .select({ showId: streamerShow.showId })
      .from(streamerShow)
      .where(
        and(eq(streamerShow.streamerId, streamerId), eq(streamerShow.stationId, scope.stationId)),
      );
    if (!allowed.length) return null;
    const showIds = new Set(allowed.map((a) => a.showId));
    const { occurrences } = await getOccurrences(db, scope, {
      from: at,
      to: new Date(at.getTime() + 1000),
    });
    const slot = occurrences.find(
      (o) =>
        o.type === 'live' &&
        showIds.has(o.show.id) &&
        o.startsAt.getTime() <= at.getTime() &&
        o.endsAt.getTime() > at.getTime(),
    );
    return slot?.startsAt ?? null;
  }

  /**
   * Someone handed the air back to automation during this slot (a manual return, or a gate
   * closed by hand) and the DJ hasn't connected again since: the automatic takeover must not
   * undo it. A new login (`last_connected_at`) lifts it; so does the next slot.
   */
  async function returnedDuringSlot(scope: StationScope, streamerId: string, slotStart: Date) {
    const [row] = await db
      .select({ id: liveSession.id })
      .from(liveSession)
      .innerJoin(streamer, eq(streamer.id, liveSession.streamerId))
      .where(
        and(
          eq(liveSession.stationId, scope.stationId),
          eq(liveSession.streamerId, streamerId),
          eq(liveSession.endReason, 'returned'),
          gte(liveSession.endedAt, slotStart),
          or(
            isNull(streamer.lastConnectedAt),
            sql`${streamer.lastConnectedAt} <= ${liveSession.endedAt}`,
          ),
        ),
      )
      .limit(1);
    return !!row;
  }

  async function scopeOf(stationId: string): Promise<StationScope | undefined> {
    const [row] = await db
      .select({ orgId: station.orgId })
      .from(station)
      .where(eq(station.id, stationId));
    // Ids read from the station row: the event came from the station's own engine.
    return row ? unsafeScope(row.orgId, stationId) : undefined;
  }

  const goLive: LiveSwitcher['goLive'] = async (ctx, input, trigger = 'manual') => {
    const engine = await engineOf(ctx.scope.stationId);
    const state = await engine.state();
    const slot = state.live.inputs?.find((i) => i.input === input);
    if (!slot) throw new HttpError(400, 'live_input_unknown', `the engine has no input ${input}`);
    if (!slot.connected) {
      throw new HttpError(409, 'live_input_not_connected', `nobody is connected on input ${input}`);
    }
    const streamerId = streamerIdOf(slot.streamer_id);
    if (streamerId) {
      // The auth callback checked the streamer when it connected; it may have been disabled
      // or expired since (ADR 0023: check the holder before opening the gate).
      const [row] = await db
        .select()
        .from(streamer)
        .where(and(eq(streamer.id, streamerId), eq(streamer.stationId, ctx.scope.stationId)));
      if (!row || statusOf(row, now()) !== 'active') {
        throw new HttpError(409, 'streamer_not_allowed', 'this streamer may not go on air');
      }
    }

    const open = await openLiveSession(db, ctx.scope.stationId);
    // The same DJ on the same input, already through the gate: nothing to do. Another DJ on
    // that input (a missed disconnect) gets a session of their own.
    if (
      open &&
      open.input === input &&
      open.streamerId === streamerId &&
      state.live.enabled &&
      state.live.selected === input &&
      state.live.session_id === open.id
    ) {
      return toSession(open, await streamerNames(db, ctx.scope.stationId, [open.streamerId]));
    }

    let previous: SessionRow | undefined;
    let created: SessionRow;
    try {
      created = await withAudit(db, ctx, async (tx, audit) => {
        if (open) {
          [previous] = await tx
            .update(liveSession)
            .set({ endedAt: now(), endReason: 'handover' })
            .where(and(eq(liveSession.id, open.id), isNull(liveSession.endedAt)))
            .returning();
          if (previous) {
            await audit({
              action: 'live.session.end',
              entity: { type: 'live_session', id: previous.id },
              diff: { endReason: { from: null, to: 'handover' } },
            });
          }
        }
        const [row] = await tx
          .insert(liveSession)
          .values({
            orgId: ctx.scope.orgId,
            stationId: ctx.scope.stationId,
            streamerId,
            input,
            trigger,
            startedAt: now(),
          })
          .returning();
        if (!row) throw new Error('live session insert returned nothing');
        await audit({
          action: 'live.session.start',
          entity: { type: 'live_session', id: row.id },
          diff: {
            input: { from: open?.input ?? null, to: input },
            streamerId: { from: open?.streamerId ?? null, to: streamerId },
            trigger: { from: null, to: trigger },
          },
        });
        return row;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new HttpError(409, 'live_session_conflict', 'another live session was just opened');
      }
      throw err;
    }
    // After the commit: the engine is never told about a session that a rollback would undo.
    // If it refuses, the session is taken back (and the previous one reopened).
    try {
      await engine.setLive(true, { input, sessionId: created.id });
    } catch (err) {
      await withAudit(db, ctx, async (tx, audit) => {
        await tx.delete(liveSession).where(eq(liveSession.id, created.id));
        if (previous) {
          await tx
            .update(liveSession)
            .set({ endedAt: null, endReason: null })
            .where(eq(liveSession.id, previous.id));
        }
        await audit({
          action: 'live.session.start_failed',
          entity: { type: 'live_session', id: created.id },
          diff: { reason: { from: null, to: err instanceof Error ? err.message : String(err) } },
        });
      });
      throw err;
    }
    if (previous) await publishEnded(ctx.scope, previous);
    await publish(ctx.scope, {
      ...envelope(ctx.scope),
      type: 'live.session.started',
      data: { sessionId: created.id, streamerId, input, trigger },
    });
    logger.info({ stationId: ctx.scope.stationId, input, streamerId, trigger }, 'Live on air');
    return toSession(created, await streamerNames(db, ctx.scope.stationId, [streamerId]));
  };

  /** Hands connected streamers who may no longer be on to the revoker (`onNotAllowed`). */
  async function revokeNotAllowed(scope: StationScope, state: EngineState) {
    if (!options.onNotAllowed) return;
    const ids = [
      ...new Set(
        (state.live.inputs ?? [])
          .filter((i) => i.connected)
          .map((i) => streamerIdOf(i.streamer_id))
          .filter((id): id is string => !!id),
      ),
    ];
    if (!ids.length) return;
    const rows = await db
      .select()
      .from(streamer)
      .where(and(eq(streamer.stationId, scope.stationId), inArray(streamer.id, ids)));
    for (const id of ids) {
      const row = rows.find((r) => r.id === id);
      const status = row ? statusOf(row, now()) : 'deleted';
      if (status !== 'active') await options.onNotAllowed(scope, id, status);
    }
  }

  async function takeOverIfInSlot(scope: StationScope, state: EngineState) {
    if (state.live.enabled || (await openLiveSession(db, scope.stationId))) return;
    const at = now();
    for (const slot of state.live.inputs ?? []) {
      const streamerId = streamerIdOf(slot.streamer_id);
      if (!slot.connected || !streamerId) continue;
      const slotStart = await liveSlotStart(scope, streamerId, at);
      if (!slotStart || (await returnedDuringSlot(scope, streamerId, slotStart))) continue;
      try {
        await goLive({ actor: SYSTEM, scope }, slot.input, 'slot');
      } catch (err) {
        // Another replica won the race, or the streamer was disabled meanwhile.
        if (!(err instanceof HttpError)) throw err;
      }
      return;
    }
  }

  return {
    async status(scope, liveEnabled) {
      const open = await openLiveSession(db, scope.stationId);
      let state: EngineState | undefined;
      try {
        state = engineFor ? await (await engineFor(scope.stationId))?.state() : undefined;
      } catch {
        state = undefined;
      }
      const pool = state?.live.inputs ?? [];
      const names = await streamerNames(db, scope.stationId, [
        open?.streamerId ?? null,
        ...pool.map((i) => streamerIdOf(i.streamer_id)),
      ]);
      return {
        enabled: liveEnabled,
        reachable: !!state,
        onAir: state?.live.on_air ?? null,
        session: open ? toSession(open, names) : null,
        inputs: pool.map((i) => {
          const id = streamerIdOf(i.streamer_id);
          const name = id ? names.get(id) : undefined;
          return {
            input: i.input,
            mount: i.mount,
            connected: i.connected,
            ready: i.ready,
            streamer: id && name ? { id, displayName: name } : null,
          };
        }),
      };
    },

    goLive,

    async returnToAutomation(ctx, reason = 'returned') {
      const engine = await engineOf(ctx.scope.stationId);
      await engine.setLive(false);
      const closed = await closeOpen(ctx, reason);
      if (!closed) {
        await writeAudit(db, ctx, {
          action: 'live.gate.close',
          entity: { type: 'station', id: ctx.scope.stationId },
          diff: {},
        });
        return null;
      }
      return toSession(closed, await streamerNames(db, ctx.scope.stationId, [closed.streamerId]));
    },

    async disconnect(ctx, input) {
      const engine = await engineOf(ctx.scope.stationId);
      const open = await openLiveSession(db, ctx.scope.stationId);
      const onAir = open?.input === input;
      if (onAir) await engine.setLive(false);
      const disconnected = await engine.disconnectLive(input);
      await writeAudit(db, ctx, {
        action: 'live.input.disconnect',
        entity: { type: 'station', id: ctx.scope.stationId },
        diff: { input: { from: input, to: null } },
      });
      if (onAir) await closeOpen(ctx, 'disconnected', (row) => row.input === input);
      return disconnected;
    },

    async endSessionOf(ctx, streamerId, reason) {
      return !!(await closeOpen(ctx, reason, (row) => row.streamerId === streamerId));
    },

    async onEvent(event) {
      try {
        if (
          event.type !== 'engine.live.connected' &&
          event.type !== 'engine.live.disconnected' &&
          event.type !== 'engine.booted'
        ) {
          return;
        }
        const scope = await scopeOf(event.stationId);
        if (!scope) return;
        const ctx = { actor: SYSTEM, scope };
        if (event.type === 'engine.booted') {
          // A new boot has a closed gate and no DJ: the session can't have survived.
          await closeOpen(ctx, 'engine_restarted');
          return;
        }
        if (event.type === 'engine.live.disconnected') {
          const input = event.data.input;
          const closed = await closeOpen(
            ctx,
            'disconnected',
            (row) => !input || row.input === input,
          );
          // The engine is already back on automation. Close the gate too, so a DJ connecting
          // to that input later doesn't take the air by themselves.
          if (closed) await (await engineOf(scope.stationId)).setLive(false);
          return;
        }
        const engine = engineFor ? await engineFor(scope.stationId) : undefined;
        if (engine) await takeOverIfInSlot(scope, await engine.state());
      } catch (err) {
        logger.error(
          { err, stationId: event.stationId, type: event.type },
          'Live switching failed',
        );
      }
    },

    async sweep(scope) {
      const engine = engineFor ? await engineFor(scope.stationId) : undefined;
      if (!engine) return;
      let state: EngineState;
      try {
        state = await engine.state();
      } catch {
        return; // unreachable: nothing known, nothing to do
      }
      await revokeNotAllowed(scope, state);
      const open = await openLiveSession(db, scope.stationId);
      if (!open) {
        await takeOverIfInSlot(scope, state);
        return;
      }
      if (now().getTime() - open.startedAt.getTime() < SWEEP_GRACE_MS) return;
      const slot = state.live.inputs?.find((i) => i.input === open.input);
      // Someone else on the session's input: its DJ left and another connected (missed events).
      const otherDj = !!slot?.connected && streamerIdOf(slot.streamer_id) !== open.streamerId;
      // The engine lost the session: a missed disconnect or boot event, a gate closed by hand.
      const lost =
        otherDj || !state.live.enabled || !slot?.connected || state.live.session_id !== open.id;
      if (!lost) return;
      const closed = await closeOpen(
        { actor: SYSTEM, scope },
        slot?.connected && !otherDj ? 'returned' : 'disconnected',
        (row) => row.id === open.id,
      );
      // Still letting that input through: close the gate (the other DJ isn't the session's).
      if (closed && state.live.enabled && state.live.selected === open.input) {
        await engine.setLive(false);
      }
    },
  };
}
