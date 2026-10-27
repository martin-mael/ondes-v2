import { onAirSchema, uuidSchema } from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { stationScopeOf } from '../../plugins/auth.ts';
import { readOnAir } from './service.ts';

// On air (#70), under /api/v1/stations/:stationId/…
//   GET /on-air   dashboard:read   what is on air, what comes next, the show block (ADR 0034)
// Internal: the public now-playing API is #74.

const stationParams = z.object({ stationId: uuidSchema });

export async function onAirRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/stations/:stationId/on-air',
    {
      preHandler: app.requirePermission('dashboard', 'read'),
      schema: { params: stationParams, response: { 200: onAirSchema } },
    },
    async (request) => readOnAir(app.db, stationScopeOf(request)),
  );
}
