import { type Db, promo, resolveStationScope, type StationScope, station } from '@ondes/db';
import type { JobPublisher } from '@ondes/queue';
import { consumeEventsDurable, type EventSubscription } from '@ondes/queue';
import { type RealtimeEvent, realtimeEventSchema } from '@ondes/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { EventSink } from '../segues/events.ts';
import { type PlacementSyncResult, syncPromoPlacements } from './placements.ts';
import { promosRoutes } from './routes.ts';

/** Durable event queue that turns the generator's promo placements into segues (#60). */
export const PROMOS_EVENT_QUEUE = 'promos';

export type PromosPluginOptions = {
  /** Durable queue name (tests use their own). Default `promos`. */
  eventQueue?: string;
  /** Where segue events go. Default: the RabbitMQ fanout when configured. */
  events?: EventSink;
  /** Where island render jobs go. Default: the RabbitMQ job publisher when configured. */
  jobs?: JobPublisher;
};

/**
 * What the consumer does with one event:
 * - `log.updated`: the placements of the days it names (new ones get their segue, those whose
 *   songs went away are dropped and their generated segue deleted);
 * - `asset.updated` / `asset.ingested` of a promo's asset: its coming placements (validity may
 *   have changed; a voice that was still ingesting can now be placed).
 * Other events are ignored (null).
 */
export function createPromoEventHandler(deps: {
  db: Db;
  events?: EventSink | undefined;
  jobs?: JobPublisher | undefined;
  logger: FastifyBaseLogger;
}) {
  const scopes = new Map<string, StationScope>();
  async function scopeOf(stationId: string): Promise<StationScope | null> {
    const cached = scopes.get(stationId);
    if (cached) return cached;
    const [row] = await deps.db
      .select({ orgId: station.orgId })
      .from(station)
      .where(eq(station.id, stationId));
    if (!row) return null;
    const scope = await resolveStationScope(deps.db, row.orgId, stationId);
    scopes.set(stationId, scope);
    return scope;
  }

  return async (event: RealtimeEvent): Promise<PlacementSyncResult | null> => {
    if (
      event.type !== 'log.updated' &&
      event.type !== 'asset.updated' &&
      event.type !== 'asset.ingested'
    ) {
      return null;
    }
    const scope = await scopeOf(event.stationId);
    if (!scope) return null;
    if (event.type === 'log.updated') {
      return syncPromoPlacements(deps, scope, {
        logDayIds: event.data.days.map((d) => d.logDayId),
      });
    }
    const [found] = await deps.db
      .select({ id: promo.id })
      .from(promo)
      .where(and(eq(promo.assetId, event.data.assetId), eq(promo.stationId, scope.stationId)));
    if (!found) return null;
    return syncPromoPlacements(deps, scope, { promoId: found.id, from: new Date() });
  };
}

/**
 * Promo VTs and VT pools (#60): mounts the routes under `/api/v1` and, with RabbitMQ, makes the
 * generator's placements into segues from a durable, single-active-consumer event queue
 * (ADR 0006), in order per station.
 */
export const promosPlugin = fp(
  async (app: FastifyInstance, options: PromosPluginOptions) => {
    const rabbit = app.hasDecorator('rabbit') ? app.rabbit : undefined;
    const events: EventSink | undefined =
      options.events ?? (rabbit ? { publish: (event) => rabbit.events.publish(event) } : undefined);
    const jobs = options.jobs ?? rabbit?.jobs;
    await app.register(promosRoutes, { prefix: '/api/v1', events, jobs });
    if (!rabbit) return;
    const handle = createPromoEventHandler({ db: app.db, events, jobs, logger: app.log });
    let consumer: EventSubscription | undefined;
    app.addHook('onReady', async () => {
      const { rabbit: connection, topology } = rabbit.queue;
      consumer = consumeEventsDurable(
        connection,
        topology,
        options.eventQueue ?? PROMOS_EVENT_QUEUE,
        realtimeEventSchema,
        async (event) => {
          await handle(event);
        },
        {
          keyOf: (event: RealtimeEvent) => event.stationId,
          onError: (error, event) => {
            if (!event) app.log.debug({ err: error }, 'Promos consumer skipped a message');
            else app.log.error({ err: error, type: event.type }, 'Promo placement sync failed');
          },
        },
      );
      await consumer.ready;
    });
    app.addHook('onClose', async () => {
      await consumer?.close();
    });
  },
  { name: 'promos', dependencies: ['db', 'auth'] },
);
