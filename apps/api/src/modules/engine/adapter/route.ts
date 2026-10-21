import { timingSafeEqual } from 'node:crypto';
import { engineEventBatchSchema } from '@ondes/shared';
import { z } from 'zod';
import { type EngineEventIngest, EngineStationMismatchError } from './ingest.ts';
import { type Logger, silentLogger } from './logger.ts';

/**
 * The internal route the engine POSTs its events to (`ENGINE_EVENTS_URL`). Internal only:
 * it must be reachable from the station's Docker network and never through the public
 * reverse proxy.
 *
 * Written as a framework-free handler plus a registration function, because the Fastify
 * server (#6) lands in parallel: `registerEngineEventRoutes(app, ...)` works with any
 * router exposing `post(path, handler)` with Fastify's `(request, reply)` shape.
 *
 * Status codes drive the engine's redelivery: it retries anything but a 2xx with backoff,
 * so 503 (we couldn't publish) means "send it again", and a 4xx is a wiring bug it will
 * keep retrying while we log it.
 */
export const ENGINE_EVENTS_ROUTE = '/internal/engine/stations/:stationId/events';

/** `ENGINE_EVENTS_URL` for a station's engine, given the api's internal base URL. */
export function engineEventsUrl(internalBaseUrl: string, stationId: string): string {
  return (
    internalBaseUrl.replace(/\/+$/, '') +
    ENGINE_EVENTS_ROUTE.replace(':stationId', encodeURIComponent(stationId))
  );
}

export type EngineEventsRequest = {
  stationId: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};

export type EngineEventsResponse = { status: number; body: Record<string, unknown> };

export type EngineEventsHandlerOptions = {
  /** The station's ingest, or undefined if the station has no engine here. */
  ingestFor(stationId: string): EngineEventIngest | undefined;
  /**
   * If set, require `Authorization: Bearer <token>` on event posts. Leave unset until the
   * station template sends it (the spike's template doesn't).
   */
  token?: string;
  logger?: Logger;
};

export function createEngineEventsHandler(
  options: EngineEventsHandlerOptions,
): (request: EngineEventsRequest) => Promise<EngineEventsResponse> {
  const logger = options.logger ?? silentLogger;
  const expected = options.token ? Buffer.from(`Bearer ${options.token}`) : null;

  return async ({ stationId, headers, body }) => {
    if (expected) {
      const given = Buffer.from(String(headers.authorization ?? ''));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return { status: 401, body: { error: 'unauthorized' } };
      }
    }
    const ingest = options.ingestFor(stationId);
    if (!ingest) {
      logger.warn({ stationId }, 'Engine events for an unknown station');
      return { status: 404, body: { error: `no engine for station ${stationId}` } };
    }
    const parsed = engineEventBatchSchema.safeParse(body);
    if (!parsed.success) {
      logger.error(
        { stationId, issues: parsed.error.issues },
        'Engine posted events that break the contract',
      );
      return { status: 400, body: { error: z.prettifyError(parsed.error) } };
    }
    try {
      const result = await ingest.receive(parsed.data);
      return { status: 200, body: { ...result } };
    } catch (error) {
      if (error instanceof EngineStationMismatchError) {
        logger.error({ stationId, err: error }, 'Engine events posted to the wrong station');
        return { status: 409, body: { error: error.message } };
      }
      logger.warn({ stationId, err: error }, 'Engine events not ingested, engine will retry');
      return { status: 503, body: { error: 'events not ingested, retry' } };
    }
  };
}

/** The part of a Fastify instance this needs. */
export type EngineEventsRouter = {
  post(
    path: string,
    handler: (
      request: { params: unknown; headers: EngineEventsRequest['headers']; body: unknown },
      reply: { code(status: number): unknown },
    ) => Promise<unknown>,
  ): unknown;
};

export function registerEngineEventRoutes(
  app: EngineEventsRouter,
  options: EngineEventsHandlerOptions,
): void {
  const handle = createEngineEventsHandler(options);
  const params = z.object({ stationId: z.string().min(1) });
  app.post(ENGINE_EVENTS_ROUTE, async (request, reply) => {
    const { stationId } = params.parse(request.params);
    const res = await handle({ stationId, headers: request.headers, body: request.body });
    reply.code(res.status);
    return res.body;
  });
}
