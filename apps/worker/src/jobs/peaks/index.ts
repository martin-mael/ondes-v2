import { createDb } from '@ondes/db';
import { defineJob } from '@ondes/queue';
import { PEAKS_JOB, peaksIdempotencyKey, peaksJobPayloadSchema } from '@ondes/shared';
import { createS3Storage, loadStorageConfig } from '@ondes/storage';
import { defaultTools } from '../ingest/ffmpeg.ts';
import { generateAssetPeaks, type PeaksDeps } from './peaks.ts';
import { peaksTrigger } from './trigger.ts';

// `peaks` job (#22): enqueued for each `asset.ingested` (trigger.ts) and by the backfill
// (backfill.ts). See peaks.ts.
//
// Jobs get no dependencies from the worker, so this one opens its own database pool and
// storage client from the environment, on first use (importing it stays free).

let deps: Promise<PeaksDeps> | undefined;

async function depsFromEnv(env = process.env): Promise<PeaksDeps> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const database = createDb(databaseUrl, { applicationName: 'ondes-worker-peaks' });
  return {
    db: database.db,
    storage: createS3Storage(loadStorageConfig(env)),
    tools: defaultTools(env),
    tmpDir: env.INGEST_TMP_DIR || undefined,
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

export const triggers = [peaksTrigger];

export default defineJob(
  PEAKS_JOB,
  peaksJobPayloadSchema,
  async (payload, ctx) => {
    deps ??= depsFromEnv().catch((error: unknown) => {
      deps = undefined;
      throw error;
    });
    await generateAssetPeaks(await deps, payload, ctx);
  },
  { lane: 'bulk', idempotencyKey: peaksIdempotencyKey },
);
