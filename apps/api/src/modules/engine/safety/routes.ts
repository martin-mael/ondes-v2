import {
  addSafetyAssetsSchema,
  safetyStatusSchema,
  setEmergencyAssetSchema,
  setSafetyAssetsSchema,
} from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, stationScopeOf } from '../../../plugins/auth.ts';
import type { SafetyService } from './service.ts';

const stationParams = z.object({ stationId: z.string() });
const assetParams = stationParams.extend({ assetId: z.string() });

/**
 * Safety playlist and emergency file (#34), under `/stations/:stationId/safety`. Reading needs
 * `engine:read`, changing them `engine:control` (station managers, org owners and admins).
 */
export async function safetyRoutes(app: FastifyInstance, options: { safety: SafetyService }) {
  const { safety } = options;
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = app.requirePermission('engine', 'read');
  const control = app.requirePermission('engine', 'control');
  const ok = { response: { 200: safetyStatusSchema } };

  r.get(
    '/stations/:stationId/safety',
    { preHandler: read, schema: { params: stationParams, ...ok } },
    async (request) => safety.status(stationScopeOf(request)),
  );

  r.put(
    '/stations/:stationId/safety/assets',
    { preHandler: control, schema: { params: stationParams, body: setSafetyAssetsSchema, ...ok } },
    async (request) => safety.setAssets(stationScopeOf(request), actorOf(request), request.body),
  );

  r.post(
    '/stations/:stationId/safety/assets',
    { preHandler: control, schema: { params: stationParams, body: addSafetyAssetsSchema, ...ok } },
    async (request) => safety.addAssets(stationScopeOf(request), actorOf(request), request.body),
  );

  r.delete(
    '/stations/:stationId/safety/assets/:assetId',
    { preHandler: control, schema: { params: assetParams } },
    async (request, reply) => {
      await safety.removeAsset(stationScopeOf(request), actorOf(request), request.params.assetId);
      return reply.code(204).send();
    },
  );

  r.put(
    '/stations/:stationId/safety/emergency',
    {
      preHandler: control,
      schema: { params: stationParams, body: setEmergencyAssetSchema, ...ok },
    },
    async (request) => safety.setEmergency(stationScopeOf(request), actorOf(request), request.body),
  );
}
