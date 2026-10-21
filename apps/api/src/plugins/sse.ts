import type { ServerResponse } from 'node:http';
import type { EventSubscription } from '@ondes/queue';
import {
  eventReadPermission,
  type Permission,
  type RealtimeEnvelope,
  realtimeEnvelopeSchema,
  type ServerClockEvent,
} from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import { stationScopeOf } from './auth.ts';

// Real-time events for browsers (#9): `GET /api/v1/stations/:stationId/events` streams the
// RabbitMQ event fanout as Server-Sent Events. One fanout subscription per api process feeds
// every open stream; each stream gets its station's events that the caller may read
// (`eventReadPermission`), plus `server.clock` ticks and heartbeats.

export interface SseOptions {
  /** Comment line that keeps proxies from closing an idle stream. */
  heartbeatMs: number;
  /** `server.clock` period (also sent on connect). */
  clockMs: number;
  /**
   * Streams end after this long and the browser reconnects (with `Last-Event-ID`). That's when
   * revoked memberships, permissions and sessions take effect on an open stream.
   */
  maxStreamMs: number;
  /** Recent events kept per process to replay after `Last-Event-ID`. */
  replayBufferSize: number;
  /** A client this far behind (bytes not yet flushed) is dropped. */
  maxBufferedBytes: number;
  /** Reconnect delay suggested to browsers (`retry:`). */
  retryMs: number;
}

export const DEFAULT_SSE_OPTIONS: SseOptions = {
  heartbeatMs: 15_000,
  clockMs: 10_000,
  maxStreamMs: 10 * 60_000,
  replayBufferSize: 500,
  maxBufferedBytes: 1024 * 1024,
  retryMs: 3_000,
};

interface Client {
  stationId: string;
  permissions: ReadonlySet<Permission>;
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

const canSee = (client: Client, event: RealtimeEnvelope) => {
  if (event.stationId !== client.stationId) return false;
  const permission = eventReadPermission(event.type);
  return permission !== null && client.permissions.has(permission);
};

const frame = (event: RealtimeEnvelope) => `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
const clockFrame = () => {
  const event: ServerClockEvent = { type: 'server.clock', at: new Date().toISOString() };
  return `data: ${JSON.stringify(event)}\n\n`;
};

export const ssePlugin = fp(
  async (app: FastifyInstance, overrides: Partial<SseOptions> = {}) => {
    const options = { ...DEFAULT_SSE_OPTIONS, ...overrides };
    const clients = new Set<Client>();
    const recent: RealtimeEnvelope[] = [];

    const send = (client: Client, chunk: string) => {
      if (client.raw.writableLength > options.maxBufferedBytes) {
        app.log.warn({ stationId: client.stationId }, 'sse client too slow, dropping it');
        client.close();
        return;
      }
      client.raw.write(chunk);
    };

    const onEvent = (raw: unknown) => {
      const parsed = realtimeEnvelopeSchema.safeParse(raw);
      if (!parsed.success) {
        app.log.warn({ issues: parsed.error.issues }, 'dropping a fanout event without envelope');
        return;
      }
      const event = parsed.data;
      recent.push(event);
      if (recent.length > options.replayBufferSize) recent.shift();
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

    app.get(
      '/api/v1/stations/:stationId/events',
      { preHandler: app.requirePermission('station', 'read'), schema: { params } },
      async (request, reply) => {
        const { stationId } = stationScopeOf(request);
        const permissions = request.permissions ?? new Set<Permission>();
        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          // Caddy and nginx: don't buffer the stream.
          'x-accel-buffering': 'no',
        });

        const timers: NodeJS.Timeout[] = [];
        const client: Client = {
          stationId,
          permissions,
          raw,
          close: () => {
            if (!clients.delete(client)) return;
            for (const timer of timers) clearTimeout(timer);
            raw.end();
          },
        };
        clients.add(client);
        request.raw.on('close', client.close);

        raw.write(`retry: ${options.retryMs}\n\n`);
        // Replay what this process saw after the client's last event. An unknown id (too old,
        // or seen by another replica) replays nothing: the page refetches what it shows.
        const lastEventId = request.headers['last-event-id'];
        if (typeof lastEventId === 'string') {
          const index = recent.findIndex((event) => event.id === lastEventId);
          if (index >= 0) {
            for (const event of recent.slice(index + 1)) {
              if (canSee(client, event)) send(client, frame(event));
            }
          }
        }
        send(client, clockFrame());

        timers.push(
          setInterval(() => send(client, ': ping\n\n'), options.heartbeatMs),
          setInterval(() => send(client, clockFrame()), options.clockMs),
          setTimeout(client.close, options.maxStreamMs),
        );
      },
    );
  },
  { name: 'sse', dependencies: ['auth'] },
);
