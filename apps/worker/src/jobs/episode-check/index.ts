import { createDb, type Db, resolveStationScope } from '@ondes/db';
import { defineJob } from '@ondes/queue';
import { EPISODE_CHECK_JOB, episodeCheckJobPayloadSchema } from '@ondes/shared';
import { runEpisodeCheck } from './check.ts';

// `episode-check` job (#47, ADR 0022): one pass of the missing-episode check over a station.
// Enqueued every minute per station by the sweep (sweep.ts, started by the worker). Records
// the due steps in `episode_check`; the api raises the alerts, sends the emails and applies the
// fallbacks.
//
// High lane: a missed fallback is dead air. No explicit idempotency key: the payload hash
// collapses concurrent enqueues while a pass runs, and a pass is idempotent anyway.

let db: Db | undefined;
function database(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    db = createDb(url, { applicationName: 'ondes-worker-episode-check' }).db;
  }
  return db;
}

export default defineJob(
  EPISODE_CHECK_JOB,
  episodeCheckJobPayloadSchema,
  async (payload) => {
    const scope = await resolveStationScope(database(), payload.orgId, payload.stationId);
    const report = await runEpisodeCheck(database(), scope);
    if (report.recorded.length) {
      console.log(
        JSON.stringify({
          level: 'info',
          msg: 'episode check: steps due',
          stationId: payload.stationId,
          recorded: report.recorded,
        }),
      );
    }
  },
  { lane: 'high' },
);
