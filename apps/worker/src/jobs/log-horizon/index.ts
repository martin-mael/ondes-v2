import { createDb, type Db, resolveStationScope } from '@ondes/db';
import { defineJob } from '@ondes/queue';
import { LOG_HORIZON_JOB, logHorizonJobPayloadSchema } from '@ondes/shared';
import { eventPublisherFromEnv, type PublishEvent } from '../_events/asset-updated.ts';
import { issueSummary } from '../log-generate/generate.ts';
import { runLogHorizon } from './horizon.ts';
import { logHorizonTrigger } from './trigger.ts';

// `log-horizon` job (#101, ADR 0030): keeps a station's log generated over its horizon and
// regenerates it, debounced, after schedule changes. See horizon.ts. Enqueued by the trigger
// below (one per `schedule.changed`) and by the api's horizon sweep (`modules/log/regen-plugin`,
// every 30 s, for stations with a missing day or a due change).
//
// Bulk lane. The sweep's passes keep the default key (payload hash): duplicates collapse while
// one is in flight, and a later pass runs again.

let deps: Promise<{ db: Db; publish: PublishEvent | undefined }> | undefined;

async function depsFromEnv(env = process.env) {
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return {
    db: createDb(url, { applicationName: 'ondes-worker-log-horizon' }).db,
    publish: await eventPublisherFromEnv('ondes-worker-log-horizon', env),
  };
}

const log = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));

export const triggers = [logHorizonTrigger];

export default defineJob(
  LOG_HORIZON_JOB,
  logHorizonJobPayloadSchema,
  async (payload) => {
    deps ??= depsFromEnv().catch((error: unknown) => {
      deps = undefined;
      throw error;
    });
    const { db, publish } = await deps;
    const scope = await resolveStationScope(db, payload.orgId, payload.stationId);
    const report = await runLogHorizon({ db, publish, log }, scope, payload);
    if (!report || (report.missing.length === 0 && report.regenerated.length === 0)) return;
    log({
      level: 'info',
      msg: 'log horizon',
      stationId: payload.stationId,
      missing: report.missing,
      regenerated: report.regenerated,
      changed: report.runs.flatMap((r) => r.days.filter((d) => d.changed).map((d) => d.localDate)),
      issues: report.runs.map(issueSummary),
    });
  },
  { lane: 'bulk' },
);
