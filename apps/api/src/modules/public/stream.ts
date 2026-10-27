import type { ServerResponse } from 'node:http';
import type { FastifyBaseLogger } from 'fastify';
import type { Snapshot } from './snapshot.ts';

// The public now-playing stream (#74, ADR 0041): `GET /api/v1/public/stations/:slug/events`.
// Anonymous, so nothing like the internal SSE plugin (credentials, permissions, replay): a
// listener gets the station's public snapshot on connect, then again each time its content
// changes. Built for many listeners per station: one snapshot per station (the shared cache),
// rebuilt once per change whatever the number of listeners, and written as the same frame to
// each. One process-wide timer sends heartbeats and ends streams that lived long enough.

export interface PublicStreamOptions {
  /** Comment line that keeps proxies from closing an idle stream. */
  heartbeatMs: number;
  /** Events come in bursts (a log edit is one event per item): changes wait this long. */
  debounceMs: number;
  /**
   * Streams end after about this long (minus up to 10 %, so reconnects spread over replicas)
   * and the browser reconnects on its own.
   */
  maxStreamMs: number;
  /** Open streams per process; past it, new ones get 503. */
  maxClients: number;
  /** Open streams per client IP; past it, new ones get 429. */
  maxClientsPerIp: number;
  /** A listener this far behind (bytes not yet flushed) is dropped. */
  maxBufferedBytes: number;
  /** Reconnect delay suggested to browsers (`retry:`). */
  retryMs: number;
}

export const DEFAULT_PUBLIC_STREAM_OPTIONS: PublicStreamOptions = {
  heartbeatMs: 15_000,
  debounceMs: 250,
  maxStreamMs: 30 * 60_000,
  maxClients: 10_000,
  maxClientsPerIp: 10,
  maxBufferedBytes: 256 * 1024,
  retryMs: 5_000,
};

/** The SSE event name of a snapshot frame. */
export const NOW_PLAYING_EVENT = 'now_playing';

interface Listener {
  stationId: string;
  ip: string;
  closeAt: number;
  raw: ServerResponse;
  close(): void;
}

interface Feed {
  listeners: Set<Listener>;
  /** ETag of the last snapshot written to this station's listeners. */
  sent: string | null;
  /** The next rebuild: debounced after an event, or at the snapshot's own expiry. */
  timer: NodeJS.Timeout | null;
  timerAt: number;
}

export type OpenResult = 'ok' | 'too_many' | 'full';

export interface PublicStream {
  /** Checks the caps before the response is hijacked. */
  admit(ip: string): OpenResult;
  open(stationId: string, ip: string, raw: ServerResponse, headers: Record<string, string>): void;
  /** Something changed for the station: rebuild and push after the debounce. */
  changed(stationId: string): void;
  readonly listeners: number;
  close(): void;
}

const frame = (snapshot: Snapshot<unknown>) =>
  `event: ${NOW_PLAYING_EVENT}\nid: ${snapshot.etag}\ndata: ${snapshot.body}\n\n`;

export function createPublicStream(
  read: (stationId: string) => Promise<Snapshot<unknown>>,
  log: FastifyBaseLogger,
  overrides: Partial<PublicStreamOptions> = {},
): PublicStream {
  const options = { ...DEFAULT_PUBLIC_STREAM_OPTIONS, ...overrides };
  const feeds = new Map<string, Feed>();
  const perIp = new Map<string, number>();
  let total = 0;

  const write = (listener: Listener, chunk: string) => {
    if (listener.raw.destroyed || listener.raw.writableEnded) {
      listener.close();
      return;
    }
    if (listener.raw.writableLength > options.maxBufferedBytes) {
      log.debug({ stationId: listener.stationId }, 'public stream: listener too slow, dropping');
      listener.close();
      return;
    }
    listener.raw.write(chunk);
  };

  const schedule = (stationId: string, at: number) => {
    const feed = feeds.get(stationId);
    if (!feed) return;
    if (feed.timer && feed.timerAt <= at) return;
    if (feed.timer) clearTimeout(feed.timer);
    feed.timerAt = at;
    feed.timer = setTimeout(() => void push(stationId), Math.max(0, at - Date.now()));
  };

  const push = async (stationId: string) => {
    const feed = feeds.get(stationId);
    if (!feed) return;
    feed.timer = null;
    let snapshot: Snapshot<unknown>;
    try {
      snapshot = await read(stationId);
    } catch (err) {
      log.error({ err, stationId }, 'public stream: snapshot failed');
      schedule(stationId, Date.now() + 5_000);
      return;
    }
    if (feeds.get(stationId) !== feed) return;
    if (snapshot.etag !== feed.sent) {
      feed.sent = snapshot.etag;
      const chunk = frame(snapshot);
      for (const listener of feed.listeners) write(listener, chunk);
    }
    // The snapshot names when it goes stale on its own (TTL, a show block ending).
    schedule(stationId, snapshot.expiresAt + 50);
  };

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const feed of feeds.values()) {
      for (const listener of feed.listeners) {
        if (listener.closeAt <= now) listener.close();
        else write(listener, ': ping\n\n');
      }
    }
  }, options.heartbeatMs);
  sweep.unref();

  return {
    admit(ip) {
      if (total >= options.maxClients) return 'full';
      if ((perIp.get(ip) ?? 0) >= options.maxClientsPerIp) return 'too_many';
      return 'ok';
    },
    open(stationId, ip, raw, headers) {
      raw.writeHead(200, {
        ...headers,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-content-type-options': 'nosniff',
        'x-accel-buffering': 'no',
      });
      let feed = feeds.get(stationId);
      if (!feed) {
        feed = { listeners: new Set(), sent: null, timer: null, timerAt: 0 };
        feeds.set(stationId, feed);
      }
      const own = feed;
      const listener: Listener = {
        stationId,
        ip,
        closeAt: Date.now() + options.maxStreamMs * (1 - Math.random() * 0.1),
        raw,
        close: () => {
          if (!own.listeners.delete(listener)) return;
          total--;
          const left = (perIp.get(ip) ?? 1) - 1;
          if (left > 0) perIp.set(ip, left);
          else perIp.delete(ip);
          if (own.listeners.size === 0 && feeds.get(stationId) === own) {
            if (own.timer) clearTimeout(own.timer);
            feeds.delete(stationId);
          }
          if (!raw.destroyed) raw.end();
        },
      };
      own.listeners.add(listener);
      total++;
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      raw.on('close', listener.close);
      raw.on('error', listener.close);

      raw.write(`retry: ${options.retryMs}\n\n`);
      // The current snapshot first, from the shared cache (no query unless it is stale).
      read(stationId).then(
        (snapshot) => {
          if (!own.listeners.has(listener)) return;
          write(listener, frame(snapshot));
          if (own.sent === null) {
            own.sent = snapshot.etag;
            schedule(stationId, snapshot.expiresAt + 50);
          } else if (own.sent !== snapshot.etag) {
            // Newer than what the others got: the feed catches up.
            schedule(stationId, Date.now());
          }
        },
        (err: unknown) => {
          log.error({ err, stationId }, 'public stream: snapshot failed');
          listener.close();
        },
      );
    },
    changed(stationId) {
      if (!feeds.has(stationId)) return;
      schedule(stationId, Date.now() + options.debounceMs);
    },
    get listeners() {
      return total;
    },
    close() {
      clearInterval(sweep);
      for (const feed of [...feeds.values()]) {
        for (const listener of [...feed.listeners]) listener.close();
      }
    },
  };
}
