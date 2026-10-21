import { randomInt } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EngineEvent, EngineQueuedRequest } from '@ondes/shared';

/**
 * In-process stand-in for a station engine's control API (ADR 0002), for unit tests: real
 * HTTP, in-memory queue and event log. Behaviour knobs (`delayMs`, `failWith`) let tests
 * exercise timeouts and errors; `restart()` simulates a new boot.
 */
export type FakeEngine = {
  url: string;
  stationId: string;
  bootId: string;
  queue: Array<EngineQueuedRequest & { body: unknown }>;
  log: EngineEvent[];
  /** Every request received, `METHOD /path`. */
  calls: string[];
  /** Files the fake accepts; anything else is a 422. */
  files: Set<string>;
  delayMs: number;
  /** Answer every route but health with this status, while set. */
  failWith: number | null;
  /** Live input disabled in the station settings: `POST /v1/live` answers 409. */
  liveDisabled: boolean;
  /** Health answers this status, while set (null = 200). */
  healthStatus: number | null;
  /** Appends an event to the log, as the engine's callbacks do. */
  emit<T extends EngineEvent['type']>(
    type: T,
    data: Extract<EngineEvent, { type: T }>['data'],
  ): EngineEvent;
  restart(): void;
  close(): Promise<void>;
};

export async function startFakeEngine(
  options: { stationId?: string; token?: string } = {},
): Promise<FakeEngine> {
  const stationId = options.stationId ?? 'station-1';
  let rid = 0;
  let server: Server;

  const engine: FakeEngine = {
    url: '',
    stationId,
    bootId: newBootId(),
    queue: [],
    log: [],
    calls: [],
    files: new Set(['/media/a.flac', '/media/b.flac', '/media/c.flac', '/media/island.flac']),
    delayMs: 0,
    failWith: null,
    liveDisabled: false,
    healthStatus: null,
    emit(type, data) {
      const event = {
        v: 1,
        seq: engine.log.length + 1,
        boot_id: engine.bootId,
        station_id: stationId,
        at: Date.now() / 1000,
        type,
        data,
      } as EngineEvent;
      engine.log.push(event);
      return event;
    },
    restart() {
      engine.bootId = newBootId();
      engine.log = [];
      engine.queue = [];
      engine.emit('engine.started', { version: '2.4.6' });
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  engine.emit('engine.started', { version: '2.4.6' });

  function send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  }

  function queued(body: { item_id: string; uri: string }, segmentId: string | null) {
    const entry = {
      rid: ++rid,
      item_id: body.item_id,
      segment_id: segmentId,
      uri: body.uri,
      status: 'ready',
      body,
    };
    engine.queue.push(entry);
    const { body: _, ...request } = entry;
    return request;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://fake');
    const route = `${req.method} ${url.pathname}`;
    engine.calls.push(route);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (engine.delayMs) await new Promise((r) => setTimeout(r, engine.delayMs));

    if (route === 'GET /v1/health') {
      if (engine.healthStatus) return send(res, engine.healthStatus, { error: 'down' });
      return send(res, 200, {
        status: 'ok',
        boot_id: engine.bootId,
        version: '2.4.6',
        config_version: 'cfg-1',
      });
    }
    if (engine.failWith) return send(res, engine.failWith, { error: 'failing on purpose' });
    if (options.token && req.headers.authorization !== `Bearer ${options.token}`) {
      return send(res, 401, { error: 'unauthorized' });
    }
    let body: Record<string, unknown> = {};
    try {
      if (raw) body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: 'invalid json' });
    }

    if (route === 'GET /v1/state') {
      return send(res, 200, {
        boot_id: engine.bootId,
        station_id: stationId,
        version: '2.4.6',
        uptime: 1,
        seq: engine.log.length,
        on_air: {},
        queue: engine.queue.map(({ body: _, ...r }) => r),
        live: { enabled: false, connected: false, ready: false },
        blank: false,
        output_db: null,
      });
    }
    if (route === 'GET /v1/events') {
      const after = Number(url.searchParams.get('after') ?? 0);
      return send(
        res,
        200,
        engine.log.filter((e) => e.seq > after),
      );
    }
    if (route === 'POST /v1/queue') {
      if (typeof body.item_id !== 'string' || typeof body.uri !== 'string') {
        return send(res, 400, { error: 'invalid push' });
      }
      if (!engine.files.has(body.uri))
        return send(res, 422, { error: `cannot resolve ${body.uri}` });
      return send(res, 201, queued(body as { item_id: string; uri: string }, null));
    }
    if (route === 'POST /v1/segment') {
      const parts = body.parts as Array<{ item_id: string; uri: string }>;
      const missing = parts.find((p) => !engine.files.has(p.uri));
      if (missing) return send(res, 422, { error: `cannot resolve ${missing.uri}` });
      const segmentId = String(body.segment_id);
      return send(res, 201, {
        segment_id: segmentId,
        requests: parts.map((p) => queued(p, segmentId)),
      });
    }
    if (route === 'DELETE /v1/queue') {
      const removed = engine.queue.length;
      engine.queue = [];
      return send(res, 200, { removed });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/v1/queue/')) {
      const id = decodeURIComponent(url.pathname.slice('/v1/queue/'.length));
      const before = engine.queue.length;
      // A segment can't be split: naming any of its parts removes all of it.
      const segments = new Set(
        engine.queue.filter((r) => r.item_id === id && r.segment_id).map((r) => r.segment_id),
      );
      engine.queue = engine.queue.filter(
        (r) => r.item_id !== id && r.segment_id !== id && !segments.has(r.segment_id),
      );
      const removed = before - engine.queue.length;
      if (!removed) return send(res, 404, { error: `item ${id} is not queued` });
      return send(res, 200, { removed });
    }
    if (route === 'POST /v1/skip') return send(res, 200, { skipped: true });
    if (route === 'POST /v1/live') {
      if (engine.liveDisabled) return send(res, 409, { error: 'live input is disabled' });
      if (typeof body.enabled !== 'boolean') return send(res, 400, { error: 'invalid live' });
      engine.emit('live.gate', { enabled: body.enabled });
      return send(res, 200, { enabled: body.enabled });
    }
    return send(res, 404, { error: 'no route' });
  }

  server = createServer((req, res) => {
    handle(req, res).catch((error) => send(res, 500, { error: String(error) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  engine.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return engine;
}

function newBootId(): string {
  return `${Math.floor(Date.now() / 1000)}-${randomInt(100000, 999999)}`;
}
