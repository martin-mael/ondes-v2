import type { ServerResponse } from 'node:http';
import type { EventSubscription } from '@ondes/queue';
import {
  eventReadPermission,
  type Permission,
  type RealtimeEvent,
  realtimeEventSchema,
  type ServerClockEvent,
} from '@ondes/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { stationScopeOf } from './auth.ts';

// Real-time events for browsers (#9): `GET /api/v1/stations/:stationId/events` streams the
// RabbitMQ event fanout as Server-Sent Events. One fanout subscription per api process feeds
// every open stream. Only event types declared in the contract are forwarded, re-serialised
// through their schema, to the subscribers of their station that hold the type's permission
// (`realtimeEventPermissions`). Each stream also gets `server.clock` ticks and heartbeats.
//
// The fanout is best-effort (no persistence, no acknowledgement): it's for UIs. Anything with
// side effects consumes a durable queue instead.

export interface SseOptions {
  /** Comment line that keeps proxies from closing an idle stream. */
  heartbeatMs: number;
  /** `server.clock` period (also sent on connect). */
  clockMs: number;
  /**
   * How often an open stream re-checks its credential and permissions (same guard as the
   * route). A revoked session, key or membership closes the stream at the next check.
   */
  revalidateMs: number;
  /**
   * Streams end after about this long (minus up to `maxStreamJitter` of it, so reconnects
   * spread out) and the browser reconnects with `Last-Event-ID`. They also end when the
   * session or key expires.
   */
  maxStreamMs: number;
  maxStreamJitter: number;
  /** Open streams per session or API key; a new one closes the oldest. */
  maxStreamsPerCredential: number;
  /** Recent events kept per station, per process, to replay after `Last-Event-ID`. */
  replayBufferSize: number;
  /** A client this far behind (bytes not yet flushed) is dropped. */
  maxBufferedBytes: number;
  /** Reconnect delay suggested to browsers (`retry:`). */
  retryMs: number;
}

export const DEFAULT_SSE_OPTIONS: SseOptions = {
  heartbeatMs: 15_000,
  clockMs: 10_000,
  revalidateMs: 60_000,
  maxStreamMs: 10 * 60_000,
  maxStreamJitter: 0.1,
  maxStreamsPerCredential: 5,
  replayBufferSize: 200,
  maxBufferedBytes: 1024 * 1024,
  retryMs: 3_000,
};

interface Client {
  stationId: string;
  permissions: ReadonlySet<Permission>;
  /** `session:<id>` or `api_key:<id>`, for the per-credential cap. */
  credential: string;
  openedAt: number;
  raw: ServerResponse;
  close(): void;
}

declare module 'fastify' {
  interface FastifyInstance {
    sse: {
      /** Open streams in this process. */
      readonly clients: number;
      /** Resolves once the fanout subscription is consuming (immediately without RabbitMQ). */
      ready: Promise<void>;
    };
  }
}

const params = z.object({ stationId: z.string() });
const query = z.object({
  /**
   * Same as the `Last-Event-ID` header, for clients that reconnect by hand (a browser's
   * EventSource only sends the header on its own retries).
   */
  lastEventId: z.string().max(100).optional(),
});
const accessResponse = z.object({ permissions: z.array(z.string()) });

const canSee = (client: Client, event: RealtimeEvent) => {
  if (event.stationId !== client.stationId) return false;
  const permission = eventReadPermission(event.type);
  return permission !== null && client.permissions.has(permission);
};

const frame = (event: RealtimeEvent) => `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
const clockFrame = () => {
  const event: ServerClockEvent = { type: 'server.clock', at: new Date().toISOString() };
  return `data: ${JSON.stringify(event)}\n\n`;
};

/** Who the stream belongs to, and until when it may stay open. */
function credentialOf(request: FastifyRequest): { key: string; expiresAt: Date | null } {
  const auth = request.auth;
  if (auth?.kind === 'session')
    return { key: `session:${auth.session.id}`, expiresAt: auth.session.expiresAt };
  if (auth?.kind === 'api_key')
    return { key: `api_key:${auth.apiKey.id}`, expiresAt: auth.apiKey.expiresAt };
  throw new Error('sse route without an authenticated caller');
}

export const ssePlugin = fp(
  async (app: FastifyInstance, overrides: Partial<SseOptions> = {}) => {
    const options = { ...DEFAULT_SSE_OPTIONS, ...overrides };
    const clients = new Set<Client>();
    const recent = new Map<string, RealtimeEvent[]>();

    const send = (client: Client, chunk: string) => {
      if (client.raw.destroyed || client.raw.writableEnded) {
        client.close();
        return;
      }
      if (client.raw.writableLength > options.maxBufferedBytes) {
        app.log.warn({ stationId: client.stationId }, 'sse client too slow, dropping it');
        client.close();
        return;
      }
      client.raw.write(chunk);
    };

    const onEvent = (raw: unknown) => {
      // Strict per-type schemas: undeclared types are dropped, undeclared fields stripped.
      const parsed = realtimeEventSchema.safeParse(raw);
      if (!parsed.success) {
        const type = (raw as { type?: unknown } | null)?.type;
        app.log.debug({ type, issues: parsed.error.issues }, 'sse: dropping an undeclared event');
        return;
      }
      const event = parsed.data;
      const ring = recent.get(event.stationId) ?? [];
      ring.push(event);
      if (ring.length > options.replayBufferSize) ring.shift();
      recent.set(event.stationId, ring);
      for (const client of clients) if (canSee(client, event)) send(client, frame(event));
    };

    let subscription: EventSubscription | null = null;
    if (app.hasDecorator('rabbit')) {
      subscription = app.rabbit.subscribeEvents(onEvent);
      app.addHook('onClose', () => subscription?.close());
    }
    app.decorate('sse', {
      get clients() {
        return clients.size;
      },
      ready: subscription ? subscription.ready.then(() => undefined) : Promise.resolve(),
    });
    // End open streams first, or `app.close()` would wait for them.
    app.addHook('preClose', () => {
      for (const client of clients) client.close();
    });

    const guard = { preHandler: app.requirePermission('station', 'read') };
    const r = app.withTypeProvider<ZodTypeProvider>();

    // The stream's access check on its own: what the caller may read on this station. Open
    // streams re-run it periodically; the web app calls it to learn why a stream was refused.
    r.get(
      '/api/v1/stations/:stationId/events/access',
      { ...guard, schema: { params, response: { 200: accessResponse } } },
      async (request) => ({ permissions: [...(request.permissions ?? [])] }),
    );

    r.get(
      '/api/v1/stations/:stationId/events',
      { ...guard, schema: { params, querystring: query } },
      async (request, reply) => {
        const { stationId } = stationScopeOf(request);
        const credential = credentialOf(request);
        // Re-sent as is by the periodic access check.
        const authHeaders = {
          ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
          ...(request.headers.authorization
            ? { authorization: request.headers.authorization }
            : {}),
        };

        // Past this point Fastify no longer handles the reply: `hijack()` skips `onSend` hooks
        // and serialisation, so every header the stream needs is written here.
        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-content-type-options': 'nosniff',
          // Caddy and nginx: don't buffer the stream.
          'x-accel-buffering': 'no',
        });

        const timers: NodeJS.Timeout[] = [];
        const client: Client = {
          stationId,
          permissions: request.permissions ?? new Set<Permission>(),
          credential: credential.key,
          openedAt: Date.now(),
          raw,
          close: () => {
            if (!clients.delete(client)) return;
            for (const timer of timers) clearTimeout(timer);
            if (!raw.destroyed) raw.end();
          },
        };

        // One credential, a few tabs at most: the oldest stream makes room.
        const same = [...clients]
          .filter((other) => other.credential === credential.key)
          .sort((a, b) => a.openedAt - b.openedAt);
        while (same.length >= options.maxStreamsPerCredential) same.shift()?.close();

        clients.add(client);
        raw.on('close', client.close);
        raw.on('error', client.close);

        raw.write(`retry: ${options.retryMs}\n\n`);
        // Replay what this process saw for the station after the client's last event. An
        // unknown id (too old, or seen by another replica) replays nothing: the page refetches.
        const header = request.headers['last-event-id'];
        const lastEventId = typeof header === 'string' ? header : request.query.lastEventId;
        if (lastEventId) {
          const ring = recent.get(stationId) ?? [];
          const index = ring.findIndex((event) => event.id === lastEventId);
          if (index >= 0) {
            for (const event of ring.slice(index + 1)) {
              if (canSee(client, event)) send(client, frame(event));
            }
          }
        }
        send(client, clockFrame());

        const lifetime = Math.min(
          options.maxStreamMs * (1 - Math.random() * options.maxStreamJitter),
          credential.expiresAt
            ? credential.expiresAt.getTime() - Date.now()
            : Number.POSITIVE_INFINITY,
        );
        const revalidate = async () => {
          const res = await app
            .inject({
              method: 'GET',
              url: `/api/v1/stations/${stationId}/events/access`,
              headers: authHeaders,
            })
            .catch(() => null);
          if (res?.statusCode !== 200) {
            client.close();
            return;
          }
          client.permissions = new Set(
            accessResponse.parse(res.json()).permissions as Permission[],
          );
        };
        timers.push(
          setInterval(() => send(client, ': ping\n\n'), options.heartbeatMs),
          setInterval(() => send(client, clockFrame()), options.clockMs),
          setInterval(() => void revalidate(), options.revalidateMs),
          setTimeout(client.close, Math.max(0, lifetime)),
        );
      },
    );
  },
  { name: 'sse', dependencies: ['auth'] },
);
