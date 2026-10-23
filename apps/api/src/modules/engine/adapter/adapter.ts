import { setTimeout as sleep } from 'node:timers/promises';
import {
  ENGINE_ROUTES,
  type EngineEventBatch,
  type EngineHealth,
  type EnginePushItem,
  type EnginePushSegment,
  type EnginePushSegmentResult,
  type EngineQueuedRequest,
  type EngineRemoveResult,
  type EngineState,
  engineErrorSchema,
  engineEventBatchSchema,
  engineHealthSchema,
  engineLiveDisconnectResultSchema,
  engineLiveDisconnectSchema,
  engineLiveGateSchema,
  enginePushItemSchema,
  enginePushSegmentResultSchema,
  enginePushSegmentSchema,
  engineQueuedRequestSchema,
  engineRemoveResultSchema,
  engineSkipResultSchema,
  engineStateSchema,
} from '@ondes/shared';
import { z } from 'zod';
import {
  EngineBadRequestError,
  EngineConflictError,
  type EngineError,
  EngineNotQueuedError,
  EngineProtocolError,
  EngineServerError,
  EngineUnauthorizedError,
  EngineUnavailableError,
  EngineUnresolvableError,
} from './errors.ts';

/**
 * Typed control plane for one station's engine (ADR 0002): harbor HTTP + JSON on the
 * engine's internal control port. Every call has a timeout, every answer is checked against
 * `@ondes/shared` before it's returned, and every failure is an `EngineError`.
 *
 * Nothing here touches the audio path: the engine answers from refs and queue operations
 * (never from source methods), and a slow or dead engine costs the caller at most the
 * timeout. Commands that are safe to repeat (reads, clear, live gate) are retried on
 * timeouts and 5xx; pushes, removes and skips are not, because repeating them changes what
 * airs. The caller (the feeder, #29) reconciles from `state()` instead.
 */
export type EngineAdapter = {
  readonly stationId: string;
  /** Unauthenticated liveness probe. */
  health(): Promise<EngineHealth>;
  /** Snapshot: on air, queue, live, blank. Checked to belong to this station. */
  state(): Promise<EngineState>;
  /** The engine's event log after `seq` (current boot only, last 1000 events). */
  events(after: number): Promise<EngineEventBatch>;
  /** Appends one log item. Throws `EngineUnresolvableError` if the file can't be played. */
  push(item: EnginePushItem): Promise<EngineQueuedRequest>;
  /** Appends an island chain as one merged queue entry. Nothing is queued on a 422. */
  pushSegment(segment: EnginePushSegment): Promise<EnginePushSegmentResult>;
  /** Removes every queued request of a log item or segment. `EngineNotQueuedError` on 404. */
  remove(id: string): Promise<EngineRemoveResult>;
  /** Empties the queue. The item on air keeps playing. */
  clear(): Promise<EngineRemoveResult>;
  /** Ends whatever is on air (a whole segment, if one is playing). */
  skip(): Promise<void>;
  /**
   * Opens or closes the live gate. `EngineConflictError` if live is disabled for the station.
   * Opening may name the harbor input to put on air (default: the first ready one) and the live
   * session the engine reports on its as-run events (#64).
   */
  setLive(enabled: boolean, options?: LiveGateOptions): Promise<void>;
  /** Hangs up the DJ on one harbor input (#64). False if nobody was connected there. */
  disconnectLive(input: number): Promise<boolean>;
  /**
   * Pre-listen (#71): the harbor input's audio as its DJ sends it, an endless MP3 stream from
   * the control port (`prelisten/<input>`). Null when nobody streams there. Abort `signal` to
   * hang up; the body has no timeout, only the answer does.
   */
  listen(input: number, signal?: AbortSignal): Promise<Response | null>;
};

export type LiveGateOptions = { input?: number; sessionId?: string };

export type EngineAdapterOptions = {
  stationId: string;
  /** Control API base, e.g. `http://engine-<station>:7000`. Internal network only. */
  baseUrl: string;
  /** `ENGINE_CONTROL_TOKEN`; sent as a bearer token on every route but health. */
  token?: string;
  /** Per-attempt timeout for reads and simple commands. Default 2 s. */
  timeoutMs?: number;
  /**
   * Per-attempt timeout for pushes. The engine resolves files before answering (up to 5 s
   * per request on its side), so this is longer. Default 8 s.
   */
  pushTimeoutMs?: number;
  /** Extra attempts for repeatable commands. Default 2. */
  retries?: number;
  /** Delay before the first retry, doubled on each one. Default 100 ms. */
  retryDelayMs?: number;
  fetch?: typeof fetch;
};

type Call = {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  auth?: boolean;
  repeatable?: boolean;
  timeoutMs?: number;
};

export function createEngineAdapter(options: EngineAdapterOptions): EngineAdapter {
  const { stationId, token } = options;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 2_000;
  const pushTimeoutMs = options.pushTimeoutMs ?? 8_000;
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 100;
  const doFetch = options.fetch ?? fetch;

  async function call<S extends z.ZodType>(schema: S, c: Call): Promise<z.output<S>> {
    const route = `${c.method} ${c.path}`;
    const attempts = c.repeatable ? retries + 1 : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return await once(schema, c, route);
      } catch (error) {
        const retry =
          attempt < attempts &&
          (error instanceof EngineUnavailableError || error instanceof EngineServerError);
        if (!retry) throw error;
        await sleep(retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  async function once<S extends z.ZodType>(
    schema: S,
    c: Call,
    route: string,
  ): Promise<z.output<S>> {
    const url = new URL(baseUrl + c.path);
    for (const [k, v] of Object.entries(c.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (c.body !== undefined) headers['content-type'] = 'application/json';
    if (c.auth !== false && token) headers.authorization = `Bearer ${token}`;

    let res: Response;
    let text: string;
    try {
      res = await doFetch(url, {
        method: c.method,
        headers,
        body: c.body === undefined ? undefined : JSON.stringify(c.body),
        signal: AbortSignal.timeout(c.timeoutMs ?? timeoutMs),
      });
      text = await res.text();
    } catch (cause) {
      const timedOut = cause instanceof DOMException && cause.name === 'TimeoutError';
      throw new EngineUnavailableError(
        timedOut ? 'timeout' : 'unreachable',
        timedOut ? 'Engine timed out' : 'Engine unreachable',
        { stationId, route, cause },
      );
    }

    if (!res.ok) throw httpError(res.status, text, route);

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new EngineProtocolError('invalid_response', 'Engine answered invalid JSON', {
        stationId,
        route,
        status: res.status,
        cause,
      });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new EngineProtocolError(
        'invalid_response',
        `Unexpected engine answer: ${z.prettifyError(parsed.error)}`,
        { stationId, route, status: res.status, cause: parsed.error },
      );
    }
    return parsed.data;
  }

  function httpError(status: number, text: string, route: string): EngineError {
    let message = text.slice(0, 500) || `HTTP ${status}`;
    try {
      message = engineErrorSchema.parse(JSON.parse(text)).error;
    } catch {}
    const details = { stationId, route, status };
    switch (status) {
      case 400:
        return new EngineBadRequestError('bad_request', message, details);
      case 401:
        return new EngineUnauthorizedError('unauthorized', message, details);
      case 404:
        return new EngineNotQueuedError('not_queued', message, details);
      case 409:
        return new EngineConflictError('conflict', message, details);
      case 422:
        return new EngineUnresolvableError('unresolvable', message, details);
      default:
        return new EngineServerError('engine_error', message, details);
    }
  }

  /** Validates a command before it leaves, so a bad call never reaches the engine. */
  function command<S extends z.ZodType>(schema: S, value: unknown, route: string): z.output<S> {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new EngineBadRequestError('bad_request', z.prettifyError(parsed.error), {
      stationId,
      route,
      cause: parsed.error,
    });
  }

  return {
    stationId,

    health: () =>
      call(engineHealthSchema, {
        method: 'GET',
        path: ENGINE_ROUTES.health,
        auth: false,
        repeatable: true,
      }),

    async state() {
      const state = await call(engineStateSchema, {
        method: 'GET',
        path: ENGINE_ROUTES.state,
        repeatable: true,
      });
      if (state.station_id !== stationId) {
        throw new EngineProtocolError(
          'invalid_response',
          `Engine belongs to station ${state.station_id}`,
          { stationId, route: `GET ${ENGINE_ROUTES.state}` },
        );
      }
      return state;
    },

    events: (after) =>
      call(engineEventBatchSchema, {
        method: 'GET',
        path: ENGINE_ROUTES.events,
        query: { after: String(Math.max(0, Math.trunc(after))) },
        repeatable: true,
      }),

    push: async (item) =>
      call(engineQueuedRequestSchema, {
        method: 'POST',
        path: ENGINE_ROUTES.queue,
        body: command(enginePushItemSchema, item, `POST ${ENGINE_ROUTES.queue}`),
        timeoutMs: pushTimeoutMs,
      }),

    pushSegment: async (segment) =>
      call(enginePushSegmentResultSchema, {
        method: 'POST',
        path: ENGINE_ROUTES.segment,
        body: command(enginePushSegmentSchema, segment, `POST ${ENGINE_ROUTES.segment}`),
        // Every part is resolved before the engine answers.
        timeoutMs: pushTimeoutMs * Math.max(1, segment.parts?.length ?? 1),
      }),

    remove: async (id) =>
      call(engineRemoveResultSchema, {
        method: 'DELETE',
        path: `${ENGINE_ROUTES.queue}/${encodeURIComponent(
          command(z.string().min(1).max(128), id, `DELETE ${ENGINE_ROUTES.queue}/:id`),
        )}`,
      }),

    clear: () =>
      call(engineRemoveResultSchema, {
        method: 'DELETE',
        path: ENGINE_ROUTES.queue,
        repeatable: true,
      }),

    async skip() {
      await call(engineSkipResultSchema, { method: 'POST', path: ENGINE_ROUTES.skip });
    },

    async setLive(enabled, options = {}) {
      const body = command(
        engineLiveGateSchema,
        { enabled, input: options.input, session_id: options.sessionId },
        `POST ${ENGINE_ROUTES.live}`,
      );
      // The engine echoes the gate (selected input, session); nothing to read back here.
      await call(z.unknown(), { method: 'POST', path: ENGINE_ROUTES.live, body, repeatable: true });
    },

    async disconnectLive(input) {
      const { disconnected } = await call(engineLiveDisconnectResultSchema, {
        method: 'POST',
        path: ENGINE_ROUTES.liveDisconnect,
        body: command(
          engineLiveDisconnectSchema,
          { input },
          `POST ${ENGINE_ROUTES.liveDisconnect}`,
        ),
        // Hanging up twice is harmless.
        repeatable: true,
      });
      return disconnected;
    },

    async listen(input, signal) {
      const n = command(z.int().min(1).max(16), input, 'GET /prelisten/:input');
      const route = `GET /prelisten/${n}`;
      const answered = AbortSignal.timeout(timeoutMs);
      const both = signal ? AbortSignal.any([signal, answered]) : answered;
      const headers: Record<string, string> = {};
      if (token) headers.authorization = `Basic ${btoa(`ondes:${token}`)}`;
      let res: Response;
      try {
        // Only the headers are timed: once they're in, the stream runs until `signal` aborts.
        const controller = new AbortController();
        const abort = () => controller.abort(both.reason);
        both.addEventListener('abort', abort, { once: true });
        res = await doFetch(new URL(`${baseUrl}/prelisten/${n}`), {
          headers,
          signal: controller.signal,
        });
        both.removeEventListener('abort', abort);
        signal?.addEventListener('abort', abort, { once: true });
      } catch (cause) {
        if (signal?.aborted) throw cause;
        throw new EngineUnavailableError('unreachable', 'Engine unreachable', {
          stationId,
          route,
          cause,
        });
      }
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) throw httpError(res.status, await res.text(), route);
      return res;
    },
  };
}
