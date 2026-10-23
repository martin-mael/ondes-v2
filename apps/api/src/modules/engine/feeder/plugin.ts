import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { listRunningStationScopes } from '../lifecycle/repo.ts';
import type { FeederOptions } from './feeder.ts';
import { createFeederLeases } from './leases.ts';
import {
  createFeederPushStore,
  loadFeedIslands,
  loadFeedWindow,
  openFeederAlerts,
} from './repo.ts';
import { createFeederService, type FeederService } from './service.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** Just-in-time log feeder (#29): one per station across replicas. */
    feeder: FeederService;
  }
}

export type FeederPluginOptions = {
  options?: FeederOptions;
  tickMs?: number;
  leaseIntervalMs?: number;
  /** Start the timers and the fanout subscription once ready. Default true (tests: false). */
  start?: boolean;
};

/**
 * Wires the feeder (#29) into the api: the station engines from the lifecycle (#35), the
 * playout cache (#31), the alerts (#33) and the RabbitMQ event fanout. Registered after the
 * cache plugin, only when the api manages engines.
 */
export const feederPlugin = fp(
  async (app: FastifyInstance, options: FeederPluginOptions) => {
    const service = createFeederService({
      leases: createFeederLeases(app.dbClient.sql, {
        onLost: (stationIds) =>
          app.log.warn({ stationIds }, 'Feeder leases lost with their database session'),
      }),
      stations: () => listRunningStationScopes(app.db),
      depsFor: (scope) => ({
        engine: () => app.engineLifecycle.adapterFor(scope.stationId),
        load: (range) => loadFeedWindow(app.db, scope, range),
        islands: (itemIds) => loadFeedIslands(app.db, scope, itemIds),
        store: createFeederPushStore(app.db, scope),
        cache: app.playoutCache,
        alerts: {
          raise: (s, input) => app.alerts.raise(s, input),
          resolve: (s, key, opts) => app.alerts.resolve(s, key, opts),
          openKeys: (s) => openFeederAlerts(app.db, s),
        },
        publish: (event) => app.rabbit.events.publish(event),
      }),
      options: options.options,
      tickMs: options.tickMs,
      leaseIntervalMs: options.leaseIntervalMs,
      logger: app.log,
    });
    app.decorate('feeder', service);

    if (options.start ?? true) {
      const subscription = app.rabbit.subscribeEvents((event) => service.onEvent(event));
      app.addHook('onReady', () => service.start());
      app.addHook('onClose', async () => {
        await subscription.close();
      });
    }
    app.addHook('onClose', () => service.close());
  },
  {
    name: 'feeder',
    dependencies: ['db', 'rabbit', 'engine-lifecycle', 'alerts', 'cache'],
  },
);
