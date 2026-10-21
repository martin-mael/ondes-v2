import { parseArgs } from 'node:util';
import { createDb, type Db, listAssetsNeedingAutocue, listAutocueStations } from '@ondes/db';
import { connectQueue, createJobPublisher, type JobPublisher } from '@ondes/queue';
import { autocueSettingsOf } from '@ondes/shared';
import { autocueAnalyzerVersion } from './autocue.ts';
import { enqueueAutocue } from './trigger.ts';

// Autocue backfill (#20): enqueues an `autocue` job for every asset whose playout copy has no
// cues from its station's current analyzer version: ingested before #20 or while no worker
// ran, or analysed by an older algorithm (`AUTOCUE_ALGORITHM_VERSION`) or with other station
// thresholds (`engine_settings.autocue`). Run it after deploying a new algorithm or changing
// thresholds. Safe to run any time: the jobs carry the trigger's explicit keys.
//
//   pnpm --filter @ondes/worker autocue:backfill [--station <id>]... [--dry-run]

export interface BackfillOptions {
  /** Only these stations (default: all). */
  stationIds?: readonly string[];
  /** Count without enqueuing. */
  dryRun?: boolean;
  /** Page size of the asset query. */
  batchSize?: number;
}

/** Returns the number of jobs enqueued (or that would be, on a dry run), per station. */
export async function backfillAutocue(
  deps: { db: Db; jobs: JobPublisher },
  options: BackfillOptions = {},
): Promise<Record<string, number>> {
  const wanted = options.stationIds ? new Set(options.stationIds) : undefined;
  const counts: Record<string, number> = {};
  for (const { scope, engineSettings } of await listAutocueStations(deps.db)) {
    if (wanted && !wanted.has(scope.stationId)) continue;
    const analyzerVersion = autocueAnalyzerVersion(autocueSettingsOf(engineSettings));
    let count = 0;
    let after: string | undefined;
    for (;;) {
      const page = await listAssetsNeedingAutocue(deps.db, scope, analyzerVersion, {
        after,
        limit: options.batchSize ?? 500,
      });
      for (const asset of page) {
        if (!options.dryRun) {
          await enqueueAutocue(deps.jobs, { ...scope, ...asset, analyzerVersion });
        }
        count++;
      }
      const last = page.at(-1);
      if (!last) break;
      after = last.assetId;
    }
    counts[scope.stationId] = count;
  }
  return counts;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      station: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const databaseUrl = process.env.DATABASE_URL;
  const rabbitUrl = process.env.RABBITMQ_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  if (!rabbitUrl) throw new Error('RABBITMQ_URL is not set');
  const database = createDb(databaseUrl, { applicationName: 'ondes-autocue-backfill' });
  const queue = await connectQueue(rabbitUrl, { connectionName: 'ondes-autocue-backfill' });
  const jobs = createJobPublisher(queue.rabbit, queue.topology);
  try {
    const counts = await backfillAutocue(
      { db: database.db, jobs },
      { stationIds: values.station, dryRun: values['dry-run'] },
    );
    console.log(
      JSON.stringify({ level: 'info', msg: 'autocue backfill', dryRun: values['dry-run'], counts }),
    );
  } finally {
    await jobs.close();
    await queue.close();
    await database.close();
  }
}
