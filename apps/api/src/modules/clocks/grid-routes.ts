import {
  clockGridSchema,
  createDaypartSchema,
  createGridOverrideSchema,
  daypartSchema,
  gridHoursQuerySchema,
  gridHoursSchema,
  gridOverrideSchema,
  updateClockGridSchema,
  updateDaypartSchema,
  updateGridOverrideSchema,
  uuidSchema,
} from '@ondes/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, stationScopeOf } from '../../plugins/auth.ts';
import * as repo from './grid-repo.ts';

// Weekly clock grid API (#40), under /api/v1/stations/:stationId/clock-grid, registered by
// the clocks routes. Same permissions as clocks: reads `clock:read`, edits `clock:write`;
// every edit writes an audit row.

const stationParams = z.object({ stationId: z.string() });
const daypartParams = stationParams.extend({ daypartId: uuidSchema });
const overrideParams = stationParams.extend({ overrideId: uuidSchema });

export async function clockGridRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = app.requirePermission('clock', 'read');
  const write = app.requirePermission('clock', 'write');
  const ctx = (request: FastifyRequest) => ({
    actor: actorOf(request),
    scope: stationScopeOf(request),
  });

  r.get(
    '/stations/:stationId/clock-grid',
    { preHandler: read, schema: { params: stationParams, response: { 200: clockGridSchema } } },
    (request) => repo.getClockGrid(app.db, stationScopeOf(request)),
  );

  r.put(
    '/stations/:stationId/clock-grid',
    {
      preHandler: write,
      schema: {
        params: stationParams,
        body: updateClockGridSchema,
        response: { 200: clockGridSchema },
      },
    },
    (request) => repo.updateClockGrid(app.db, ctx(request), request.body),
  );

  r.get(
    '/stations/:stationId/clock-grid/hours',
    {
      preHandler: read,
      schema: {
        params: stationParams,
        querystring: gridHoursQuerySchema,
        response: { 200: gridHoursSchema },
      },
    },
    (request) => repo.gridHours(app.db, stationScopeOf(request), request.query),
  );

  r.post(
    '/stations/:stationId/clock-grid/dayparts',
    {
      preHandler: write,
      schema: {
        params: stationParams,
        body: createDaypartSchema,
        response: { 201: daypartSchema },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await repo.createDaypart(app.db, ctx(request), request.body)),
  );

  r.patch(
    '/stations/:stationId/clock-grid/dayparts/:daypartId',
    {
      preHandler: write,
      schema: {
        params: daypartParams,
        body: updateDaypartSchema,
        response: { 200: daypartSchema },
      },
    },
    (request) => repo.updateDaypart(app.db, ctx(request), request.params.daypartId, request.body),
  );

  r.delete(
    '/stations/:stationId/clock-grid/dayparts/:daypartId',
    { preHandler: write, schema: { params: daypartParams } },
    async (request, reply) => {
      await repo.deleteDaypart(app.db, ctx(request), request.params.daypartId);
      return reply.code(204).send();
    },
  );

  r.post(
    '/stations/:stationId/clock-grid/overrides',
    {
      preHandler: write,
      schema: {
        params: stationParams,
        body: createGridOverrideSchema,
        response: { 201: gridOverrideSchema },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await repo.createGridOverride(app.db, ctx(request), request.body)),
  );

  r.patch(
    '/stations/:stationId/clock-grid/overrides/:overrideId',
    {
      preHandler: write,
      schema: {
        params: overrideParams,
        body: updateGridOverrideSchema,
        response: { 200: gridOverrideSchema },
      },
    },
    (request) =>
      repo.updateGridOverride(app.db, ctx(request), request.params.overrideId, request.body),
  );

  r.delete(
    '/stations/:stationId/clock-grid/overrides/:overrideId',
    { preHandler: write, schema: { params: overrideParams } },
    async (request, reply) => {
      await repo.deleteGridOverride(app.db, ctx(request), request.params.overrideId);
      return reply.code(204).send();
    },
  );
}
