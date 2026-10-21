import { cacheReadinessQuerySchema, cacheStatusSchema } from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { stationScopeOf } from '../../plugins/auth.ts';

const stationParams = z.object({ stationId: z.string() });

/** `GET /stations/:stationId/cache?hours=48`: the station's cache for the dashboard. */
export async function cacheRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/stations/:stationId/cache',
    {
      preHandler: app.requirePermission('engine', 'read'),
      schema: {
        params: stationParams,
        querystring: cacheReadinessQuerySchema,
        response: { 200: cacheStatusSchema },
      },
    },
    async (request) =>
      app.playoutCache.status(stationScopeOf(request), {
        windowMs: request.query.hours * 3_600_000,
      }),
  );
}
