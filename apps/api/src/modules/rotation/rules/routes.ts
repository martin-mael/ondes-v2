import {
  pickRequestSchema,
  pickResponseSchema,
  rotationRulesSettingsSchema,
  updateRotationRulesSchema,
} from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, stationScopeOf } from '../../../plugins/auth.ts';
import * as repo from './repo.ts';

// Rotation rules API (#38), under /api/v1/stations/:stationId/rotation. Reads and picks need
// `rotation:read`, edits `rotation:write` (audited as `rotation_rules.update`).

const stationParams = z.object({ stationId: z.string() });

export async function rotationRulesRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = app.requirePermission('rotation', 'read');
  const write = app.requirePermission('rotation', 'write');

  r.get(
    '/stations/:stationId/rotation/rules',
    {
      preHandler: read,
      schema: { params: stationParams, response: { 200: rotationRulesSettingsSchema } },
    },
    (request) => repo.getRules(app.db, stationScopeOf(request)),
  );

  r.put(
    '/stations/:stationId/rotation/rules',
    {
      preHandler: write,
      schema: {
        params: stationParams,
        body: updateRotationRulesSchema,
        response: { 200: rotationRulesSettingsSchema },
      },
    },
    (request) =>
      repo.updateRules(
        app.db,
        { actor: actorOf(request), scope: stationScopeOf(request) },
        request.body,
      ),
  );

  // Reads only (a dry run): `rotation:read` is enough.
  r.post(
    '/stations/:stationId/rotation/pick',
    {
      preHandler: read,
      schema: {
        params: stationParams,
        body: pickRequestSchema,
        response: { 200: pickResponseSchema },
      },
    },
    (request) => repo.pickSlots(app.db, stationScopeOf(request), request.body),
  );
}
