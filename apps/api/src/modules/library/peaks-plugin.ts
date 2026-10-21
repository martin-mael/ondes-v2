import { type PeaksJobPayload, peaksRepairIdempotencyKey, uuidSchema } from '@ondes/shared';
import type { Storage } from '@ondes/storage';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { stationScopeOf } from '../../plugins/auth.ts';
import { getAssetPeaks, type PeaksDeps, peaksJob } from './peaks-service.ts';
import { toErrorResult } from './routes.ts';

// `GET /api/v1/stations/:stationId/assets/:assetId/peaks` (#22), behind
// `requirePermission('library', 'read')`. See peaks-service.ts.

export interface PeaksPluginOptions {
  storage: Storage;
  /** Overrides the RabbitMQ publisher of repair jobs (tests). Default: `app.rabbit.jobs`. */
  enqueueRepair?: (payload: PeaksJobPayload) => Promise<void>;
}

const paramsSchema = z.object({ assetId: uuidSchema });

/** Mounts the peaks route. Registered by `buildApp` when it has a `storage`. */
export async function peaksPlugin(app: FastifyInstance, options: PeaksPluginOptions) {
  const deps: PeaksDeps = {
    db: app.db,
    storage: options.storage,
    enqueueRepair:
      options.enqueueRepair ??
      (async (payload) => {
        // Without RabbitMQ (some tests), a missing file stays a 404.
        if (!app.hasDecorator('rabbit')) return;
        await app.rabbit.jobs.enqueue(peaksJob, payload, {
          idempotencyKey: peaksRepairIdempotencyKey(payload, new Date()),
          orgId: payload.orgId,
          stationId: payload.stationId,
        });
      }),
  };
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
