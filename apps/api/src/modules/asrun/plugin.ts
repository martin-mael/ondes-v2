import { consumeEventsDurable, type EventSubscription } from '@ondes/queue';
import { type RealtimeEvent, realtimeEventSchema } from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { asRunOverlayRoutes } from './overlay-routes.ts';
import { createAsRunRecorder } from './recorder.ts';
import { asRunRoutes } from './routes.ts';

/** Name of the durable event queue the as-run is recorded from (ADR 0006). */
export const ASRUN_EVENT_QUEUE = 'asrun';

export type AsRunPluginOptions = {
  /** Durable queue name (tests use their own). Default `asrun`. */
  eventQueue?: string;
};

/**
 * As-run (#30): mounts `GET …/asrun` (and the log vs as-run overlay, #53) under `/api/v1` and, with RabbitMQ, records the engine's
 * track events from a durable, single-active-consumer queue (`consumeEventsDurable`): one
 * replica at a time, in order per station, nothing lost while the api restarts.
 */
export const asRunPlugin = fp(
  async (app: FastifyInstance, options: AsRunPluginOptions) => {
    await app.register(asRunRoutes, { prefix: '/api/v1' });
    await app.register(asRunOverlayRoutes, { prefix: '/api/v1' });
    const rabbit = app.hasDecorator('rabbit') ? app.rabbit : undefined;
    if (!rabbit) return;
    const recorder = createAsRunRecorder({
      db: app.db,
      publish: (event) => rabbit.events.publish(event),
      logger: app.log,
    });
    let consumer: EventSubscription | undefined;
    app.addHook('onReady', async () => {
      const { rabbit: connection, topology } = rabbit.queue;
      consumer = consumeEventsDurable(
        connection,
        topology,
        options.eventQueue ?? ASRUN_EVENT_QUEUE,
        realtimeEventSchema,
        (event) => recorder.handle(event),
        {
          keyOf: (event: RealtimeEvent) => event.stationId,
          onError: (error, event) => {
            // Events of other domains this api doesn't know yet are skipped, not errors.
            if (!event) app.log.debug({ err: error }, 'As-run consumer skipped a message');
            else app.log.error({ err: error, type: event.type }, 'As-run recording failed');
          },
        },
      );
      await consumer.ready;
    });
    app.addHook('onClose', async () => {
      await consumer?.close();
    });
  },
  { name: 'asrun', dependencies: ['db', 'auth'] },
);
