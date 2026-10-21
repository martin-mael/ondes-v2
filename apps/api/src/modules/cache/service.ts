import {
  alert,
  cacheReadiness,
  computeCacheReadiness,
  type Db,
  type Executor,
  getStationCache,
  isPlayoutCached,
  listCacheAlertStations,
  listCacheFiles,
  listCacheHorizon,
  resolveStationScope,
  type StationScope,
  whereStation,
} from '@ondes/db';
import { type JobType, jobType } from '@ondes/queue';
import {
  CACHE_FETCH_JOB,
  CACHE_SYNC_JOB,
  type CacheReadiness,
  type CacheStatus,
  cacheFetchJobPayloadSchema,
  cacheSyncJobPayloadSchema,
} from '@ondes/shared';
import { and, inArray, isNull, sql } from 'drizzle-orm';
import type { AlertService } from '../alerts/service.ts';
import type { Logger } from '../engine/adapter/index.ts';
import { CACHE_ALERT_TYPES, cacheAlertResolution, cacheAlerts } from './alerts.ts';

// Playout cache, api side (#31, ADR 0004). The worker owns the disk; this reads the tables it
// keeps: readiness for the feeder (#29) and the dashboard, and the cache alerts.

const HOUR = 3_600_000;

export const cacheSyncJobType = jobType(CACHE_SYNC_JOB, cacheSyncJobPayloadSchema, {
  lane: 'high',
});
export const cacheFetchJobType = jobType(CACHE_FETCH_JOB, cacheFetchJobPayloadSchema, {
  lane: 'high',
});

/** What the feeder (#29) and the dashboard use. Inside the api: `app.playoutCache`. */
export type PlayoutCache = {
  /** Whether the asset file's content is on the station's disk. Check before every push. */
  isCached(scope: StationScope, assetFileId: string): Promise<boolean>;
  /** Readiness of the log items in [now, now + windowMs) (default 48 h). */
  readiness(
    scope: StationScope,
    options?: { windowMs?: number; now?: Date },
  ): Promise<CacheReadiness>;
  /** Budget, usage, last pass and readiness, for the UI. */
  status(scope: StationScope, options?: { windowMs?: number; now?: Date }): Promise<CacheStatus>;
  /** A miss at push time: fetch this file now (`cache-fetch`, high lane). */
  requestUrgentFetch(scope: StationScope, assetFileId: string): Promise<void>;
  /** A 422 from the engine (the table said cached, the disk disagrees): run a pass. */
  requestSync(scope: StationScope): Promise<void>;
  /** Raises the cache alerts the station should have and resolves the others. */
  evaluateAlerts(
    scope: StationScope,
    now?: Date,
    reader?: Executor,
  ): Promise<{ raised: number; resolved: number }>;
  /**
   * `evaluateAlerts` for every station with file items in the next 6 h or a cache record,
   * synced or not.
   */
  evaluateAllAlerts(now?: Date): Promise<void>;
};

export type PlayoutCacheOptions = {
  db: Db;
  alerts: AlertService;
  /** Enqueues a job; unset without RabbitMQ (the request methods then throw). */
  enqueue?: (job: JobType, payload: unknown, scope: StationScope) => Promise<void>;
  logger: Logger;
};

export function createPlayoutCache(options: PlayoutCacheOptions): PlayoutCache {
  const { db, alerts, logger } = options;

  function enqueue(job: JobType, payload: unknown, scope: StationScope) {
    if (!options.enqueue) throw new Error('playout cache requests need RabbitMQ');
    return options.enqueue(job, payload, scope);
  }

  function window(options: { windowMs?: number; now?: Date } = {}) {
    const from = options.now ?? new Date();
    return { from, to: new Date(from.getTime() + (options.windowMs ?? 48 * HOUR)) };
  }

  /**
   * Reads go through `reader` (the sweep's locked transaction); raises and resolves go through
   * the alert service, which writes in its own transactions (it publishes and emails after
   * commit), so they can't join the reader's.
   */
  async function evaluateAlerts(scope: StationScope, now = new Date(), reader: Executor = db) {
    const six = window({ now, windowMs: 6 * HOUR });
    const hour = window({ now, windowMs: HOUR });
    const [items, files, state, open] = await Promise.all([
      listCacheHorizon(reader, scope, six),
      listCacheFiles(reader, scope),
      getStationCache(reader, scope),
      reader
        .select({ dedupeKey: alert.dedupeKey })
        .from(alert)
        .where(
          and(
            whereStation(alert, scope),
            isNull(alert.resolvedAt),
            inArray(alert.type, [...CACHE_ALERT_TYPES]),
          ),
        ),
    ]);
    const fileStates = new Map(files.map((f) => [f.sha256, { state: f.state, error: f.error }]));
    const deferred = new Set(state.deferred);
    const nextHour = computeCacheReadiness(items, fileStates, deferred, hour);
    const desired = cacheAlerts({
      nextHour,
      nextSixHours: computeCacheReadiness(items, fileStates, deferred, six),
      state,
      failed: files.filter((f) => f.state === 'failed'),
    });
    const readySha = new Set(files.filter((f) => f.state === 'ready').map((f) => f.sha256));
    const ready = {
      sha256s: readySha,
      itemIds: new Set(
        items.filter((i) => i.sha256 && readySha.has(i.sha256)).map((i) => i.logItemId),
      ),
    };
    const openKeys = new Set(open.map((o) => o.dedupeKey));
    const desiredKeys = new Set(desired.map((d) => d.dedupeKey));
    let raised = 0;
    let resolved = 0;
    for (const d of desired) {
      if (openKeys.has(d.dedupeKey)) continue;
      await alerts.raise(scope, d, { occurredAt: now });
      raised++;
    }
    for (const key of openKeys) {
      if (desiredKeys.has(key)) continue;
      const reason = cacheAlertResolution(key, ready);
      if (await alerts.resolve(scope, key, { reason, occurredAt: now })) resolved++;
    }
    return { raised, resolved };
  }

  return {
    isCached: (scope, assetFileId) => isPlayoutCached(db, scope, assetFileId),
    readiness: (scope, opts) => cacheReadiness(db, scope, window(opts)),
    async status(scope, opts) {
      const [state, readiness] = await Promise.all([
        getStationCache(db, scope),
        cacheReadiness(db, scope, window(opts)),
      ]);
      return {
        budgetBytes: state.budgetBytes,
        usedBytes: state.usedBytes,
        horizonBytes: state.horizonBytes,
        deferredFiles: state.deferred.length,
        diskLow: state.diskLow,
        lastPassAt: state.lastPassAt?.toISOString() ?? null,
        lastError: state.lastError
          ? { at: state.lastError.at.toISOString(), message: state.lastError.message }
          : null,
        readiness,
      };
    },
    async requestUrgentFetch(scope, assetFileId) {
      await enqueue(
        cacheFetchJobType,
        { orgId: scope.orgId, stationId: scope.stationId, assetFileId },
        scope,
      );
    },
    async requestSync(scope) {
      await enqueue(cacheSyncJobType, { orgId: scope.orgId, stationId: scope.stationId }, scope);
    },
    evaluateAlerts,
    async evaluateAllAlerts(now = new Date()) {
      // One replica at a time: the others skip this round. The transaction holds the lock and
      // serves the reads; the alert writes are the alert service's own.
      await db.transaction(async (tx) => {
        const [lock] = await tx.execute<{ locked: boolean }>(
          sql`select pg_try_advisory_xact_lock(hashtextextended('cache-alerts', 0)) as locked`,
        );
        if (!lock?.locked) return;
        const stations = await listCacheAlertStations(tx, {
          from: now,
          until: new Date(now.getTime() + 6 * HOUR),
        });
        for (const s of stations) {
          try {
            await evaluateAlerts(await resolveStationScope(tx, s.orgId, s.stationId), now, tx);
          } catch (err) {
            logger.error({ err, stationId: s.stationId }, 'cache alert evaluation failed');
          }
        }
      });
    },
  };
}
