import { parseArgs } from 'node:util';
import { createDb, type Db, listAllStationScopes, listAssetsNeedingPeaks } from '@ondes/db';
import { connectQueue, createJobPublisher, type JobPublisher } from '@ondes/queue';
import { uuidSchema } from '@ondes/shared';
import { z } from 'zod';
import { enqueuePeaks } from './trigger.ts';

// Peaks backfill (#22): enqueues a `peaks` job for every asset whose playout copy has no peaks
// file in the current format: ingested before #22 or while no worker ran, or computed with an
// older `PEAKS_FORMAT_VERSION`. Run it after bumping the format. Safe to run any time: the jobs
// carry the trigger's explicit keys.
//
//   pnpm --filter @ondes/worker peaks:backfill [--station <id>]... [--dry-run]

export interface BackfillOptions {
  /** Only these stations (default: all). */
  stationIds?: readonly string[];
  /** Count without enqueuing. */
  dryRun?: boolean;
  /** Page size of the asset query. */
  batchSize?: number;
}

/** Returns the number of jobs enqueued (or that would be, on a dry run), per station. */
export async function backfillPeaks(
  deps: { db: Db; jobs: JobPublisher },
  options: BackfillOptions = {},
): Promise<Record<string, number>> {
  const wanted = options.stationIds ? new Set(options.stationIds) : undefined;
  const counts: Record<string, number> = {};
  for (const scope of await listAllStationScopes(deps.db)) {
    if (wanted && !wanted.has(scope.stationId)) continue;
    let count = 0;
    let after: string | undefined;
    for (;;) {
      const page = await listAssetsNeedingPeaks(deps.db, scope, {
        after,
        limit: options.batchSize ?? 500,
      });
      for (const asset of page) {
        if (!options.dryRun) await enqueuePeaks(deps.jobs, { ...scope, ...asset });
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
  const stationIds = z.array(uuidSchema).optional().safeParse(values.station);
  if (!stationIds.success) throw new Error('--station takes station ids (UUIDs)');
  const databaseUrl = process.env.DATABASE_URL;
  const rabbitUrl = process.env.RABBITMQ_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  if (!rabbitUrl) throw new Error('RABBITMQ_URL is not set');
  const database = createDb(databaseUrl, { applicationName: 'ondes-peaks-backfill' });
  const queue = await connectQueue(rabbitUrl, { connectionName: 'ondes-peaks-backfill' });
  const jobs = createJobPublisher(queue.rabbit, queue.topology);
  try {
    const counts = await backfillPeaks(
      { db: database.db, jobs },
      { stationIds: stationIds.data, dryRun: values['dry-run'] },
    );
    console.log(
      JSON.stringify({ level: 'info', msg: 'peaks backfill', dryRun: values['dry-run'], counts }),
    );
  } finally {
    await jobs.close();
    await queue.close();
    await database.close();
  }
}
