import { randomUUID } from 'node:crypto';
import {
  insertLogItemSchema,
  lockLogItemSchema,
  logEditResultSchema,
  logNowQuerySchema,
  logNowResponseSchema,
  logRangeQuerySchema,
  logRangeResponseSchema,
  moveLogItemSchema,
  type RealtimeEvent,
  realtimeEventSchema,
  replaceLogItemSchema,
  uuidSchema,
} from '@ondes/shared';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, stationScopeOf } from '../../plugins/auth.ts';
import * as repo from './repo.ts';

// Log read and manual-edit API (#100), under /api/v1/stations/:stationId/log. No generation
// logic here: inserts, replacements, moves, deletes and locks, each audited, then published
// as `log.item.changed` + `log.updated` on the events fanout (when RabbitMQ is configured).

const stationParams = z.object({ stationId: z.string() });
const itemParams = stationParams.extend({ itemId: uuidSchema });

/** Where log events go. `app.rabbit.events` in the api; a test double elsewhere. */
export interface LogEventSink {
  publish(event: RealtimeEvent): Promise<void>;
}

/** Publishes an edit's events. The edit is committed already: a failed publish is only logged. */
export async function publishEdit(
  sink: LogEventSink | undefined,
  log: FastifyBaseLogger,
  stationId: string,
  outcome: repo.LogEditOutcome,
): Promise<void> {
  if (!sink) return;
  const at = new Date().toISOString();
  const events: RealtimeEvent[] = [
    {
      id: randomUUID(),
      stationId,
      at,
      type: 'log.item.changed',
      data: {
        itemId: outcome.itemId,
        logDayId: outcome.logDayId,
        change: outcome.change,
        item: outcome.result.item,
      },
    },
    {
      id: randomUUID(),
      stationId,
      at,
      type: 'log.updated',
      data: {
        from: outcome.range.from.toISOString(),
        to: outcome.range.to.toISOString(),
        days: outcome.result.days.map((d) => ({
          logDayId: d.id,
          localDate: d.localDate,
          version: d.version,
        })),
        cause: 'edit',
      },
    },
  ];
  for (const event of events) {
    try {
      await sink.publish(realtimeEventSchema.parse(event));
    } catch (error) {
      log.error({ err: error, type: event.type }, 'log event publish failed');
    }
  }
}

export async function logRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = app.requirePermission('log', 'read');
  const write = app.requirePermission('log', 'write');
  const sink = (): LogEventSink | undefined =>
    app.hasDecorator('rabbit') ? app.rabbit.events : undefined;
  const ctx = (request: FastifyRequest) => ({
    actor: actorOf(request),
    scope: stationScopeOf(request),
  });
  const published = async (request: FastifyRequest, outcome: repo.LogEditOutcome) => {
    await publishEdit(sink(), request.log, stationScopeOf(request).stationId, outcome);
    return outcome.result;
  };

  r.get(
    '/stations/:stationId/log',
    {
      preHandler: read,
      schema: {
        params: stationParams,
        querystring: logRangeQuerySchema,
        response: { 200: logRangeResponseSchema },
      },
    },
    (request) => repo.getLogRange(app.db, stationScopeOf(request), request.query),
  );

  r.get(
    '/stations/:stationId/log/now',
    {
      preHandler: read,
      schema: {
        params: stationParams,
        querystring: logNowQuerySchema,
        response: { 200: logNowResponseSchema },
      },
    },
    (request) => repo.getLogNow(app.db, stationScopeOf(request), request.query),
  );

  r.post(
    '/stations/:stationId/log/items',
    {
      preHandler: write,
      schema: {
        params: stationParams,
        body: insertLogItemSchema,
        response: { 201: logEditResultSchema },
      },
    },
    async (request, reply) => {
      const { placement, item } = request.body;
      const outcome = await repo.insertLogItem(app.db, ctx(request), placement, item);
      return reply.code(201).send(await published(request, outcome));
    },
  );

  r.put(
    '/stations/:stationId/log/items/:itemId',
    {
      preHandler: write,
      schema: {
        params: itemParams,
        body: replaceLogItemSchema,
        response: { 200: logEditResultSchema },
      },
    },
    async (request) =>
      published(
        request,
        await repo.replaceLogItem(app.db, ctx(request), request.params.itemId, request.body),
      ),
  );

  r.post(
    '/stations/:stationId/log/items/:itemId/move',
    {
      preHandler: write,
      schema: {
        params: itemParams,
        body: moveLogItemSchema,
        response: { 200: logEditResultSchema },
      },
    },
    async (request) =>
      published(
        request,
        await repo.moveLogItem(app.db, ctx(request), request.params.itemId, request.body.placement),
      ),
  );

  r.put(
    '/stations/:stationId/log/items/:itemId/lock',
    {
      preHandler: write,
      schema: {
        params: itemParams,
        body: lockLogItemSchema,
        response: { 200: logEditResultSchema },
      },
    },
    async (request) =>
      published(
        request,
        await repo.lockLogItem(app.db, ctx(request), request.params.itemId, request.body.locked),
      ),
  );

  r.delete(
    '/stations/:stationId/log/items/:itemId',
    {
      preHandler: write,
      schema: { params: itemParams, response: { 200: logEditResultSchema } },
    },
    async (request) =>
      published(request, await repo.deleteLogItem(app.db, ctx(request), request.params.itemId)),
  );
}
