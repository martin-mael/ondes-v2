import {
  clockDetailSchema,
  clockEstimateSchema,
  clockListSchema,
  clockPreviewQuerySchema,
  clockPreviewSchema,
  createClockSchema,
  draftClockEstimateSchema,
  draftClockPreviewSchema,
  duplicateClockSchema,
  updateClockSchema,
  uuidSchema,
} from '@ondes/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, stationScopeOf } from '../../plugins/auth.ts';
import { clockGridRoutes } from './grid-routes.ts';
import * as repo from './repo.ts';

// Clocks API (#39), under /api/v1/stations/:stationId/clocks. Reads (estimates and previews
// included) need `clock:read`, edits `clock:write`; every edit writes an audit row. Previews
// pick with #38's rules engine when this build has it (preview.ts), at random otherwise. The
// weekly grid (#40) lives under …/clock-grid (grid-routes.ts).

const stationParams = z.object({ stationId: z.string() });
const clockParams = stationParams.extend({ clockId: uuidSchema });

export async function clocksRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = app.requirePermission('clock', 'read');
  const write = app.requirePermission('clock', 'write');
  const ctx = (request: FastifyRequest) => ({
    actor: actorOf(request),
    scope: stationScopeOf(request),
  });

  r.get(
    '/stations/:stationId/clocks',
    { preHandler: read, schema: { params: stationParams, response: { 200: clockListSchema } } },
    (request) => repo.listClocks(app.db, stationScopeOf(request)),
  );

  r.post(
    '/stations/:stationId/clocks',
    {
      preHandler: write,
      schema: {
        params: stationParams,
        body: createClockSchema,
        response: { 201: clockDetailSchema },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await repo.createClock(app.db, ctx(request), request.body)),
  );

  // Drafts: reads only, so `clock:read` is enough.
  r.post(
    '/stations/:stationId/clocks/estimate',
    {
      preHandler: read,
      schema: {
        params: stationParams,
        body: draftClockEstimateSchema,
        response: { 200: clockEstimateSchema },
      },
    },
    (request) => repo.estimateDraft(app.db, stationScopeOf(request), request.body),
  );

  r.post(
    '/stations/:stationId/clocks/preview',
    {
      preHandler: read,
      schema: {
        params: stationParams,
        body: draftClockPreviewSchema,
        response: { 200: clockPreviewSchema },
      },
    },
    (request) => repo.previewDraft(app.db, stationScopeOf(request), request.body),
  );

  r.get(
    '/stations/:stationId/clocks/:clockId',
    { preHandler: read, schema: { params: clockParams, response: { 200: clockDetailSchema } } },
    (request) => repo.getClock(app.db, stationScopeOf(request), request.params.clockId),
  );

  r.get(
    '/stations/:stationId/clocks/:clockId/preview',
    {
      preHandler: read,
      schema: {
        params: clockParams,
        querystring: clockPreviewQuerySchema,
        response: { 200: clockPreviewSchema },
      },
    },
    (request) =>
      repo.previewClock(app.db, stationScopeOf(request), request.params.clockId, request.query),
  );

  r.patch(
    '/stations/:stationId/clocks/:clockId',
    {
      preHandler: write,
      schema: {
        params: clockParams,
        body: updateClockSchema,
        response: { 200: clockDetailSchema },
      },
    },
    (request) => repo.updateClock(app.db, ctx(request), request.params.clockId, request.body),
  );

  r.post(
    '/stations/:stationId/clocks/:clockId/duplicate',
    {
      preHandler: write,
      schema: {
        params: clockParams,
        body: duplicateClockSchema,
        response: { 201: clockDetailSchema },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await repo.duplicateClock(app.db, ctx(request), request.params.clockId, request.body),
        ),
  );

  r.delete(
    '/stations/:stationId/clocks/:clockId',
    { preHandler: write, schema: { params: clockParams } },
    async (request, reply) => {
      await repo.deleteClock(app.db, ctx(request), request.params.clockId);
      return reply.code(204).send();
    },
  );

  await clockGridRoutes(app);
}
