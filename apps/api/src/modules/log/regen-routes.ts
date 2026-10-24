import { getRegenSettings, setRegenSettings } from '@ondes/db';
import {
  logRegenPreviewRequestSchema,
  logRegenPreviewResponseSchema,
  logRegenRequestSchema,
  logRegenResponseSchema,
  logRegenSettingsSchema,
} from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, stationScopeOf } from '../../plugins/auth.ts';
import { HttpError } from '../../plugins/errors.ts';
import { applyRegen, previewRegen, type RegenServiceDeps } from './regen-service.ts';

// Regeneration API (#101, ADR 0030), under /api/v1/stations/:stationId/log/regen:
// - `GET/PUT …/settings`: the horizon (days ahead, status of new days);
// - `POST …/preview`: the dry-run, a diff per day against the log as it is (nothing written);
// - `POST …`: regenerate the range (202, `log-generate` jobs; `log.updated` follows).

const stationParams = z.object({ stationId: z.string() });

export type RegenRoutesOptions = Omit<RegenServiceDeps, 'db'>;

export async function regenRoutes(app: FastifyInstance, options: RegenRoutesOptions) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = app.requirePermission('log', 'read');
  const write = app.requirePermission('log', 'write');
  const deps = (): RegenServiceDeps => ({ db: app.db, ...options });

  r.get(
    '/stations/:stationId/log/regen/settings',
    {
      preHandler: read,
      schema: { params: stationParams, response: { 200: logRegenSettingsSchema } },
    },
    (request) => getRegenSettings(app.db, stationScopeOf(request)),
  );

  r.put(
    '/stations/:stationId/log/regen/settings',
    {
      preHandler: write,
      schema: {
        params: stationParams,
        body: logRegenSettingsSchema,
        response: { 200: logRegenSettingsSchema },
      },
    },
    // A longer horizon is filled by the next sweep; existing days beyond a shorter one stay.
    (request) =>
      setRegenSettings(
        app.db,
        { actor: actorOf(request), scope: stationScopeOf(request) },
        request.body,
      ),
  );

  r.post(
    '/stations/:stationId/log/regen/preview',
    {
      preHandler: write,
      schema: {
        params: stationParams,
        body: logRegenPreviewRequestSchema,
        response: { 200: logRegenPreviewResponseSchema },
      },
    },
    (request) => previewRegen(deps(), stationScopeOf(request), request.body),
  );

  r.post(
    '/stations/:stationId/log/regen',
    {
      preHandler: write,
      schema: {
        params: stationParams,
        body: logRegenRequestSchema,
        response: { 202: logRegenResponseSchema },
      },
    },
    async (request, reply) => {
      if (!app.hasDecorator('rabbit')) {
        throw new HttpError(503, 'queue_unavailable', 'Regeneration needs the job queue');
      }
      const result = await applyRegen(
        { ...deps(), jobs: app.rabbit.jobs },
        { actor: actorOf(request), scope: stationScopeOf(request) },
        request.body,
      );
      return reply.code(202).send(result);
    },
  );
}
