import { recordScheduleChanges, stationsDueForHorizon } from '@ondes/db';
import { consumeEventsDurable, type EventSubscription } from '@ondes/queue';
import { type RealtimeEvent, realtimeEventSchema } from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { createRegenAlerts } from './regen-alerts.ts';
import { regenRoutes } from './regen-routes.ts';
import { type ExtensionsBuilder, logHorizonJob } from './regen-service.ts';

// Log regeneration (#101, ADR 0030), api side: the regeneration routes, the horizon sweep and
// the `log.generated` → `log.generation_issues` alerts consumer (durable queue).
//
// The sweep, every 30 s:
// 1. records schedule changes from the audit log (`recordScheduleChanges`). Every mutation writes
//    its audit row in its own transaction, so no change depends on a best-effort publish, and
//    clocks, the grid, rotation, shows and the library don't have to know about regeneration;
// 2. enqueues a `log-horizon` pass (RabbitMQ) for each station with a missing horizon day or a
//    change that is due (debounced).

/** Name of the durable event queue the generation alerts are raised from (ADR 0006). */
export const REGEN_EVENT_QUEUE = 'log-regen';

export type RegenPluginOptions = {
  /** The generator's extension points for dry-runs (#46, #60), like the worker's. */
  extensions?: ExtensionsBuilder;
  /** How often the horizon sweep runs. Default 30 s; 0 turns it off (tests). */
  sweepIntervalMs?: number;
  /** Durable queue name (tests use their own). Default `log-regen`. */
  eventQueue?: string;
  now?: () => Date;
};

export const regenPlugin = fp(
  async (app: FastifyInstance, options: RegenPluginOptions) => {
    await app.register(regenRoutes, {
      prefix: '/api/v1',
      extensions: options.extensions,
      ...(options.now ? { now: options.now } : {}),
    });
    const rabbit = app.hasDecorator('rabbit') ? app.rabbit : undefined;
    if (!rabbit) return;

    const intervalMs = options.sweepIntervalMs ?? 30_000;
    if (intervalMs > 0) {
      let running = false;
      const timer = setInterval(() => {
        if (running) return;
        running = true;
        (async () => {
          const now = options.now?.() ?? new Date();
          await recordScheduleChanges(app.db, now);
          const stations = await stationsDueForHorizon(app.db, now);
          for (const s of stations) {
            await rabbit.jobs.enqueue(logHorizonJob, s, s);
          }
        })()
          .catch((err: unknown) => app.log.error({ err }, 'log horizon sweep failed'))
          .finally(() => {
            running = false;
          });
      }, intervalMs);
      timer.unref();
      app.addHook('onClose', async () => clearInterval(timer));
    }

    const alerts = createRegenAlerts({
      db: app.db,
      alerts: app.alerts,
      logger: app.log,
      ...(options.now ? { now: options.now } : {}),
    });
    let consumer: EventSubscription | undefined;
    app.addHook('onReady', async () => {
      const { rabbit: connection, topology } = rabbit.queue;
      consumer = consumeEventsDurable(
        connection,
        topology,
        options.eventQueue ?? REGEN_EVENT_QUEUE,
        realtimeEventSchema,
        (event) => alerts.handle(event),
        {
          keyOf: (event: RealtimeEvent) => event.stationId,
          onError: (error, event) => {
            if (!event) app.log.debug({ err: error }, 'Regen consumer skipped a message');
            else app.log.error({ err: error, type: event.type }, 'Generation alerts failed');
          },
        },
      );
      await consumer.ready;
    });
    app.addHook('onClose', async () => {
      await consumer?.close();
    });
  },
  { name: 'log-regen', dependencies: ['db', 'auth', 'alerts'] },
);
