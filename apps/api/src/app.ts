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
import { authRoutes } from './modules/auth/routes.ts';
import {
  type EngineLifecyclePluginOptions,
  engineLifecyclePlugin,
} from './modules/engine/lifecycle/plugin.ts';
import { libraryPlugin } from './modules/library/plugin.ts';
import { type UploadPluginOptions, uploadPlugin } from './modules/library/upload-plugin.ts';
import { logRoutes } from './modules/log/routes.ts';
import { type AuthConfig, authPlugin } from './plugins/auth.ts';
import { type DbPluginOptions, dbPlugin } from './plugins/db.ts';
import { errorsPlugin } from './plugins/errors.ts';
import { type MailPluginOptions, mailPlugin } from './plugins/mail.ts';
import { type RabbitPluginOptions, rabbitPlugin } from './plugins/rabbit.ts';

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
  /** Media storage. Optional so tests that don't upload can skip S3; without it, no upload routes. */
  storage?: Storage;
  /** Upload route settings beyond `storage` (tests). */
  uploads?: Omit<UploadPluginOptions, 'storage'>;
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
  // Library routes carry their full /api/v1/stations/:stationId path.
  await app.register(libraryPlugin);
  await app.register(logRoutes, { prefix: '/api/v1' });
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
  if (options.storage) {
    await app.register(uploadPlugin, { ...options.uploads, storage: options.storage });
  }

  return app;
}
