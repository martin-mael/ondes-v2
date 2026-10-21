import { parseArgs } from 'node:util';
import {
  createDb,
  type Db,
  listAssetsNeedingLoudness,
  resolveStationScope,
  station,
} from '@ondes/db';
import { connectQueue, createJobPublisher, type JobPublisher } from '@ondes/queue';
import { enqueueLoudness } from './trigger.ts';

// Loudness backfill (#19): enqueues a `loudness` job for every asset whose playout copy has no
// measurement (ingested before #19, or whose `asset.ingested` event was lost while no worker
// ran). Safe to run any time, as often as wanted: the jobs carry the same explicit keys
// as the trigger's, so an asset measured meanwhile, or already queued, runs once.
//
//   pnpm --filter @ondes/worker loudness:backfill [--station <id>]... [--dry-run]

export interface BackfillOptions {
  /** Only these stations (default: all). */
  stationIds?: readonly string[];
  /** Count without enqueuing. */
  dryRun?: boolean;
  /** Page size of the asset query. */
  batchSize?: number;
}

/** Returns the number of jobs enqueued (or that would be, on a dry run), per station. */
export async function backfillLoudness(
  deps: { db: Db; jobs: JobPublisher },
  options: BackfillOptions = {},
): Promise<Record<string, number>> {
  // Station ids only, to scope each station's query below.
  const stations = await deps.db.select({ id: station.id, orgId: station.orgId }).from(station);
  const wanted = options.stationIds ? new Set(options.stationIds) : undefined;
  const counts: Record<string, number> = {};
  for (const { id, orgId } of stations) {
    if (wanted && !wanted.has(id)) continue;
    const scope = await resolveStationScope(deps.db, orgId, id);
    let count = 0;
    let after: string | undefined;
    for (;;) {
      const page = await listAssetsNeedingLoudness(deps.db, scope, {
        limit: options.batchSize ?? 500,
        after,
      });
      for (const asset of page) {
        if (!options.dryRun) await enqueueLoudness(deps.jobs, { orgId, stationId: id, ...asset });
        count++;
      }
      const last = page.at(-1);
      if (!last) break;
      after = last.assetId;
    }
    counts[id] = count;
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
  const database = createDb(databaseUrl, { applicationName: 'ondes-loudness-backfill' });
  const queue = await connectQueue(rabbitUrl, { connectionName: 'ondes-loudness-backfill' });
  const jobs = createJobPublisher(queue.rabbit, queue.topology);
  try {
    const counts = await backfillLoudness(
      { db: database.db, jobs },
      { stationIds: values.station, dryRun: values['dry-run'] },
    );
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'loudness backfill',
        dryRun: values['dry-run'],
        counts,
      }),
    );
  } finally {
    await jobs.close();
    await queue.close();
    await database.close();
  }
}
