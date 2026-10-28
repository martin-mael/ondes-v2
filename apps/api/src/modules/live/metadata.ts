import { randomUUID } from 'node:crypto';
import {
  type Db,
  type Executor,
  liveNowPlaying,
  liveSession,
  type StationScope,
  station,
  streamer,
  unsafeScope,
  whereStation,
  writeAudit,
} from '@ondes/db';
import type {
  Actor,
  EngineLiveMetadata,
  EngineState,
  LiveNowPlaying,
  LiveNowPlayingSource,
  RealtimeEvent,
  SetLiveNowPlaying,
} from '@ondes/shared';
import { setLiveNowPlayingSchema } from '@ondes/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';

// Live metadata (#68, ADR 0040): the now-playing the streams show while a DJ is on air, one per
// live session (`live_now_playing`), in this order:
// 1. `manual`: typed on the dashboard (a concert: the artist on stage), until cleared;
// 2. `encoder`: the last metadata the DJ's software sent, when their streamer allows it
//    (`streamer.encoder_metadata`);
// 3. `default`: the session's show or event and episode as title, the DJ as artist.
//
// Node decides and sends the result to the engine (`POST /v1/live/metadata`), which puts it on
// the streams. The engine reports what the encoder sends (`engine.live.metadata`) and lets it
// through by itself when `encoder` is on, so the DJ's track changes reach listeners without a
// round trip. Every change is published as `live.metadata.changed` and read by the on-air
// snapshot and the public now-playing API (#74) through `getLiveNowPlaying`.
//
// Every replica receives the events and runs the sweep: the row update only matches when the
// now-playing actually changes, so one replica publishes and pushes. The sweep also re-sends
// it when the engine holds something else (a lost push, a streamer setting changed, a
// session bound to its slot in place), and fills in a new session's default.

type Logger = {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

/** The part of the engine adapter this needs. */
export type LiveMetadataEngine = {
  state(): Promise<EngineState>;
  setLiveMetadata?(metadata: EngineLiveMetadata): Promise<boolean>;
};

export type LiveMetadataOptions = {
  db: Db;
  engineFor?: (stationId: string) => Promise<LiveMetadataEngine | undefined>;
  publish?: (event: RealtimeEvent) => unknown;
  logger: Logger;
  now?: () => Date;
};

type Ctx = { actor: Actor; scope: StationScope };
type SessionRow = typeof liveSession.$inferSelect;
type Text = { title: string | null; artist: string | null };

export type LiveMetadata = {
  /** Sets the manual now-playing of the session on air. 409 when nobody is on air. */
  setManual(ctx: Ctx, body: SetLiveNowPlaying): Promise<LiveNowPlaying>;
  /** Back to the encoder's (if allowed) or the default. 409 when nobody is on air. */
  clearManual(ctx: Ctx): Promise<LiveNowPlaying>;
  /**
   * Re-derives the now-playing of the session on air and sends it to the engine at once, even
   * if its text is the same (a streamer's setting changed: the encoder may pass or not).
   */
  refresh(scope: StationScope): Promise<void>;
  /** A real-time event from the fanout, applied in order per station. Never throws. */
  onEvent(event: RealtimeEvent): Promise<void>;
  /** The stations with a live session open: the only ones `sweep` has anything to do for. */
  liveStationIds(): Promise<Set<string>>;
  /** Fills in a new session's now-playing and keeps the engine's in step, for one station. */
  sweep(scope: StationScope): Promise<void>;
};

/**
 * The default now-playing of a session: the show (or event) and its episode as title, the DJ
 * as artist. A session with neither (the shared password, unbound) shows the station's name.
 */
export function defaultNowPlaying(
  session: { title: string | null; episodeNumber: number | null; streamerName: string | null },
  stationName: string,
): Text {
  const title = session.title
    ? session.episodeNumber !== null
      ? `${session.title} #${session.episodeNumber}`
      : session.title
    : null;
  const artist = session.streamerName;
  if (!title && !artist) return { title: stationName, artist: null };
  return { title, artist };
}

type Loaded = {
  session: SessionRow;
  row: typeof liveNowPlaying.$inferSelect | undefined;
  encoderAllowed: boolean;
  stationName: string;
};

async function load(db: Executor, scope: StationScope): Promise<Loaded | undefined> {
  const [found] = await db
    .select({
      session: liveSession,
      row: liveNowPlaying,
      encoderAllowed: streamer.encoderMetadata,
      stationName: station.name,
    })
    .from(liveSession)
    .innerJoin(station, eq(station.id, liveSession.stationId))
    .leftJoin(liveNowPlaying, eq(liveNowPlaying.sessionId, liveSession.id))
    .leftJoin(
      streamer,
      and(eq(streamer.id, liveSession.streamerId), eq(streamer.stationId, liveSession.stationId)),
    )
    .where(
      and(
        whereStation(liveSession, scope),
        eq(liveSession.orgId, scope.orgId),
        isNull(liveSession.endedAt),
      ),
    );
  if (!found) return undefined;
  return {
    session: found.session,
    row: found.row ?? undefined,
    encoderAllowed: found.encoderAllowed ?? false,
    stationName: found.stationName,
  };
}

/** What the streams should show for `l`, in the order above. */
function effective(l: Loaded): Text & { source: LiveNowPlayingSource } {
  const { row } = l;
  if (row?.source === 'manual') return { title: row.title, artist: row.artist, source: 'manual' };
  if (l.encoderAllowed && row?.encoderAt) {
    return { title: row.encoderTitle, artist: row.encoderArtist, source: 'encoder' };
  }
  return { ...defaultNowPlaying(l.session, l.stationName), source: 'default' };
}

function toDto(l: Loaded, text: Text & { source: LiveNowPlayingSource }, updatedAt: Date) {
  return {
    sessionId: l.session.id,
    input: l.session.input,
    title: text.title,
    artist: text.artist,
    source: text.source,
    encoderAllowed: l.encoderAllowed,
    updatedAt: updatedAt.toISOString(),
  } satisfies LiveNowPlaying;
}

/** What the engine gets for it: the encoder passes through unless a manager typed something. */
function engineCommand(l: Loaded, text: Text & { source: LiveNowPlayingSource }) {
  return {
    title: text.title,
    artist: text.artist,
    encoder: l.encoderAllowed && text.source !== 'manual',
  } satisfies EngineLiveMetadata;
}

/**
 * The now-playing of the live session on air, null when nobody is (#74's public API and the
 * on-air snapshot read this). Before its row exists, the session's default.
 */
export async function getLiveNowPlaying(
  db: Executor,
  scope: StationScope,
): Promise<LiveNowPlaying | null> {
  const l = await load(db, scope);
  if (!l) return null;
  const text = effective(l);
  return toDto(l, text, l.row?.updatedAt ?? l.session.startedAt);
}

export function createLiveMetadata(options: LiveMetadataOptions): LiveMetadata {
  const { db, logger } = options;
  const now = () => options.now?.() ?? new Date();

  async function publish(l: Loaded, dto: LiveNowPlaying) {
    if (!options.publish) return;
    try {
      await options.publish({
        id: randomUUID(),
        stationId: l.session.stationId,
        at: now().toISOString(),
        type: 'live.metadata.changed',
        data: dto,
      });
    } catch (err) {
      logger.warn({ err, stationId: l.session.stationId }, 'Publishing live metadata failed');
    }
  }

  async function push(l: Loaded, text: Text & { source: LiveNowPlayingSource }) {
    const engine = options.engineFor ? await options.engineFor(l.session.stationId) : undefined;
    if (!engine?.setLiveMetadata) return;
    try {
      await engine.setLiveMetadata(engineCommand(l, text));
    } catch (err) {
      // The sweep sends it again.
      logger.warn({ err, stationId: l.session.stationId }, 'Sending live metadata failed');
    }
  }

  /**
   * Stores what the streams should show for the session on air. Only the replica whose write
   * changed it gets the row back (and publishes and pushes); the others get nothing.
   */
  async function store(tx: Executor, l: Loaded) {
    const text = effective(l);
    const at = now();
    const [row] = await tx
      .insert(liveNowPlaying)
      .values({
        sessionId: l.session.id,
        orgId: l.session.orgId,
        stationId: l.session.stationId,
        title: text.title,
        artist: text.artist,
        source: text.source,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: liveNowPlaying.sessionId,
        set: { title: text.title, artist: text.artist, source: text.source, updatedAt: at },
        setWhere: sql`(${liveNowPlaying.title}, ${liveNowPlaying.artist}, ${liveNowPlaying.source})
          is distinct from (${text.title}, ${text.artist}, ${text.source})`,
      })
      .returning();
    return row ? { text, at } : undefined;
  }

  /**
   * Re-derives and stores; publishes and pushes if it changed. `force`: publishes and pushes
   * anyway (the replica that changed a streamer's setting: the engine's `encoder` may change
   * with the same text).
   */
  async function sync(
    scope: StationScope,
    { engineState, force = false }: { engineState?: EngineState; force?: boolean } = {},
  ) {
    const l = await load(db, scope);
    if (!l) return;
    const changed = await store(db, l);
    if (changed || force) {
      const text = changed?.text ?? effective(l);
      await publish(l, toDto(l, text, changed?.at ?? l.row?.updatedAt ?? now()));
      await push(l, text);
      return;
    }
    // Unchanged here: re-send it if the engine holds something else for this session.
    const np = engineState?.live.now_playing;
    if (!engineState || !np || engineState.live.session_id !== l.session.id) return;
    const want = engineCommand(l, effective(l));
    if (
      np.title !== (want.title ?? '') ||
      np.artist !== (want.artist ?? '') ||
      np.encoder !== want.encoder
    ) {
      await push(l, effective(l));
    }
  }

  async function onAir(tx: Executor, ctx: Ctx): Promise<Loaded> {
    const l = await load(tx, ctx.scope);
    if (!l) throw new HttpError(409, 'live_not_on_air', 'no DJ is on air');
    return l;
  }

  async function manual(ctx: Ctx, text: Text | null): Promise<LiveNowPlaying> {
    // Nothing to change (clearing with no manual text, or typing the one on air): no write, no
    // audit row, no push. Hence `writeAudit` in the transaction rather than `withAudit`, which
    // requires one.
    const result = await db.transaction(async (tx) => {
      const before = await onAir(tx, ctx);
      const previous = effective(before);
      if (
        text
          ? previous.source === 'manual' &&
            previous.title === text.title &&
            previous.artist === text.artist
          : previous.source !== 'manual'
      ) {
        const at = before.row?.updatedAt ?? before.session.startedAt;
        return { changed: false as const, dto: toDto(before, previous, at) };
      }
      const loaded: Loaded = {
        ...before,
        row: {
          ...(before.row ?? {
            sessionId: before.session.id,
            orgId: before.session.orgId,
            stationId: before.session.stationId,
            encoderTitle: null,
            encoderArtist: null,
            encoderAt: null,
            updatedAt: now(),
          }),
          title: text ? text.title : null,
          artist: text ? text.artist : null,
          source: text ? 'manual' : 'default',
        },
      };
      const next = effective(loaded);
      // A manual text is stored as is; clearing it stores what replaces it.
      await tx
        .insert(liveNowPlaying)
        .values({
          sessionId: before.session.id,
          orgId: before.session.orgId,
          stationId: before.session.stationId,
          title: next.title,
          artist: next.artist,
          source: next.source,
          updatedAt: now(),
        })
        .onConflictDoUpdate({
          target: liveNowPlaying.sessionId,
          set: { title: next.title, artist: next.artist, source: next.source, updatedAt: now() },
        });
      await writeAudit(tx, ctx, {
        action: text ? 'live.now_playing.set' : 'live.now_playing.clear',
        entity: { type: 'live_session', id: before.session.id },
        diff: {
          title: { from: previous.title, to: next.title },
          artist: { from: previous.artist, to: next.artist },
          source: { from: previous.source, to: next.source },
        },
      });
      return { changed: true as const, loaded, next };
    });
    if (!result.changed) return result.dto;
    const after = result;
    const dto = toDto(after.loaded, after.next, now());
    await publish(after.loaded, dto);
    await push(after.loaded, after.next);
    return dto;
  }

  /** The DJ's encoder sent metadata on the session on air: kept, and on air if allowed. */
  async function encoderSent(scope: StationScope, sessionId: string, sent: Text) {
    const l = await load(db, scope);
    if (!l || sessionId !== l.session.id) return;
    const at = now();
    const encoder = { encoderTitle: sent.title, encoderArtist: sent.artist, encoderAt: at };
    const first = effective(l);
    await db
      .insert(liveNowPlaying)
      .values({
        sessionId: l.session.id,
        orgId: l.session.orgId,
        stationId: l.session.stationId,
        title: first.title,
        artist: first.artist,
        source: first.source,
        ...encoder,
      })
      .onConflictDoUpdate({ target: liveNowPlaying.sessionId, set: encoder });
    await sync(scope);
  }

  // Events of one station apply in the order they arrived: an encoder's track change never
  // overtakes the session start before it.
  const queues = new Map<string, Promise<void>>();
  function serial(stationId: string, task: () => Promise<void>): Promise<void> {
    const next = (queues.get(stationId) ?? Promise.resolve()).then(task);
    queues.set(stationId, next);
    void next.finally(() => {
      if (queues.get(stationId) === next) queues.delete(stationId);
    });
    return next;
  }

  async function scopeOf(stationId: string): Promise<StationScope | undefined> {
    const [row] = await db
      .select({ orgId: station.orgId })
      .from(station)
      .where(eq(station.id, stationId));
    return row ? unsafeScope(row.orgId, stationId) : undefined;
  }

  return {
    async setManual(ctx, body) {
      const { title, artist } = setLiveNowPlayingSchema.parse(body);
      return manual(ctx, { title: title ?? null, artist: artist ?? null });
    },

    clearManual(ctx) {
      return manual(ctx, null);
    },

    async refresh(scope) {
      await sync(scope, { force: true });
    },

    onEvent(event) {
      if (event.type !== 'live.session.started' && event.type !== 'engine.live.metadata') {
        return Promise.resolve();
      }
      // An event with no session can't be told apart from a late one of the previous DJ.
      if (event.type === 'engine.live.metadata' && !event.data.sessionId) {
        return Promise.resolve();
      }
      return serial(event.stationId, async () => {
        try {
          const scope = await scopeOf(event.stationId);
          if (!scope) return;
          if (event.type === 'live.session.started') {
            await sync(scope);
          } else if (event.type === 'engine.live.metadata' && event.data.sessionId) {
            await encoderSent(scope, event.data.sessionId, {
              title: event.data.title,
              artist: event.data.artist,
            });
          }
        } catch (err) {
          logger.error(
            { err, stationId: event.stationId, type: event.type },
            'Live metadata failed',
          );
        }
      });
    },

    async liveStationIds() {
      const rows = await db
        .selectDistinct({ stationId: liveSession.stationId })
        .from(liveSession)
        .where(isNull(liveSession.endedAt));
      return new Set(rows.map((r) => r.stationId));
    },

    async sweep(scope) {
      if (!(await load(db, scope))) return; // nobody on air: nothing to ask the engine
      const engine = options.engineFor ? await options.engineFor(scope.stationId) : undefined;
      let engineState: EngineState | undefined;
      try {
        engineState = engine ? await engine.state() : undefined;
      } catch {
        engineState = undefined; // unreachable: store only, the next sweep pushes
      }
      await sync(scope, { engineState });
    },
  };
}
