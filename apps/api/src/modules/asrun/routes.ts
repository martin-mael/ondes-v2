import { asRunListSchema, listAsRunQuerySchema, uuidSchema } from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { stationScopeOf } from '../../plugins/auth.ts';
import * as repo from './repo.ts';

// As-run API (#30), under /api/v1/stations/:stationId/…
//   GET /asrun?from&to | ?date   log:read   what aired, paginated (`cursor`)

const stationParams = z.object({ stationId: uuidSchema });

export async function asRunRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = app.requirePermission('log', 'read');

  r.get(
    '/stations/:stationId/asrun',
    {
      preHandler: read,
      schema: {
        params: stationParams,
        querystring: listAsRunQuerySchema,
        response: { 200: asRunListSchema },
      },
    },
    async (request) => repo.listAsRun(app.db, stationScopeOf(request), request.query),
  );
}
