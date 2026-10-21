import { consumeEventsDurable, type EventSubscription } from '@ondes/queue';
import { type RealtimeEvent, realtimeEventSchema } from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { safetyRoutes } from './routes.ts';
import { createSafetyService, type SafetyService } from './service.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** Safety playlist and emergency file (#34). */
    safety: SafetyService;
  }
}

/** Durable event queue that records what each engine has on air (safety mode). */
export const SAFETY_EVENT_QUEUE = 'safety';

export type SafetyPluginOptions = {
  /** How often the fallback alerts are evaluated. Default 30 s; 0 turns it off (tests). */
  alertIntervalMs?: number;
  /** Durable queue name (tests use their own). Default `safety`. */
  eventQueue?: string;
};

/**
 * Safety playlist and emergency file (#34): decorates `app.safety`, mounts its routes under
 * `/api/v1`, records the engines' on-air source from their events (a durable, single-active
 * consumer, in order per station) and evaluates the fallback alerts periodically (one replica
 * per round). Registered after the cache plugin: a change asks it for a cache-sync pass.
 */
export const safetyPlugin = fp(
  async (app: FastifyInstance, options: SafetyPluginOptions) => {
    const rabbit = app.hasDecorator('rabbit') ? app.rabbit : undefined;
    const cache = app.playoutCache;
    const safety = createSafetyService({
      db: app.db,
      alerts: app.alerts,
      requestSync: rabbit ? (scope) => cache.requestSync(scope) : undefined,
      logger: app.log,
    });
    app.decorate('safety', safety);
    await app.register(safetyRoutes, { prefix: '/api/v1', safety });

    let consumer: EventSubscription | undefined;
    if (rabbit) {
      const { rabbit: connection, topology } = rabbit.queue;
      app.addHook('onReady', async () => {
        consumer = consumeEventsDurable(
          connection,
          topology,
          options.eventQueue ?? SAFETY_EVENT_QUEUE,
          realtimeEventSchema,
          (event) => safety.handleEngineEvent(event),
          {
            keyOf: (event: RealtimeEvent) => event.stationId,
            onError: (error, event) => {
              if (!event) app.log.debug({ err: error }, 'Safety consumer skipped a message');
              else app.log.error({ err: error, type: event.type }, 'Safety event handling failed');
            },
          },
        );
        await consumer.ready;
      });
    }

    const intervalMs = options.alertIntervalMs ?? 30_000;
    let timer: NodeJS.Timeout | undefined;
    if (intervalMs > 0) {
      let running = false;
      timer = setInterval(() => {
        if (running) return;
        running = true;
        safety
          .evaluateAllAlerts()
          .catch((err: unknown) => app.log.error({ err }, 'safety alerts failed'))
          .finally(() => {
            running = false;
          });
      }, intervalMs);
      timer.unref();
    }
    app.addHook('onClose', async () => {
      if (timer) clearInterval(timer);
      await consumer?.close();
    });
  },
  { name: 'safety', dependencies: ['alerts', 'cache'] },
);
