import { resolveStationScope } from '@ondes/db';
import { defineJob } from '@ondes/queue';
import { CACHE_SYNC_JOB, cacheSyncJobPayloadSchema } from '@ondes/shared';
import { cacheDeps } from './deps.ts';
import { runCacheSync } from './sync.ts';

// `cache-sync` job (#31, ADR 0004): one pass over a station's horizon. See sync.ts for the
// pass, trigger.ts for what enqueues it (log changes, the 10 min sweep).
//
// High lane (engine work a listener can hear). No explicit idempotency key: the payload hash
// collapses concurrent enqueues while a pass runs (`in_flight`), and the pass re-reads the log
// at the end to catch a change whose enqueue was collapsed. Failed files don't fail the job:
// they are recorded and retried by the next pass; only infrastructure errors (database) throw
// and are retried by the queue.

export default defineJob(
  CACHE_SYNC_JOB,
  cacheSyncJobPayloadSchema,
  async (payload, ctx) => {
    const deps = await cacheDeps();
    if (!deps) {
      // Loud, not retried: another worker with a cache may take the next one.
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'cache-sync job skipped: PLAYOUT_CACHE_ROOT is not set on this worker',
          stationId: payload.stationId,
        }),
      );
      return;
    }
    const scope = await resolveStationScope(deps.db, payload.orgId, payload.stationId);
    const report = await runCacheSync(deps, scope, ctx.signal);
    if (report.fetched.length || report.failed.length || report.plan.evict.length) {
      console.log(
        JSON.stringify({
          level: report.failed.length ? 'warn' : 'info',
          msg: 'cache sync',
          stationId: payload.stationId,
          passes: report.passes,
          fetched: report.fetched.length,
          failed: report.failed.map((f) => ({ sha256: f.sha256, error: f.error })),
          evicted: report.plan.evict.length,
          deferred: report.plan.deferred.length,
          diskLow: report.diskLow,
        }),
      );
    }
  },
  { lane: 'high' },
);
