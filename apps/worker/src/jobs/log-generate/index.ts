import { createDb, type Db, resolveStationScope } from '@ondes/db';
import { defineJob } from '@ondes/queue';
import { LOG_GENERATE_JOB, logGenerateJobPayloadSchema } from '@ondes/shared';
import { eventPublisherFromEnv, type PublishEvent } from '../_events/asset-updated.ts';
import { issueSummary, runLogGenerate } from './generate.ts';

// `log-generate` job (#50, ADR 0026): generates consecutive days of a station's log and
// writes them. See generate.ts. Enqueued by #101's regeneration routes (`POST …/log/regen`);
// the horizon (`log-horizon`) runs it inline. No event triggers it.
//
// Bulk lane: days are generated well ahead of air. No explicit idempotency key: the payload
// hash collapses duplicates, and a rerun writes the same days (deterministic).

let deps: Promise<{ db: Db; publish: PublishEvent | undefined }> | undefined;

async function depsFromEnv(env = process.env) {
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return {
    db: createDb(url, { applicationName: 'ondes-worker-log-generate' }).db,
    publish: await eventPublisherFromEnv('ondes-worker-log-generate', env),
  };
}

const log = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));

export default defineJob(
  LOG_GENERATE_JOB,
  logGenerateJobPayloadSchema,
  async (payload) => {
    deps ??= depsFromEnv().catch((error: unknown) => {
      deps = undefined;
      throw error;
    });
    const { db, publish } = await deps;
    const scope = await resolveStationScope(db, payload.orgId, payload.stationId);
    const report = await runLogGenerate({ db, publish, log }, scope, payload);
    if (!report) return;
    log({
      level: 'info',
      msg: 'log generated',
      stationId: payload.stationId,
      days: report.days.map((d) => ({
        localDate: d.localDate,
        version: d.version,
        items: d.itemCount,
        kept: d.keptCount,
        changed: d.changed,
      })),
      issues: issueSummary(report),
    });
  },
  { lane: 'bulk' },
);
