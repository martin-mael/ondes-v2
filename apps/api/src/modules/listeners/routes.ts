import {
  currentListenersSchema,
  listenerHistoryQuerySchema,
  listenerHistorySchema,
  uuidSchema,
} from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { stationScopeOf } from '../../plugins/auth.ts';
import * as repo from './repo.ts';

// Listener counts for the dashboard (#71), under /api/v1/stations/:stationId/…
//   GET /listeners                  dashboard:read  per mount, now
//   GET /listeners/history?hours=   dashboard:read  average per step, default 24 h

const stationParams = z.object({ stationId: uuidSchema });

export async function listenerRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = app.requirePermission('dashboard', 'read');

  r.get(
    '/stations/:stationId/listeners',
    {
      preHandler: read,
      schema: { params: stationParams, response: { 200: currentListenersSchema } },
    },
    async (request) => repo.currentListeners(app.db, stationScopeOf(request)),
  );

  r.get(
    '/stations/:stationId/listeners/history',
    {
      preHandler: read,
      schema: {
        params: stationParams,
        querystring: listenerHistoryQuerySchema,
        response: { 200: listenerHistorySchema },
      },
    },
    async (request) =>
      repo.listenerHistory(app.db, stationScopeOf(request), request.query.hours),
  );
}
