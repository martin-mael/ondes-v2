import { randomUUID } from 'node:crypto';
import { stationsDueForHorizon } from '@ondes/db';
import { consumeEventsDurable, type EventSubscription } from '@ondes/queue';
import { type RealtimeEvent, realtimeEventSchema, type ScheduleArea } from '@ondes/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { createRegenAlerts } from './regen-alerts.ts';
import { regenRoutes } from './regen-routes.ts';
import { type ExtensionsBuilder, logHorizonJob } from './regen-service.ts';

// Log regeneration (#101, ADR 0030), api side. Two plugins:
// - `scheduleChangesPlugin` (registered before the modules' routes): after a successful
//   schedule mutation, publishes `schedule.changed`. The worker's `log-horizon` trigger
//   records it and regenerates the horizon, debounced. One hook over the route table rather
//   than a call in every module: clocks, the grid, categories, rules and shows don't need to
//   know about regeneration.
// - `regenPlugin`: the regeneration routes, the horizon sweep (every 30 s, enqueues a
//   `log-horizon` pass for each station with a missing day or a due change) and the
//   `log.generated` → `log.generation_issues` alerts consumer (durable queue).

/** Successful mutations of these routes change what the generator plans. */
export const SCHEDULE_ROUTES: Readonly<Record<string, ScheduleArea>> = {
  '/api/v1/stations/:stationId/clocks/:clockId': 'clocks',
  '/api/v1/stations/:stationId/clock-grid': 'grid',
  '/api/v1/stations/:stationId/clock-grid/dayparts': 'grid',
  '/api/v1/stations/:stationId/clock-grid/dayparts/:daypartId': 'grid',
  '/api/v1/stations/:stationId/clock-grid/overrides': 'grid',
  '/api/v1/stations/:stationId/clock-grid/overrides/:overrideId': 'grid',
  '/api/v1/stations/:stationId/categories/:categoryId': 'categories',
  '/api/v1/stations/:stationId/rotation/rules': 'rules',
  '/api/v1/stations/:stationId/shows/:showId': 'shows',
  '/api/v1/stations/:stationId/shows/:showId/slots': 'shows',
  '/api/v1/stations/:stationId/shows/:showId/slots/:slotId': 'shows',
  '/api/v1/stations/:stationId/shows/:showId/slots/:slotId/exceptions/:date': 'shows',
  '/api/v1/stations/:stationId/shows/:showId/episodes': 'shows',
  '/api/v1/stations/:stationId/shows/:showId/episodes/:episodeId': 'shows',
  '/api/v1/stations/:stationId/shows/:showId/episodes/:episodeId/reruns': 'shows',
};

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The schedule area a finished request changed, if any. */
export function scheduleAreaOf(request: FastifyRequest, statusCode: number): ScheduleArea | null {
  if (!MUTATIONS.has(request.method) || statusCode < 200 || statusCode >= 300) return null;
  const url = request.routeOptions.url;
  return (url && SCHEDULE_ROUTES[url]) || null;
}

export const scheduleChangesPlugin = fp(
  async (app: FastifyInstance) => {
    app.addHook('onResponse', async (request, reply) => {
      const area = scheduleAreaOf(request, reply.statusCode);
      const scope = request.scope;
      if (!area || !scope || !('stationId' in scope) || !app.hasDecorator('rabbit')) return;
      const event: RealtimeEvent = {
        id: randomUUID(),
        stationId: scope.stationId,
        at: new Date().toISOString(),
        type: 'schedule.changed',
        data: { orgId: scope.orgId, areas: [area], from: null },
      };
      try {
        await app.rabbit.events.publish(realtimeEventSchema.parse(event));
      } catch (err) {
        request.log.error({ err, area }, 'schedule.changed publish failed');
      }
    });
  },
  { name: 'schedule-changes', dependencies: ['auth'] },
);

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
          const stations = await stationsDueForHorizon(app.db, options.now?.() ?? new Date());
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
