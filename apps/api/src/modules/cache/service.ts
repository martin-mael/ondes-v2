import {
  alert,
  cacheReadiness,
  type Db,
  getStationCache,
  isPlayoutCached,
  listCacheFiles,
  listSyncedCacheStations,
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
import { CACHE_ALERT_TYPES, cacheAlerts } from './alerts.ts';

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
  evaluateAlerts(scope: StationScope, now?: Date): Promise<{ raised: number; resolved: number }>;
  /** `evaluateAlerts` for every station the worker has synced. */
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

  async function evaluateAlerts(scope: StationScope, now = new Date()) {
    const [nextHour, nextSixHours, state, files, open] = await Promise.all([
      cacheReadiness(db, scope, window({ now, windowMs: HOUR })),
      cacheReadiness(db, scope, window({ now, windowMs: 6 * HOUR })),
      getStationCache(db, scope),
      listCacheFiles(db, scope),
      db
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
    const desired = cacheAlerts({
      nextHour,
      nextSixHours,
      state,
      failed: files.filter((f) => f.state === 'failed'),
    });
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
      if (await alerts.resolve(scope, key, { reason: 'cache_ok', occurredAt: now })) resolved++;
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
      // One replica at a time: the others skip this round.
      await db.transaction(async (tx) => {
        const [lock] = await tx.execute<{ locked: boolean }>(
          sql`select pg_try_advisory_xact_lock(hashtextextended('cache-alerts', 0)) as locked`,
        );
        if (!lock?.locked) return;
        for (const s of await listSyncedCacheStations(tx)) {
          try {
            await evaluateAlerts(await resolveStationScope(tx, s.orgId, s.stationId), now);
          } catch (err) {
            logger.error({ err, stationId: s.stationId }, 'cache alert evaluation failed');
          }
        }
      });
    },
  };
}
