import { healthResponseSchema } from '@ondes/shared';
import Fastify, { type FastifyServerOptions } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { health } from './health.ts';
import { authRoutes } from './modules/auth/routes.ts';
import {
  type EngineLifecyclePluginOptions,
  engineLifecyclePlugin,
} from './modules/engine/lifecycle/plugin.ts';
import { libraryPlugin } from './modules/library/plugin.ts';
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
  // Engine lifecycle (#35): engine routes, the internal engine events route, engines at boot.
  if (options.engine) await app.register(engineLifecyclePlugin, options.engine);

  return app;
}
