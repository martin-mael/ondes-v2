import { createDb } from '@ondes/db';
import { connectQueue, createEventPublisher, defineJob } from '@ondes/queue';
import {
  INGEST_JOB,
  ingestIdempotencyKey,
  ingestJobPayloadSchema,
  realtimeEventSchema,
} from '@ondes/shared';
import { createS3Storage, loadStorageConfig } from '@ondes/storage';
import { defaultTools } from './ffmpeg.ts';
import { type IngestDeps, ingest } from './ingest.ts';

// `ingest` job (#18), enqueued by the api's upload `complete`. See ingest.ts.
//
// Jobs get no dependencies from the worker, so this one opens its own database pool, storage
// client and event publisher from the environment, on first use (importing it stays free,
// which the registry relies on).

let deps: Promise<IngestDeps> | undefined;

async function depsFromEnv(env = process.env): Promise<IngestDeps> {
  const databaseUrl = env.DATABASE_URL;
  const rabbitUrl = env.RABBITMQ_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  if (!rabbitUrl) throw new Error('RABBITMQ_URL is not set');
  const database = createDb(databaseUrl, { applicationName: 'ondes-worker-ingest' });
  const queue = await connectQueue(rabbitUrl, { connectionName: 'ondes-worker-ingest' });
  const events = createEventPublisher(queue.rabbit, queue.topology, realtimeEventSchema);
  return {
    db: database.db,
    storage: createS3Storage(loadStorageConfig(env)),
    tools: defaultTools(env),
    publish: (event) => events.publish(event),
    tmpDir: env.INGEST_TMP_DIR || undefined,
  };
}

export default defineJob(
  INGEST_JOB,
  ingestJobPayloadSchema,
  async (payload, ctx) => {
    deps ??= depsFromEnv().catch((error: unknown) => {
      deps = undefined;
      throw error;
    });
    await ingest(await deps, payload, ctx);
  },
  { lane: 'bulk', idempotencyKey: ingestIdempotencyKey },
);
