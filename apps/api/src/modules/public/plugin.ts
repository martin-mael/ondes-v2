import {
  type PublicHistoryItem,
  type PublicNowPlaying,
  publicHistorySchema,
  publicNowPlayingSchema,
} from '@ondes/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { HttpError } from '../../plugins/errors.ts';
import { buildOpenApi, PUBLIC_PREFIX, publicOperations } from './openapi.ts';
import {
  buildHistory,
  buildNowPlaying,
  findStationById,
  findStationBySlug,
  type LiveNowPlayingReader,
  noLiveNowPlaying,
  type PublicStationRef,
} from './service.ts';
import { createSnapshotCache, etagMatches, etagOf, type Snapshot } from './snapshot.ts';
import { createPublicStream, type PublicStreamOptions } from './stream.ts';

// Public API (#74, ADR 0041), anonymous, under /api/v1/public:
//   GET /stations/:slug/now-playing   what is on air (shared snapshot, ETag, Cache-Control)
//   GET /stations/:slug/history       what aired, newest first
//   GET /stations/:slug/events        now playing over SSE, one shared snapshot per station
//   GET /openapi.json                 the OpenAPI document of all of the above
// CORS is open (`*`, no credentials). Every route is rate limited per client IP. Snapshots are
// rebuilt on the event fanout's events for their station, never per request.

export interface PublicPluginOptions {
  /** Live metadata (#68): what the DJ on air plays. Default: none. */
  liveNowPlaying?: LiveNowPlayingReader;
  /** REST requests per client IP and window. */
  rateLimit?: { max: number; timeWindowMs: number };
  /** Stream connections per client IP and window (on top of the open-streams cap). */
  streamRateLimit?: { max: number; timeWindowMs: number };
  /** Longest a now-playing snapshot is served without an event (also its refresh for streams). */
  nowPlayingTtlMs?: number;
  historyTtlMs?: number;
  /** Stations' slug lookups are kept this long (a renamed slug is also caught by its event). */
  stationTtlMs?: number;
  stream?: Partial<PublicStreamOptions>;
}

declare module 'fastify' {
  interface FastifyInstance {
    publicApi: {
      /** Feeds one fanout event in (what the RabbitMQ subscription does; tests call it). */
      onEvent(raw: unknown): void;
      /** Open public streams in this process. */
      readonly listeners: number;
      /** Resolves once the fanout subscription is consuming (immediately without RabbitMQ). */
      ready: Promise<void>;
      /** Resolves once every `station.updated` re-read in flight has landed (tests). */
      settled(): Promise<void>;
    };
  }
}

/** Events that change what a station's now playing shows. */
const NOW_PLAYING_EVENTS = new Set([
  'asrun.started',
  'asrun.ended',
  'engine.up',
  'engine.down',
  'engine.booted',
  'engine.track.started',
  'log.updated',
  'log.item.changed',
  'feeder.item.passed_over',
  'live.session.started',
  'live.session.ended',
  // Live metadata (#68): the DJ's encoder or a manual update.
  'live.metadata.changed',
  'station.updated',
]);
const HISTORY_EVENTS = new Set(['asrun.ended', 'station.updated']);

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers':
    'ETag, Retry-After, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset',
};

/** Suggested wait after a 503 (no room for a stream) or a 429 (too many from one address). */
const STREAM_RETRY_AFTER_S = 30;

/** Leaves the snapshot's own clock out of its ETag: only content changes make a new one. */
const withoutClock = ({ at: _, ...rest }: PublicNowPlaying) => rest;

export const publicPlugin = fp(
  async (app: FastifyInstance, options: PublicPluginOptions) => {
    const readLive = options.liveNowPlaying ?? noLiveNowPlaying;
    const rest = options.rateLimit ?? { max: 120, timeWindowMs: 60_000 };
    const connects = options.streamRateLimit ?? { max: 20, timeWindowMs: 60_000 };

    // Slug -> station, unknown slugs included (a miss is cached too).
    const stations = createSnapshotCache<string, PublicStationRef | null>(
      (slug) => findStationBySlug(app.db, slug),
      { ttlMs: options.stationTtlMs ?? 60_000, maxEntries: 10_000 },
    );
    // Station id -> what the snapshots are built from. Set by the first slug lookup, then
    // replaced only by a `station.updated` re-read (refresh below), never removed: open streams
    // keep rebuilding from it.
    const refs = new Map<string, PublicStationRef>();
    const refOf = (stationId: string) => {
      const ref = refs.get(stationId);
      if (!ref) throw new Error(`public api: station ${stationId} was never resolved`);
      return ref;
    };
    // The asset on air per station, as of its last build: `asset.updated` rebuilds only then.
    const onAirAssets = new Map<string, string | null>();
    // Parsed through the public contract on the way in: a field that isn't in it can't leak.
    const nowPlaying = createSnapshotCache<string, PublicNowPlaying>(
      async (stationId) => {
        const built = await buildNowPlaying(app.db, refOf(stationId), readLive);
        onAirAssets.set(stationId, built.onAirAssetId);
        return publicNowPlayingSchema.parse(built.nowPlaying);
      },
      {
        ttlMs: options.nowPlayingTtlMs ?? 30_000,
        maxEntries: 10_000,
        fingerprint: withoutClock,
        // A show block ends with no event of its own.
        expiresAt: (value) => (value.show ? Date.parse(value.show.endsAt) + 1_000 : null),
      },
    );
    const history = createSnapshotCache<string, PublicHistoryItem[]>(
      async (stationId) => buildHistory(app.db, refOf(stationId).scope),
      { ttlMs: options.historyTtlMs ?? 60_000, maxEntries: 10_000 },
    );
    const stream = createPublicStream((stationId) => nowPlaying.get(stationId), app.log, {
      ...options.stream,
    });

    const rebuild = (stationId: string, type: string) => {
      if (HISTORY_EVENTS.has(type)) history.invalidate(stationId);
      if (NOW_PLAYING_EVENTS.has(type)) {
        nowPlaying.invalidate(stationId);
        stream.changed(stationId);
      }
    };

    // `station.updated` re-reads the station (its slug, name or timezone may have changed),
    // one read at a time per station: a burst of events can't let an older read land last.
    const refreshes = new Map<string, Promise<void>>();
    const refresh = (stationId: string) => {
      const previous = refreshes.get(stationId) ?? Promise.resolve();
      const next = previous.then(async () => {
        try {
          const ref = await findStationById(app.db, stationId);
          // A deleted station keeps its last ref: its snapshot shows it off air.
          if (ref) refs.set(stationId, ref);
        } catch (err) {
          app.log.error({ err, stationId }, 'public api: station refresh failed');
        }
        // Rebuilt from the new ref (the rebuild on the event itself may have used the old one).
        rebuild(stationId, 'station.updated');
      });
      refreshes.set(stationId, next);
      void next.finally(() => {
        if (refreshes.get(stationId) === next) refreshes.delete(stationId);
      });
      return next;
    };

    const onEvent = (raw: unknown) => {
      const event = raw as {
        type?: unknown;
        stationId?: unknown;
        data?: { assetId?: unknown; changes?: unknown };
      } | null;
      if (typeof event?.type !== 'string' || typeof event.stationId !== 'string') return;
      const { type, stationId } = event;
      if (type === 'asset.updated') {
        // Only the cues of the asset on air show (the current item's duration); loudness and
        // playout settings don't, and other assets reach `next` through the log's events.
        const changes = Array.isArray(event.data?.changes) ? event.data.changes : [];
        if (event.data?.assetId === onAirAssets.get(stationId) && changes.includes('cues')) {
          nowPlaying.invalidate(stationId);
          stream.changed(stationId);
        }
        return;
      }
      if (type === 'station.updated') {
        // Slugs may have moved between stations: look every slug up again.
        stations.clear();
        if (refs.has(stationId)) void refresh(stationId);
      }
      rebuild(stationId, type);
    };

    let ready = Promise.resolve();
    if (app.hasDecorator('rabbit')) {
      const subscription = app.rabbit.subscribeEvents(onEvent);
      ready = subscription.ready.then(() => undefined);
      app.addHook('onClose', () => subscription.close());
    }
    app.decorate('publicApi', {
      onEvent,
      get listeners() {
        return stream.listeners;
      },
      ready,
      settled: async () => {
        await Promise.all(refreshes.values());
      },
    });
    app.addHook('preClose', () => stream.close());

    const resolve = async (slug: string) => {
      const ref = (await stations.get(slug)).value;
      if (!ref) throw new HttpError(404, 'not_found', `no station "${slug}"`);
      // First sight only: afterwards `refresh` owns it, so a slug lookup read before a
      // `station.updated` can't overwrite what that event re-read.
      if (!refs.has(ref.scope.stationId)) refs.set(ref.scope.stationId, ref);
      return refOf(ref.scope.stationId);
    };

    /** Sends a cached JSON snapshot, or 304 when the client already has it. */
    const sendCached = (
      request: FastifyRequest,
      reply: FastifyReply,
      cached: { body: string; etag: string },
      maxAge: number,
    ) => {
      reply
        .header('etag', cached.etag)
        .header('cache-control', `public, max-age=${maxAge}, stale-while-revalidate=${maxAge}`);
      if (etagMatches(request.headers['if-none-match'], cached.etag)) {
        return reply.code(304).send();
      }
      return reply.type('application/json; charset=utf-8').send(cached.body);
    };

    // History bodies per limit, serialised once per snapshot.
    const historyBodies = new WeakMap<
      Snapshot<PublicHistoryItem[]>,
      Map<number, { body: string; etag: string }>
    >();

    const operation = (id: string) => {
      const op = publicOperations.find((o) => o.operationId === id);
      if (!op) throw new Error(`public api: no operation ${id}`);
      return op;
    };
    const nowPlayingOp = operation('getNowPlaying');
    const historyOp = operation('getHistory');
    const eventsOp = operation('streamNowPlaying');
    let openApiBody: string | null = null;

    await app.register(
      async (scope) => {
        scope.addHook('onRequest', async (_request, reply) => {
          reply.headers(CORS_HEADERS);
        });
        const restLimit = { rateLimit: { max: rest.max, timeWindow: rest.timeWindowMs } };
        const r = scope.withTypeProvider<ZodTypeProvider>();

        // Preflight: `If-None-Match` and `Last-Event-ID` aren't CORS-safelisted headers.
        r.options('/*', { config: restLimit }, async (_request, reply) =>
          reply
            .code(204)
            .header('access-control-allow-methods', 'GET, OPTIONS')
            .header('access-control-allow-headers', 'If-None-Match, Last-Event-ID, Cache-Control')
            .header('access-control-max-age', '86400')
            .send(),
        );

        r.get(
          nowPlayingOp.path,
          {
            config: restLimit,
            schema: { params: nowPlayingOp.params, response: { 200: publicNowPlayingSchema } },
          },
          async (request, reply) => {
            const { slug } = request.params as { slug: string };
            const ref = await resolve(slug);
            return sendCached(request, reply, await nowPlaying.get(ref.scope.stationId), 5);
          },
        );

        r.get(
          historyOp.path,
          {
            config: restLimit,
            schema: {
              params: historyOp.params,
              querystring: historyOp.query,
              response: { 200: publicHistorySchema },
            },
          },
          async (request, reply) => {
            const { slug } = request.params as { slug: string };
            const { limit } = request.query as { limit: number };
            const ref = await resolve(slug);
            const snapshot = await history.get(ref.scope.stationId);
            let bodies = historyBodies.get(snapshot);
            if (!bodies) {
              bodies = new Map();
              historyBodies.set(snapshot, bodies);
            }
            let cached = bodies.get(limit);
            if (!cached) {
              const body = JSON.stringify(
                publicHistorySchema.parse({
                  station: ref.station,
                  items: snapshot.value.slice(0, limit),
                }),
              );
              cached = { body, etag: etagOf(body) };
              bodies.set(limit, cached);
            }
            return sendCached(request, reply, cached, 15);
          },
        );

        r.get(
          eventsOp.path,
          {
            config: { rateLimit: { max: connects.max, timeWindow: connects.timeWindowMs } },
            schema: { params: eventsOp.params },
          },
          async (request, reply) => {
            const { slug } = request.params as { slug: string };
            const ref = await resolve(slug);
            const admitted = stream.admit(request.ip);
            if (admitted !== 'ok') reply.header('retry-after', String(STREAM_RETRY_AFTER_S));
            if (admitted === 'too_many') {
              throw new HttpError(429, 'rate_limited', 'too many open streams from this address');
            }
            if (admitted === 'full') {
              throw new HttpError(503, 'unavailable', 'no room for another stream, retry later');
            }
            // Past this point Fastify no longer handles the reply (no onSend hooks): the
            // stream writes every header itself, CORS included.
            reply.hijack();
            stream.open(ref.scope.stationId, request.ip, reply.raw, CORS_HEADERS);
          },
        );

        r.get('/openapi.json', { config: restLimit }, async (_request, reply) => {
          openApiBody ??= JSON.stringify(buildOpenApi());
          return reply
            .type('application/json; charset=utf-8')
            .header('cache-control', 'public, max-age=3600')
            .send(openApiBody);
        });
      },
      { prefix: PUBLIC_PREFIX },
    );
  },
  { name: 'public-api', dependencies: ['auth'] },
);
