import { resolveStationScope } from '@ondes/db';
import { defineJob } from '@ondes/queue';
import { CACHE_FETCH_JOB, cacheFetchJobPayloadSchema } from '@ondes/shared';
import { cacheDeps } from '../cache-sync/deps.ts';
import { urgentFetch } from '../cache-sync/urgent.ts';

// `cache-fetch` job (#31, ADR 0004): the feeder's urgent fetch of one file it is about to push
// (#29 enqueues it on a miss or a 422). High lane. No explicit idempotency key: concurrent
// requests for one file collapse (`in_flight`), and a file evicted later can be fetched again.
// A failure is recorded on the file (its alert follows) and not retried here: the next
// cache-sync pass retries it.

export default defineJob(
  CACHE_FETCH_JOB,
  cacheFetchJobPayloadSchema,
  async (payload, ctx) => {
    const deps = await cacheDeps();
    if (!deps) return;
    const scope = await resolveStationScope(deps.db, payload.orgId, payload.stationId);
    const outcome = await urgentFetch(deps, scope, payload.assetFileId, ctx.signal);
    console.log(
      JSON.stringify({
        level: outcome.kind === 'fetched' || outcome.kind === 'present' ? 'info' : 'warn',
        msg: 'cache urgent fetch',
        stationId: payload.stationId,
        assetFileId: payload.assetFileId,
        ...outcome,
      }),
    );
  },
  { lane: 'high' },
);
