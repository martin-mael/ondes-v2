import { createDb } from '@ondes/db';
import { defineJob } from '@ondes/queue';
import { LOUDNESS_JOB, loudnessIdempotencyKey, loudnessJobPayloadSchema } from '@ondes/shared';
import { createS3Storage, loadStorageConfig } from '@ondes/storage';
import { defaultTools } from '../ingest/ffmpeg.ts';
import { type LoudnessDeps, measureAssetLoudness } from './loudness.ts';
import { loudnessTrigger } from './trigger.ts';

// `loudness` job (#19): enqueued for each `asset.ingested` (trigger.ts) and by the backfill
// (backfill.ts). See loudness.ts.
//
// Jobs get no dependencies from the worker, so this one opens its own database pool and
// storage client from the environment, on first use (importing it stays free).

let deps: Promise<LoudnessDeps> | undefined;

async function depsFromEnv(env = process.env): Promise<LoudnessDeps> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const database = createDb(databaseUrl, { applicationName: 'ondes-worker-loudness' });
  return {
    db: database.db,
    storage: createS3Storage(loadStorageConfig(env)),
    tools: defaultTools(env),
    tmpDir: env.INGEST_TMP_DIR || undefined,
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

export const triggers = [loudnessTrigger];

export default defineJob(
  LOUDNESS_JOB,
  loudnessJobPayloadSchema,
  async (payload, ctx) => {
    deps ??= depsFromEnv().catch((error: unknown) => {
      deps = undefined;
      throw error;
    });
    await measureAssetLoudness(await deps, payload, ctx);
  },
  { lane: 'bulk', idempotencyKey: loudnessIdempotencyKey },
);
