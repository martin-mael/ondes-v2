import type { JobPublisher } from '@ondes/queue';
import {
  createPromoSchema,
  createVtPoolSchema,
  listPromosQuerySchema,
  promoListSchema,
  promoPlaysQuerySchema,
  promoPlaysSchema,
  promoSchema,
  updatePromoSchema,
  updateVtPoolSchema,
  uuidSchema,
  vtPoolListSchema,
  vtPoolSchema,
} from '@ondes/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, stationScopeOf } from '../../plugins/auth.ts';
import type { EventSink } from '../segues/events.ts';
import { retirePlacements, syncPromoPlacements } from './placements.ts';
import * as repo from './repo.ts';

// Promo VTs and VT pools (#60), under /api/v1/stations/:stationId/{promos,vt-pools}. Reads need
// `voice_track:read`, edits `voice_track:write`; every edit writes an audit row. A promo edit
// (pools included) re-checks its coming placements right away: one that can't air any more
// (disabled, expired, out of the pool) is dropped and its generated segue deleted. Deleting a
// promo or a pool retires its coming placements first.

const stationParams = z.object({ stationId: z.string() });
const poolParams = stationParams.extend({ poolId: uuidSchema });
const promoParams = stationParams.extend({ promoId: uuidSchema });

export type PromosRoutesOptions = {
  events?: EventSink | undefined;
  jobs?: JobPublisher | undefined;
};

export async function promosRoutes(app: FastifyInstance, options: PromosRoutesOptions) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = app.requirePermission('voice_track', 'read');
  const write = app.requirePermission('voice_track', 'write');
  const ctx = (request: FastifyRequest) => ({
    actor: actorOf(request),
    scope: stationScopeOf(request),
  });
  const deps = (request: FastifyRequest) => ({
    db: app.db,
    events: options.events,
    jobs: options.jobs,
    logger: request.log,
  });

  // --- Pools -------------------------------------------------------------------------------

  r.get(
    '/stations/:stationId/vt-pools',
    { preHandler: read, schema: { params: stationParams, response: { 200: vtPoolListSchema } } },
    async (request) => ({ items: await repo.listPools(app.db, stationScopeOf(request)) }),
  );

  r.post(
    '/stations/:stationId/vt-pools',
    {
      preHandler: write,
      schema: { params: stationParams, body: createVtPoolSchema, response: { 201: vtPoolSchema } },
    },
    async (request, reply) =>
      reply.code(201).send(await repo.createPool(app.db, ctx(request), request.body)),
  );

  r.patch(
    '/stations/:stationId/vt-pools/:poolId',
    {
      preHandler: write,
      schema: { params: poolParams, body: updateVtPoolSchema, response: { 200: vtPoolSchema } },
    },
    (request) => repo.updatePool(app.db, ctx(request), request.params.poolId, request.body),
  );

  r.delete(
    '/stations/:stationId/vt-pools/:poolId',
    { preHandler: write, schema: { params: poolParams } },
    async (request, reply) => {
      const c = ctx(request);
      // 404 before touching placements; then nothing of the pool is left to air.
      await repo.getPool(app.db, c.scope, request.params.poolId);
      await retirePlacements(deps(request), c.scope, { poolId: request.params.poolId });
      await repo.deletePool(app.db, c, request.params.poolId);
      return reply.code(204).send();
    },
  );

  // --- Promos ------------------------------------------------------------------------------

  r.get(
    '/stations/:stationId/promos',
    {
      preHandler: read,
      schema: {
        params: stationParams,
        querystring: listPromosQuerySchema,
        response: { 200: promoListSchema },
      },
    },
    async (request) => ({
      items: await repo.listPromos(app.db, stationScopeOf(request), request.query),
    }),
  );

  r.post(
    '/stations/:stationId/promos',
    {
      preHandler: write,
      schema: { params: stationParams, body: createPromoSchema, response: { 201: promoSchema } },
    },
    async (request, reply) =>
      reply.code(201).send(await repo.createPromo(app.db, ctx(request), request.body)),
  );

  r.get(
    '/stations/:stationId/promos/:promoId',
    { preHandler: read, schema: { params: promoParams, response: { 200: promoSchema } } },
    (request) => repo.getPromo(app.db, stationScopeOf(request), request.params.promoId),
  );

  r.get(
    '/stations/:stationId/promos/:promoId/plays',
    {
      preHandler: read,
      schema: {
        params: promoParams,
        querystring: promoPlaysQuerySchema,
        response: { 200: promoPlaysSchema },
      },
    },
    (request) =>
      repo.promoPlays(app.db, stationScopeOf(request), request.params.promoId, request.query),
  );

  r.patch(
    '/stations/:stationId/promos/:promoId',
    {
      preHandler: write,
      schema: { params: promoParams, body: updatePromoSchema, response: { 200: promoSchema } },
    },
    async (request) => {
      const c = ctx(request);
      await repo.updatePromo(app.db, c, request.params.promoId, request.body);
      await syncPromoPlacements(deps(request), c.scope, { promoId: request.params.promoId });
      // Read after the re-check: its planned count reflects what was dropped.
      return repo.getPromo(app.db, c.scope, request.params.promoId);
    },
  );

  r.delete(
    '/stations/:stationId/promos/:promoId',
    { preHandler: write, schema: { params: promoParams } },
    async (request, reply) => {
      const c = ctx(request);
      // 404 before touching placements.
      await repo.getPromo(app.db, c.scope, request.params.promoId);
      await retirePlacements(deps(request), c.scope, { promoId: request.params.promoId });
      await repo.deletePromo(app.db, c, request.params.promoId);
      return reply.code(204).send();
    },
  );
}
