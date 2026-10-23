import { randomUUID } from 'node:crypto';
import {
  type Db,
  type Executor,
  liveSession,
  type StationScope,
  station,
  streamer,
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
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';
import { type LiveEpisode, startLiveEpisode, undoLiveEpisode } from '../shows/live-slots.ts';
import { statusOf } from './repo.ts';
import * as requests from './requests.ts';
import { type LiveBinding, returnedSince, type Standing, standingOf } from './standing.ts';

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
// Live slots, ad-hoc live and events (#65, ADR 0033) extend the takeover (`arbitrate`): what a
// connected DJ may do comes from `standing.ts` (their live slot, an event, early connect, or
// ad-hoc). A session opened for a slot or an event is bound to it (show, occurrence, episode,
// or the event's title); a slot's episode is created and numbered when its DJ goes on air. A
// DJ who needs approval outside their slots raises a request a manager answers (`approve`).
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
  /** A DJ went on air in a live slot occurrence (#65): the missed-slot alert resolves. */
  onSlotLive?: (scope: StationScope, occurrence: { slotId: string; date: string }) => unknown;
};

/** A session younger than this is left alone by the sweep: its engine call may be on the way. */
const SWEEP_GRACE_MS = 10_000;

type Ctx = { actor: Actor; scope: StationScope };
type SessionRow = typeof liveSession.$inferSelect;

export type LiveSwitcher = {
  status(scope: StationScope, liveEnabled: boolean): Promise<LiveStatus>;
  /**
   * Puts the DJ connected on `input` on air. 409 if nobody may go on air there. Without a
   * `binding`, the session is bound to the DJ's running slot or event, if they have one.
   */
  goLive(
    ctx: Ctx,
    input: number,
    trigger?: LiveSessionTrigger,
    binding?: LiveBinding | null,
  ): Promise<LiveSession>;
  /** Approves an ad-hoc request: its DJ goes on air (a handover if another DJ is on). */
  approve(ctx: Ctx, requestId: string): Promise<LiveSession>;
  /** Refuses an ad-hoc request: the DJ stays connected, off air, until they log in again. */
  refuse(ctx: Ctx, requestId: string): Promise<void>;
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
    show: row.showId && row.title !== null ? { id: row.showId, name: row.title } : null,
    episode:
      row.episodeId && row.episodeNumber !== null
        ? { id: row.episodeId, number: row.episodeNumber }
        : null,
    title: row.title,
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

  async function scopeOf(stationId: string): Promise<StationScope | undefined> {
    const [row] = await db
      .select({ orgId: station.orgId })
      .from(station)
      .where(eq(station.id, stationId));
    // Ids read from the station row: the event came from the station's own engine.
    return row ? unsafeScope(row.orgId, stationId) : undefined;
  }

  const goLive: LiveSwitcher['goLive'] = async (ctx, input, trigger = 'manual', bound) => {
    const engine = await engineOf(ctx.scope.stationId);
    const state = await engine.state();
    const slot = state.live.inputs?.find((i) => i.input === input);
    if (!slot) throw new HttpError(400, 'live_input_unknown', `the engine has no input ${input}`);
    if (!slot.connected) {
      throw new HttpError(409, 'live_input_not_connected', `nobody is connected on input ${input}`);
    }
    const streamerId = streamerIdOf(slot.streamer_id);
    let streamerName: string | null = null;
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
      streamerName = row.displayName;
    }
    // Put on air by hand during their slot or event: the session is still that slot's.
    let binding = bound ?? null;
    if (bound === undefined && streamerId) {
      const standing = await standingOf(db, ctx.scope, streamerId, now());
      if (standing.kind === 'slot' || standing.kind === 'event') binding = standing.binding;
    }
    const occurrence = binding?.kind === 'slot' ? binding.occurrence : null;
    const event = binding?.kind === 'event' ? binding.event : null;

    const open = await openLiveSession(db, ctx.scope.stationId);
    // The same DJ on the same input, already through the gate: nothing to do. Another DJ on
    // that input (a missed disconnect) gets a session of their own.
    if (
      open &&
      open.input === input &&
      open.streamerId === streamerId &&
      (open.slotId ?? null) === (occurrence?.slotId ?? null) &&
      (open.eventId ?? null) === (event?.id ?? null) &&
      state.live.enabled &&
      state.live.selected === input &&
      state.live.session_id === open.id
    ) {
      return toSession(open, await streamerNames(db, ctx.scope.stationId, [open.streamerId]));
    }

    let previous: SessionRow | undefined;
    let created: SessionRow;
    let episode: LiveEpisode | null = null;
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
        // A live slot's episode: the planned one, or a new one numbered now (#65).
        if (occurrence) {
          episode = await startLiveEpisode(tx, ctx.scope, audit, occurrence, now());
        }
        const [row] = await tx
          .insert(liveSession)
          .values({
            orgId: ctx.scope.orgId,
            stationId: ctx.scope.stationId,
            streamerId,
            streamerName,
            input,
            trigger,
            startedAt: now(),
            showId: occurrence?.showId ?? null,
            slotId: occurrence?.slotId ?? null,
            occurrenceDate: occurrence?.date ?? null,
            episodeId: episode?.id ?? null,
            episodeNumber: episode?.number ?? null,
            eventId: event?.id ?? null,
            title: occurrence?.showName ?? event?.title ?? null,
            scheduledEndAt: occurrence?.endsAt ?? event?.endsAt ?? null,
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
            ...(occurrence
              ? {
                  slot: { from: null, to: `${occurrence.slotId}/${occurrence.date}` },
                  episodeId: { from: null, to: episode?.id ?? null },
                }
              : {}),
            ...(event ? { eventId: { from: null, to: event.id } } : {}),
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
        if (episode) await undoLiveEpisode(tx, ctx.scope, audit, episode);
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
    if (occurrence && options.onSlotLive) {
      try {
        await options.onSlotLive(ctx.scope, { slotId: occurrence.slotId, date: occurrence.date });
      } catch (err) {
        logger.warn({ err, stationId: ctx.scope.stationId }, 'Resolving a missed live slot failed');
      }
    }
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

  /** Puts a DJ on air for the sweep or an event; another replica winning the race is fine. */
  async function tryGoLive(
    scope: StationScope,
    input: number,
    trigger: LiveSessionTrigger,
    binding: LiveBinding | null,
  ) {
    try {
      await goLive({ actor: SYSTEM, scope }, input, trigger, binding);
      return true;
    } catch (err) {
      // Another replica won the race, or the streamer was disabled meanwhile.
      if (!(err instanceof HttpError)) throw err;
      return false;
    }
  }

  /**
   * Who should be on air (#64's instant takeover, extended by #65). For every connected DJ,
   * their standing (`standing.ts`):
   * - a running slot or event (or early connect `go_live`) takes the air, unless the DJ was
   *   handed back to automation by hand since it opened. It takes over from an ad-hoc session,
   *   or from a slot or event session whose own slot or event is over; never from a DJ a
   *   manager put on air by hand;
   * - ad-hoc `allowed`: on air when nobody is, unless handed back since their last login;
   * - ad-hoc `approval`: a request for the managers, once per connection.
   * Pending requests whose DJ left, went on air or has a slot now are cancelled.
   */
  async function arbitrate(scope: StationScope, state: EngineState) {
    const open = await openLiveSession(db, scope.stationId);
    // A gate opened by hand outside any session: nothing to decide.
    if (state.live.enabled && !open) return;
    const at = now();
    const connected = (state.live.inputs ?? []).flatMap((slot) => {
      const streamerId = streamerIdOf(slot.streamer_id);
      return slot.connected && streamerId ? [{ input: slot.input, streamerId }] : [];
    });
    const standings = new Map<number, Standing>();
    for (const c of connected) {
      standings.set(c.input, await standingOf(db, scope, c.streamerId, at));
    }
    const onAir = (c: { input: number; streamerId: string }) =>
      !!open && open.input === c.input && open.streamerId === c.streamerId;
    const preemptible =
      !open ||
      open.trigger === 'ad_hoc' ||
      ((open.trigger === 'slot' || open.trigger === 'event') &&
        !!open.scheduledEndAt &&
        open.scheduledEndAt.getTime() <= at.getTime());

    let tookOver = false;
    if (preemptible) {
      for (const c of connected) {
        const standing = standings.get(c.input);
        if (standing?.kind !== 'slot' && standing?.kind !== 'event') continue;
        // Already on air (their own ad-hoc session runs on into their slot).
        if (onAir(c)) continue;
        if (await returnedSince(db, scope, c.streamerId, standing.since)) continue;
        tookOver = await tryGoLive(scope, c.input, standing.kind, standing.binding);
        if (tookOver) break;
      }
    }
    if (!tookOver && !open) {
      for (const c of connected) {
        const standing = standings.get(c.input);
        if (standing?.kind !== 'ad_hoc' || standing.policy !== 'allowed') continue;
        if (await returnedSince(db, scope, c.streamerId, new Date(0))) continue;
        if (await tryGoLive(scope, c.input, 'ad_hoc', null)) break;
      }
    }
    await syncRequests(scope, connected, standings);
  }

  /** Raises a request per connection of an `approval` DJ off air; cancels the stale ones. */
  async function syncRequests(
    scope: StationScope,
    connected: { input: number; streamerId: string }[],
    standings: Map<number, Standing>,
  ) {
    const open = await openLiveSession(db, scope.stationId);
    const waiting = connected.filter((c) => {
      const standing = standings.get(c.input);
      return (
        standing?.kind === 'ad_hoc' &&
        standing.policy === 'approval' &&
        !(open?.input === c.input && open.streamerId === c.streamerId)
      );
    });
    const logins = waiting.length
      ? await db
          .select({ id: streamer.id, lastConnectedAt: streamer.lastConnectedAt })
          .from(streamer)
          .where(
            and(
              eq(streamer.stationId, scope.stationId),
              inArray(
                streamer.id,
                waiting.map((w) => w.streamerId),
              ),
            ),
          )
      : [];
    const wanted = new Set<string>();
    for (const w of waiting) {
      const connectedAt = logins.find((l) => l.id === w.streamerId)?.lastConnectedAt;
      if (!connectedAt) continue;
      const raised = await requests.raise(db, scope, { ...w, connectedAt }, SYSTEM);
      if (!raised) continue;
      wanted.add(raised.request.id);
      if (raised.created) {
        await publish(scope, {
          ...envelope(scope),
          type: 'live.request.created',
          data: {
            requestId: raised.request.id,
            streamerId: w.streamerId,
            displayName: raised.request.streamer.displayName,
            input: w.input,
          },
        });
      }
    }
    for (const row of await requests.pendingRows(db, scope)) {
      if (wanted.has(row.id)) continue;
      // Gone, on air another way, or their slot started: nothing left to approve.
      if (await requests.decide(db, { actor: SYSTEM, scope }, row.id, 'cancelled', now())) {
        await publishDecided(scope, row.id, 'cancelled');
      }
    }
  }

  async function publishDecided(
    scope: StationScope,
    requestId: string,
    status: 'approved' | 'refused' | 'cancelled',
  ) {
    await publish(scope, {
      ...envelope(scope),
      type: 'live.request.decided',
      data: { requestId, status },
    });
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

    async approve(ctx, requestId) {
      const request = await requests.getRequest(db, ctx.scope, requestId);
      if (request.status !== 'pending') {
        throw new HttpError(409, 'live_request_decided', `the request was ${request.status}`);
      }
      const engine = await engineOf(ctx.scope.stationId);
      const slot = (await engine.state()).live.inputs?.find((i) => i.input === request.input);
      // Still the same connection: the DJ didn't hang up (and nobody else took their input).
      if (!slot?.connected || streamerIdOf(slot.streamer_id) !== request.streamer.id) {
        if (await requests.decide(db, ctx, requestId, 'cancelled', now())) {
          await publishDecided(ctx.scope, requestId, 'cancelled');
        }
        throw new HttpError(409, 'live_input_not_connected', 'the DJ is no longer connected');
      }
      // Decided first, so a second manager's click gets a 409 rather than a second handover.
      if (!(await requests.decide(db, ctx, requestId, 'approved', now()))) {
        throw new HttpError(409, 'live_request_decided', 'the request was already decided');
      }
      await publishDecided(ctx.scope, requestId, 'approved');
      return goLive(ctx, request.input, 'ad_hoc');
    },

    async refuse(ctx, requestId) {
      if (!(await requests.decide(db, ctx, requestId, 'refused', now()))) {
        await requests.getRequest(db, ctx.scope, requestId); // 404 when it isn't ours
        throw new HttpError(409, 'live_request_decided', 'the request was already decided');
      }
      await publishDecided(ctx.scope, requestId, 'refused');
    },

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
        if (engine) await arbitrate(scope, await engine.state());
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
        await arbitrate(scope, state);
        return;
      }
      if (now().getTime() - open.startedAt.getTime() < SWEEP_GRACE_MS) return;
      const slot = state.live.inputs?.find((i) => i.input === open.input);
      // Someone else on the session's input: its DJ left and another connected (missed events).
      const otherDj = !!slot?.connected && streamerIdOf(slot.streamer_id) !== open.streamerId;
      // The engine lost the session: a missed disconnect or boot event, a gate closed by hand.
      const lost =
        otherDj || !state.live.enabled || !slot?.connected || state.live.session_id !== open.id;
      if (!lost) {
        // A slot or event DJ may take over (an ad-hoc session, or a slot that's over), and
        // the ad-hoc requests stay in step (#65).
        await arbitrate(scope, state);
        return;
      }
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
