import { uuidSchema } from '@ondes/shared';
import type { Storage } from '@ondes/storage';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { stationScopeOf } from '../../plugins/auth.ts';
import { getAssetPeaks } from './peaks-service.ts';
import { toErrorResult } from './routes.ts';

// `GET /api/v1/stations/:stationId/assets/:assetId/peaks` (#22), behind
// `requirePermission('library', 'read')`. See peaks-service.ts.

export interface PeaksPluginOptions {
  storage: Storage;
}

const paramsSchema = z.object({ assetId: uuidSchema });

/** Mounts the peaks route. Registered by `buildApp` when it has a `storage`. */
export async function peaksPlugin(app: FastifyInstance, options: PeaksPluginOptions) {
  const deps = { db: app.db, storage: options.storage };
  app.get('/api/v1/stations/:stationId/assets/:assetId/peaks', {
    preHandler: app.requirePermission('library', 'read'),
    handler: async (request, reply) => {
      let result: Awaited<ReturnType<typeof getAssetPeaks>>;
      try {
        const { assetId } = paramsSchema.parse(request.params);
        result = await getAssetPeaks(deps, stationScopeOf(request), assetId, {
          query: request.query,
          ifNoneMatch: request.headers['if-none-match'],
        });
      } catch (error) {
        const mapped = toErrorResult(error);
        return reply.code(mapped.status).send(mapped.body);
      }
      if (result.status === 404) return reply.code(404).send(result.body);
      reply.headers(result.headers);
      if (result.status === 304) return reply.code(304).send();
      return reply.code(200).send(result.body);
    },
  });
}
