import { createDb } from '@ondes/db';
import { createS3Storage, loadStorageConfig } from '@ondes/storage';
import { eventPublisherFromEnv } from '../_events/asset-updated.ts';
import { defaultTools } from '../ingest/ffmpeg.ts';
import type { AutocueDeps } from './autocue.ts';

// Like ingest, the job and its trigger open their own database pool and storage client from
// the environment, on first use (importing the folder stays free, which the registry relies on).

let deps: Promise<AutocueDeps> | undefined;

export function autocueDeps(env = process.env): Promise<AutocueDeps> {
  deps ??= fromEnv(env).catch((error: unknown) => {
    deps = undefined;
    throw error;
  });
  return deps;
}

async function fromEnv(env: Record<string, string | undefined>): Promise<AutocueDeps> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const database = createDb(databaseUrl, { applicationName: 'ondes-worker-autocue' });
  return {
    db: database.db,
    storage: createS3Storage(loadStorageConfig(env)),
    tools: defaultTools(env),
    tmpDir: env.AUTOCUE_TMP_DIR || env.INGEST_TMP_DIR || undefined,
    log: (entry) => console.log(JSON.stringify(entry)),
    publish: await eventPublisherFromEnv('ondes-worker-autocue', env),
  };
}
