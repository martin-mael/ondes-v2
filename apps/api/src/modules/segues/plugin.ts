import { type Db, resolveStationScope, type StationScope, station } from '@ondes/db';
import { consumeEventsDurable, type EventSubscription } from '@ondes/queue';
import { type RealtimeEvent, realtimeEventSchema } from '@ondes/shared';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { type EventSink, eventsOf, publishAll } from './events.ts';
import { seguesRoutes } from './routes.ts';
import { type SyncResult, type SyncSeeds, syncSegues } from './sync.ts';

/** Durable event queue that keeps islands in step with the log and the library. */
export const SEGUES_EVENT_QUEUE = 'segues';

export type SeguesPluginOptions = {
  /** Durable queue name (tests use their own). Default `segues`. */
  eventQueue?: string;
  /** Where events go. Default: the RabbitMQ fanout when configured (tests pass a sink). */
  events?: EventSink;
};

/** Station fields that change every playout gain, hence every island. */
const GAIN_FIELDS = new Set(['loudnessTargetLufs', 'truePeakLimitDbtp']);

export type SegueSync = {
  /** Re-syncs the chains the seeds touch, commits, publishes what changed. */
  sync(scope: StationScope, seeds: SyncSeeds): Promise<SyncResult>;
  /**
   * What the consumer does with one event: re-syncs the segues a log, asset or station change
   * can affect. Other events are ignored (null).
   */
  handleEvent(event: RealtimeEvent): Promise<SyncResult | null>;
};

/**
 * Invalidation (#55): re-derives the islands a change can affect.
 * - `log.updated`: the segues of the days it touched, plus those that lost an item;
 * - `asset.ingested` / `asset.updated` (cues, loudness, playout settings): the segues playing
 *   the asset; `asset.deleted`: those, plus the ones whose A or B lost it;
 * - `station.updated` with a loudness field: every segue of the station.
 * Changed specs go back to `pending` and the renderer (#56) picks them up from
 * `island.updated`. The feeder (#57) still re-derives at push time (`deriveIslandsFor`), so an
 * event in flight never airs a stale render.
 */
export function createSegueSync(deps: {
  db: Db;
  events?: EventSink | undefined;
  logger: FastifyBaseLogger;
}): SegueSync {
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

  async function sync(scope: StationScope, seeds: SyncSeeds) {
    const result = await deps.db.transaction((tx) => syncSegues(tx, scope, seeds));
    await publishAll(deps.events, eventsOf(scope, result), deps.logger);
    return result;
  }

  return {
    sync,
    async handleEvent(event) {
      let seeds: SyncSeeds;
      switch (event.type) {
        case 'log.updated':
          seeds = { logDayIds: event.data.days.map((d) => d.logDayId), orphans: true };
          break;
        case 'asset.ingested':
        case 'asset.updated':
          seeds = { assetIds: [event.data.assetId] };
          break;
        case 'asset.deleted':
          // Its ids are gone from A/B (`set null`): those segues show up as orphans.
          seeds = { assetIds: [event.data.assetId], orphans: true };
          break;
        case 'station.updated':
          if (!event.data.fields.some((f) => GAIN_FIELDS.has(f))) return null;
          seeds = { all: true };
          break;
        default:
          return null;
      }
      const scope = await scopeOf(event.stationId);
      if (!scope) return null;
      return sync(scope, seeds);
    },
  };
}

/**
 * Segues and islands (#55): mounts the routes under `/api/v1` and, with RabbitMQ, re-syncs
 * islands from a durable, single-active-consumer event queue (ADR 0006), in order per station.
 */
export const seguesPlugin = fp(
  async (app: FastifyInstance, options: SeguesPluginOptions) => {
    const rabbit = app.hasDecorator('rabbit') ? app.rabbit : undefined;
    const events: EventSink | undefined =
      options.events ?? (rabbit ? { publish: (event) => rabbit.events.publish(event) } : undefined);
    await app.register(seguesRoutes, { prefix: '/api/v1', events });
    if (!rabbit) return;
    const segueSync = createSegueSync({ db: app.db, events, logger: app.log });
    let consumer: EventSubscription | undefined;
    app.addHook('onReady', async () => {
      const { rabbit: connection, topology } = rabbit.queue;
      consumer = consumeEventsDurable(
        connection,
        topology,
        options.eventQueue ?? SEGUES_EVENT_QUEUE,
        realtimeEventSchema,
        async (event) => {
          await segueSync.handleEvent(event);
        },
        {
          keyOf: (event: RealtimeEvent) => event.stationId,
          onError: (error, event) => {
            if (!event) app.log.debug({ err: error }, 'Segues consumer skipped a message');
            else app.log.error({ err: error, type: event.type }, 'Island sync failed');
          },
        },
      );
      await consumer.ready;
    });
    app.addHook('onClose', async () => {
      await consumer?.close();
    });
  },
  { name: 'segues', dependencies: ['db', 'auth'] },
);
