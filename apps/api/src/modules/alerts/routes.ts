import {
  alertListSchema,
  alertSchema,
  listAlertsQuerySchema,
  silenceSettingsSchema,
  updateSilenceSettingsSchema,
  uuidSchema,
} from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, stationScopeOf } from '../../plugins/auth.ts';
import { HttpError } from '../../plugins/errors.ts';
import * as repo from './repo.ts';

// Alerts API (#33), under /api/v1/stations/:stationId/…
//   GET  /alerts                       alert:read    list (open by default, newest first)
//   GET  /alerts/:alertId              alert:read
//   POST /alerts/:alertId/acknowledge  alert:manage  idempotent; 409 once resolved
//   POST /alerts/:alertId/resolve      alert:manage  close by hand; 409 if already resolved
//   GET  /silence-settings             alert:read
//   PATCH /silence-settings            alert:manage

const stationParams = z.object({ stationId: uuidSchema });
const alertParams = stationParams.extend({ alertId: uuidSchema });

export async function alertRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = app.requirePermission('alert', 'read');
  const manage = app.requirePermission('alert', 'manage');

  r.get(
    '/stations/:stationId/alerts',
    {
      preHandler: read,
      schema: {
        params: stationParams,
        querystring: listAlertsQuerySchema,
        response: { 200: alertListSchema },
      },
    },
    async (request) => repo.listAlerts(app.db, stationScopeOf(request), request.query),
  );

  r.get(
    '/stations/:stationId/alerts/:alertId',
    { preHandler: read, schema: { params: alertParams, response: { 200: alertSchema } } },
    async (request) => repo.getAlert(app.db, stationScopeOf(request), request.params.alertId),
  );

  r.post(
    '/stations/:stationId/alerts/:alertId/acknowledge',
    { preHandler: manage, schema: { params: alertParams, response: { 200: alertSchema } } },
    async (request) => {
      const scope = stationScopeOf(request);
      const { alertId } = request.params;
      const current = await repo.getAlert(app.db, scope, alertId);
      if (current.status === 'resolved') {
        throw new HttpError(409, 'alert_resolved', 'the alert is already resolved');
      }
      if (current.acknowledgedAt) return current;
      return (
        (await app.alerts.acknowledge(scope, actorOf(request), alertId)) ??
        repo.getAlert(app.db, scope, alertId)
      );
    },
  );

  r.post(
    '/stations/:stationId/alerts/:alertId/resolve',
    { preHandler: manage, schema: { params: alertParams, response: { 200: alertSchema } } },
    async (request) => {
      const scope = stationScopeOf(request);
      const resolved = await app.alerts.resolveById(
        scope,
        actorOf(request),
        request.params.alertId,
      );
      if (resolved) return resolved;
      // Either not this station's (404) or already resolved (409).
      await repo.getAlert(app.db, scope, request.params.alertId);
      throw new HttpError(409, 'alert_resolved', 'the alert is already resolved');
    },
  );

  r.get(
    '/stations/:stationId/silence-settings',
    {
      preHandler: read,
      schema: { params: stationParams, response: { 200: silenceSettingsSchema } },
    },
    async (request) => repo.getSilenceSettings(app.db, stationScopeOf(request)),
  );

  r.patch(
    '/stations/:stationId/silence-settings',
    {
      preHandler: manage,
      schema: {
        params: stationParams,
        body: updateSilenceSettingsSchema,
        response: { 200: silenceSettingsSchema },
      },
    },
    async (request) =>
      app.alerts.updateSilenceSettings(stationScopeOf(request), actorOf(request), request.body),
  );
}
