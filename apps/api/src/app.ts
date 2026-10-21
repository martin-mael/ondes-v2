import { healthResponseSchema } from '@ondes/shared';
import type { Storage } from '@ondes/storage';
import Fastify, { type FastifyServerOptions } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { health } from './health.ts';
import { type AlertsPluginOptions, alertsPlugin } from './modules/alerts/plugin.ts';
import { type AsRunPluginOptions, asRunPlugin } from './modules/asrun/plugin.ts';
import { authRoutes } from './modules/auth/routes.ts';
import { type CachePluginOptions, cachePlugin } from './modules/cache/plugin.ts';
import {
  type EngineLifecyclePluginOptions,
  engineLifecyclePlugin,
} from './modules/engine/lifecycle/plugin.ts';
import { type SafetyPluginOptions, safetyPlugin } from './modules/engine/safety/plugin.ts';
import { type InvitationsOptions, invitationsRoutes } from './modules/invitations/routes.ts';
import { type PeaksPluginOptions, peaksPlugin } from './modules/library/peaks-plugin.ts';
import { libraryPlugin } from './modules/library/plugin.ts';
import { type UploadPluginOptions, uploadPlugin } from './modules/library/upload-plugin.ts';
import { logRoutes } from './modules/log/routes.ts';
import { orgRoutes } from './modules/orgs/routes.ts';
import { showsRoutes } from './modules/shows/routes.ts';
import { rotationRoutes } from './modules/rotation/routes.ts';
import { type AuthConfig, authPlugin } from './plugins/auth.ts';
import { type DbPluginOptions, dbPlugin } from './plugins/db.ts';
import { errorsPlugin } from './plugins/errors.ts';
import { type MailPluginOptions, mailPlugin } from './plugins/mail.ts';
import { type RabbitPluginOptions, rabbitPlugin } from './plugins/rabbit.ts';
import { type SseOptions, ssePlugin } from './plugins/sse.ts';

export interface AppOptions {
  db: DbPluginOptions;
  mail: MailPluginOptions;
  auth: AuthConfig;
  /** Optional so tests that don't touch the queue can skip RabbitMQ. */
  rabbit?: RabbitPluginOptions;
  /** Station engine lifecycle (#35). Needs `rabbit`. Unset: the api manages no engines. */
  engine?: EngineLifecyclePluginOptions;
  /** Alerts (#33): the engine lookup for the silence action, the escalation sweep. */
  alerts?: AlertsPluginOptions;
  /** As-run (#30): the durable queue name (tests). */
  asrun?: AsRunPluginOptions;
  /** Playout cache (#31): readiness API and cache alerts. */
  cache?: CachePluginOptions;
  /** Safety playlist and emergency file (#34): alert interval, event queue (tests). */
  safety?: SafetyPluginOptions;
  /** Media storage. Optional so tests that don't upload can skip S3; without it, no upload or peaks routes. */
  storage?: Storage;
  /** Upload route settings beyond `storage` (tests). */
  uploads?: Omit<UploadPluginOptions, 'storage'>;
  /** Peaks route settings beyond `storage` (tests). */
  peaks?: Omit<PeaksPluginOptions, 'storage'>;
  /** Team onboarding (#113): DNS resolver and sending limits. */
  invitations?: InvitationsOptions;
  /** Real-time stream tuning (tests shorten the timers). */
  sse?: Partial<SseOptions>;
  fastify?: FastifyServerOptions;
}

/**
 * Builds the api: plugins, then every module's routes under `/api/v1`. Modules add their
 * routes here (`app.register(xRoutes, { prefix: '/api/v1' })`).
 */
export async function buildApp(options: AppOptions) {
  const app = Fastify(options.fastify ?? { logger: true });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(errorsPlugin);
  await app.register(dbPlugin, options.db);
  if (options.rabbit) await app.register(rabbitPlugin, options.rabbit);
  await app.register(mailPlugin, options.mail);
  await app.register(authPlugin, options.auth);

  app
    .withTypeProvider<ZodTypeProvider>()
    .get('/api/v1/health', { schema: { response: { 200: healthResponseSchema } } }, () => health());
  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(invitationsRoutes, { prefix: '/api/v1', ...options.invitations });
  await app.register(orgRoutes, { prefix: '/api/v1' });
  // Streams the RabbitMQ event fanout (when configured) at /api/v1/stations/:stationId/events.
  await app.register(ssePlugin, options.sse ?? {});
  // Library routes carry their full /api/v1/stations/:stationId path.
  await app.register(libraryPlugin);
  await app.register(logRoutes, { prefix: '/api/v1' });
  // As-run (#30): `GET …/asrun`, engine track events -> as-run entries (durable queue).
  await app.register(asRunPlugin, options.asrun ?? {});
  await app.register(showsRoutes, { prefix: '/api/v1' });
  await app.register(rotationRoutes, { prefix: '/api/v1' });
  // Engine lifecycle (#35): engine routes, the internal engine events route, engines at boot.
  if (options.engine) await app.register(engineLifecyclePlugin, options.engine);
  // Alerts (#33): `app.alerts`, its routes under /api/v1, engine events -> alerts. Registered
  // after the lifecycle so the silence action reaches the station's engine from any replica,
  // and a silence-settings change re-renders the engine (`reconcile` restarts only if needed).
  const lifecycle = app.hasDecorator('engineLifecycle') ? app.engineLifecycle : undefined;
  await app.register(alertsPlugin, {
    ...(lifecycle
      ? {
          engineFor: (stationId: string) => lifecycle.adapterFor(stationId),
          onSilenceSettingsUpdated: async (scope) => {
            await lifecycle.reconcile(scope).catch((err: unknown) => {
              app.log.error({ err, stationId: scope.stationId }, 'engine reconcile failed');
            });
          },
        }
      : {}),
    ...options.alerts,
  });
  // Playout cache (#31): `app.playoutCache` for the feeder, `GET …/cache`, cache alerts.
  await app.register(cachePlugin, options.cache ?? {});
  // Safety playlist and emergency file (#34): routes, on-air source, fallback alerts.
  await app.register(safetyPlugin, options.safety ?? {});
  if (options.storage) {
    await app.register(uploadPlugin, { ...options.uploads, storage: options.storage });
    // Waveform peaks (#22): GET …/assets/:assetId/peaks.
    await app.register(peaksPlugin, { ...options.peaks, storage: options.storage });
  }

  return app;
}
