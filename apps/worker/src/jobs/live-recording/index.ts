import { createDb } from '@ondes/db';
import { connectQueue, createEventPublisher, defineJob, type JobPublisher } from '@ondes/queue';
import {
  LIVE_RECORDING_JOB,
  liveRecordingIdempotencyKey,
  liveRecordingJobPayloadSchema,
  type RealtimeEvent,
  realtimeEventSchema,
} from '@ondes/shared';
import { createS3Storage, loadStorageConfig } from '@ondes/storage';
import type { JobTrigger } from '../../registry.ts';
import { cacheRootFromEnv } from '../cache-sync/deps.ts';
import { defaultTools } from '../ingest/ffmpeg.ts';
import { buildLiveRecording, type LiveRecordingDeps } from './build.ts';

// `live-recording` job (#67, ADR 0039): builds a recording's audio from the engine's files.
// Started by `live.recording.updated` with status `pending` (the api's recorder, from the
// engine's `live.recording.closed`, or a manual rebuild). See build.ts.
//
// High lane: the acceptance is a rerun-ready episode within minutes of the show, which a
// backlog of library uploads on the bulk lane could not promise. A build is a few seconds of
// CPU per hour of audio plus the upload.
//
// Needs the station caches on this worker (PLAYOUT_CACHE_ROOT): the engine writes into
// `<cache>/<station>/recordings`.

let deps: Promise<LiveRecordingDeps> | undefined;

async function depsFromEnv(env = process.env): Promise<LiveRecordingDeps> {
  const databaseUrl = env.DATABASE_URL;
  const rabbitUrl = env.RABBITMQ_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  if (!rabbitUrl) throw new Error('RABBITMQ_URL is not set');
  const database = createDb(databaseUrl, { applicationName: 'ondes-worker-live-recording' });
  const queue = await connectQueue(rabbitUrl, { connectionName: 'ondes-worker-live-recording' });
  const events = createEventPublisher(queue.rabbit, queue.topology, realtimeEventSchema);
  return {
    db: database.db,
    storage: createS3Storage(loadStorageConfig(env)),
    tools: defaultTools(env),
    publish: (event) => events.publish(event),
    cacheRoot: cacheRootFromEnv(env) ?? null,
    tmpDir: env.INGEST_TMP_DIR || undefined,
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

const job = defineJob(
  LIVE_RECORDING_JOB,
  liveRecordingJobPayloadSchema,
  async (payload, ctx) => {
    deps ??= depsFromEnv().catch((error: unknown) => {
      deps = undefined;
      throw error;
    });
    await buildLiveRecording(await deps, payload, ctx);
  },
  { lane: 'high', idempotencyKey: liveRecordingIdempotencyKey },
);
export default job;

/** `live.recording.updated` (pending) → build that version. */
export const liveRecordingTrigger: JobTrigger = {
  queue: 'worker.live-recording',
  async onEvent(event: RealtimeEvent, jobs: JobPublisher) {
    if (event.type !== 'live.recording.updated' || event.data.status !== 'pending') return;
    const payload = {
      orgId: event.data.orgId,
      stationId: event.stationId,
      recordingId: event.data.recordingId,
      version: event.data.version,
    };
    await jobs.enqueue(job, payload, {
      idempotencyKey: liveRecordingIdempotencyKey(payload),
      orgId: payload.orgId,
      stationId: payload.stationId,
    });
  },
};

export const triggers = [liveRecordingTrigger];
