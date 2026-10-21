import { listAssetFiles } from '@ondes/db';
import { uuidSchema } from '@ondes/shared';
import type { Storage } from '@ondes/storage';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { stationScopeOf } from '../../plugins/auth.ts';
import { toErrorResult } from './routes.ts';

// `GET /api/v1/stations/:stationId/assets/:assetId/audio` (#51): listen to an asset in the
// browser (timeline previews, cue editor). Answers a 302 to a short-lived presigned GET of the
// asset's playout copy (FLAC), behind `requirePermission('library', 'read')`, so an `<audio>`
// element can point at the api and the bytes come straight from storage (range requests
// included). 404 while the asset has no playout copy yet (ingest pending).

/** Seconds a preview URL stays valid. The browser re-requests the api route after that. */
export const AUDIO_URL_TTL_S = 15 * 60;

export interface AudioPluginOptions {
  storage: Storage;
}

const paramsSchema = z.object({ assetId: uuidSchema });

/** Mounts the audio route. Registered by `buildApp` when it has a `storage`. */
export async function audioPlugin(app: FastifyInstance, options: AudioPluginOptions) {
  app.get('/api/v1/stations/:stationId/assets/:assetId/audio', {
    preHandler: app.requirePermission('library', 'read'),
    handler: async (request, reply) => {
      try {
        const { assetId } = paramsSchema.parse(request.params);
        // Throws NotFoundError for an asset outside the station, like the other library routes.
        const files = await listAssetFiles(app.db, stationScopeOf(request), assetId);
        const playout = files.find((file) => file.role === 'playout');
        if (!playout) {
          return reply
            .code(404)
            .send({ error: 'not_found', message: `asset ${assetId} has no playout copy yet` });
        }
        const url = await options.storage.presignGet(playout.storageKey, {
          expiresIn: AUDIO_URL_TTL_S,
        });
        // The redirect itself must not outlive the URL it points to.
        reply.header('cache-control', `private, max-age=${AUDIO_URL_TTL_S - 60}`);
        return reply.redirect(url, 302);
      } catch (error) {
        const mapped = toErrorResult(error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  });
}
