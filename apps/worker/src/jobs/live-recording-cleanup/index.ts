import { createDb, type Db, liveRecordingStations } from '@ondes/db';
import { connectQueue, createEventPublisher, defineJob, type JobPublisher } from '@ondes/queue';
import {
  LIVE_RECORDING_CLEANUP_JOB,
  liveRecordingCleanupJobPayloadSchema,
  realtimeEventSchema,
} from '@ondes/shared';
import { cacheRootFromEnv } from '../cache-sync/deps.ts';
import { recordingsDir } from '../live-recording/build.ts';
import { type CleanupDeps, cleanupLiveRecordings, ensureDir } from './cleanup.ts';

// `live-recording-cleanup` job (#67, ADR 0039): a station's retention sweep (cleanup.ts),
// enqueued for every station by `startLiveRecordingCleanupSweep` (worker main). The sweep
// runs every 10 min, to make new stations' recordings directories early; the job is keyed by
// station and hour, so it runs at most hourly and replicas' sweeps collapse.

let deps: Promise<CleanupDeps> | undefined;

async function depsFromEnv(env = process.env): Promise<CleanupDeps> {
  const databaseUrl = env.DATABASE_URL;
  const rabbitUrl = env.RABBITMQ_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  if (!rabbitUrl) throw new Error('RABBITMQ_URL is not set');
  const database = createDb(databaseUrl, {
    applicationName: 'ondes-worker-live-recording-cleanup',
  });
  const queue = await connectQueue(rabbitUrl, {
    connectionName: 'ondes-worker-live-recording-cleanup',
  });
  const events = createEventPublisher(queue.rabbit, queue.topology, realtimeEventSchema);
  return {
    db: database.db,
    cacheRoot: cacheRootFromEnv(env) ?? null,
    publish: (event) => events.publish(event),
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

const job = defineJob(
  LIVE_RECORDING_CLEANUP_JOB,
  liveRecordingCleanupJobPayloadSchema,
  async (payload, ctx) => {
    if (!payload.stationId || !ctx.orgId) return;
    deps ??= depsFromEnv().catch((error: unknown) => {
      deps = undefined;
      throw error;
    });
    await cleanupLiveRecordings(await deps, { orgId: ctx.orgId, stationId: payload.stationId });
  },
  { lane: 'bulk' },
);
export default job;

export type LiveRecordingCleanupSweep = { sweep(): Promise<number>; close(): void };

/**
 * Every 10 min: makes each station's recordings directory (cleanup.ts says why), when this
 * worker keeps the caches, and enqueues the station's hourly cleanup.
 */
export function startLiveRecordingCleanupSweep(options: {
  db: Db;
  jobs: JobPublisher;
  intervalMs?: number;
  cacheRoot?: string | null;
  stations?: (db: Db) => Promise<{ orgId: string; stationId: string }[]>;
  onError?: (err: unknown) => void;
}): LiveRecordingCleanupSweep {
  const onError = options.onError ?? (() => {});
  async function sweep() {
    const stations = await (options.stations ?? liveRecordingStations)(options.db);
    const hour = new Date().toISOString().slice(0, 13);
    for (const s of stations) {
      if (options.cacheRoot) {
        await ensureDir(recordingsDir(options.cacheRoot, s.stationId)).catch(onError);
      }
      await options.jobs.enqueue(
        job,
        { stationId: s.stationId },
        {
          idempotencyKey: `live-recording-cleanup:${s.stationId}:${hour}`,
          orgId: s.orgId,
          stationId: s.stationId,
        },
      );
    }
    return stations.length;
  }
  const intervalMs = options.intervalMs ?? 10 * 60 * 1000;
  let timer: NodeJS.Timeout | undefined;
  if (intervalMs > 0) {
    timer = setInterval(() => void sweep().catch(onError), intervalMs);
    void sweep().catch(onError);
  }
  return {
    sweep,
    close() {
      clearInterval(timer);
    },
  };
}
