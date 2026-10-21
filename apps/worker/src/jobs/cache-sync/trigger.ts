import { type Db, getCacheStation, listCacheStations } from '@ondes/db';
import {
  consumeEventsDurable,
  type EventSubscription,
  type JobPublisher,
  jobType,
  type QueueConnection,
} from '@ondes/queue';
import {
  CACHE_SYNC_JOB,
  cacheSyncJobPayloadSchema,
  type RealtimeEvent,
  realtimeEventSchema,
  uuidSchema,
} from '@ondes/shared';
import { HOUR } from './planner.ts';

// What enqueues `cache-sync` (ADR 0004), started by the worker when it keeps a cache:
// - log changes: a durable consumer of the events fanout (`ondes.events.cache-sync`), so a
//   change published while no worker runs is synced once one starts. One pass per
//   `log.updated` that touches the next week (`log.item.changed` is always followed by one);
// - a sweep every 10 min for every station: rolls the horizon forward, retries failed files,
//   frees budget as items age out, and catches anything missed.

export const CACHE_SYNC_EVENT_QUEUE = 'cache-sync';

export const cacheSyncJobType = jobType(CACHE_SYNC_JOB, cacheSyncJobPayloadSchema, {
  lane: 'high',
});

/** Log changes later than this don't concern any horizon (longest allowed: 168 h). */
const MAX_HORIZON_MS = 168 * HOUR;

/** Whether a log change is in some station's horizon (pinned window included). */
export function concernsCache(event: RealtimeEvent, now: number): boolean {
  if (event.type !== 'log.updated') return false;
  return (
    Date.parse(event.data.from) < now + MAX_HORIZON_MS && Date.parse(event.data.to) > now - HOUR
  );
}

export type CacheTriggerOptions = {
  queue: Pick<QueueConnection, 'rabbit' | 'topology'>;
  jobs: JobPublisher;
  db: Db;
  /** Default 10 min; 0 turns the sweep off (tests). */
  sweepIntervalMs?: number;
  /** Durable queue name (tests use their own). */
  eventQueue?: string;
  onError?: (error: unknown) => void;
};

export type CacheTrigger = {
  ready: Promise<void>;
  /** Enqueues a pass for every station. */
  sweep(): Promise<number>;
  close(): Promise<void>;
};

export function startCacheTriggers(options: CacheTriggerOptions): CacheTrigger {
  const { db, jobs } = options;
  const onError = options.onError ?? (() => {});

  async function enqueue(orgId: string, stationId: string) {
    await jobs.enqueue(cacheSyncJobType, { orgId, stationId }, { orgId, stationId });
  }

  const consumer: EventSubscription = consumeEventsDurable(
    options.queue.rabbit,
    options.queue.topology,
    options.eventQueue ?? CACHE_SYNC_EVENT_QUEUE,
    realtimeEventSchema,
    async (event) => {
      if (!concernsCache(event, Date.now())) return;
      if (!uuidSchema.safeParse(event.stationId).success) return;
      const target = await getCacheStation(db, event.stationId);
      // A deleted station: nothing to sync.
      if (target) await enqueue(target.orgId, target.stationId);
    },
    {
      keyOf: (event) => event.stationId,
      onError: (error, event) => {
        // Event types this worker doesn't know are skipped, not errors.
        if (event) onError(error);
      },
    },
  );

  async function sweep() {
    const stations = await listCacheStations(db);
    for (const s of stations) await enqueue(s.orgId, s.stationId);
    return stations.length;
  }

  const intervalMs = options.sweepIntervalMs ?? 10 * 60 * 1000;
  let timer: NodeJS.Timeout | undefined;
  if (intervalMs > 0) {
    const tick = () => void sweep().catch(onError);
    timer = setInterval(tick, intervalMs);
    void consumer.ready.then(tick);
  }

  return {
    ready: consumer.ready,
    sweep,
    async close() {
      if (timer) clearInterval(timer);
      await consumer.close();
    },
  };
}
