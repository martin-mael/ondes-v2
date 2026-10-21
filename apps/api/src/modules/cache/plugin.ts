import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { cacheRoutes } from './routes.ts';
import { createPlayoutCache, type PlayoutCache } from './service.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** Playout cache readiness (#31): `isCached`, `readiness`, `requestUrgentFetch` for #29. */
    playoutCache: PlayoutCache;
  }
}

export type CachePluginOptions = {
  /** How often the cache alerts are evaluated. Default 30 s; 0 turns it off (tests). */
  alertIntervalMs?: number;
};

/**
 * Playout cache (#31): decorates `app.playoutCache`, mounts `GET …/cache` and evaluates the
 * cache alerts periodically (one replica per round). Registered after the alerts plugin.
 */
export const cachePlugin = fp(
  async (app: FastifyInstance, options: CachePluginOptions) => {
    const rabbit = app.hasDecorator('rabbit') ? app.rabbit : undefined;
    const cache = createPlayoutCache({
      db: app.db,
      alerts: app.alerts,
      enqueue: rabbit
        ? async (job, payload, scope) => {
            await rabbit.jobs.enqueue(job, payload, {
              orgId: scope.orgId,
              stationId: scope.stationId,
            });
          }
        : undefined,
      logger: app.log,
    });
    app.decorate('playoutCache', cache);
    await app.register(cacheRoutes, { prefix: '/api/v1' });

    const intervalMs = options.alertIntervalMs ?? 30_000;
    if (intervalMs > 0) {
      let running = false;
      const timer = setInterval(() => {
        if (running) return;
        running = true;
        cache
          .evaluateAllAlerts()
          .catch((err: unknown) => app.log.error({ err }, 'cache alerts failed'))
          .finally(() => {
            running = false;
          });
      }, intervalMs);
      timer.unref();
      app.addHook('onClose', async () => clearInterval(timer));
    }
  },
  { name: 'cache', dependencies: ['alerts'] },
);
