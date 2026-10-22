import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createDb } from '@ondes/db';
import { defineJob } from '@ondes/queue';
import { ISLAND_RENDER_JOB, islandRenderJobPayloadSchema } from '@ondes/shared';
import { createS3Storage, loadStorageConfig } from '@ondes/storage';
import { eventPublisherFromEnv } from '../_events/asset-updated.ts';
import { cacheDeps } from '../cache-sync/deps.ts';
import { fetchOne, stationCacheDir } from '../cache-sync/sync.ts';
import { defaultTools } from '../ingest/ffmpeg.ts';
import { type IslandRenderDeps, renderIsland } from './render.ts';

// `island-render` job (#56, ADR 0018): enqueued by the api after each sync that leaves an
// island `pending` (apps/api/src/modules/segues/render.ts) and by the sweep (sweep.ts). High
// lane: an island not rendered by air time airs as the degraded crossfade. See render.ts.
//
// Jobs get no dependencies from the worker, so this one opens its own database pool, storage
// client and event publisher from the environment, on first use (importing it stays free).

let deps: Promise<IslandRenderDeps> | undefined;

async function depsFromEnv(env = process.env): Promise<IslandRenderDeps> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const database = createDb(databaseUrl, { applicationName: 'ondes-worker-island-render' });
  const storage = createS3Storage(loadStorageConfig(env));
  return {
    db: database.db,
    storage,
    tools: defaultTools(env),
    tmpDir: env.INGEST_TMP_DIR || undefined,
    publish: await eventPublisherFromEnv('ondes-worker-island-render', env),
    log: (entry) => console.log(JSON.stringify(entry)),
    // With a playout cache on this worker, the render goes straight into the station's cache
    // (same lock, checks and `playout_cache_file` record as cache-sync).
    cache: async (scope, file) => {
      const cache = await cacheDeps();
      if (!cache) return;
      const root = stationCacheDir(cache.cacheRoot, scope.stationId);
      await mkdir(join(root, 'media'), { recursive: true, mode: 0o755 });
      const outcome = await fetchOne(
        cache,
        scope,
        root,
        { sha256: file.sha256, ext: 'flac', sizeBytes: file.sizeBytes, key: file.storageKey },
        Date.now(),
        { wait: true },
      );
      if (outcome.kind === 'failed') throw new Error(`${outcome.error}: ${outcome.message}`);
    },
  };
}

export default defineJob(
  ISLAND_RENDER_JOB,
  islandRenderJobPayloadSchema,
  async (payload, ctx) => {
    deps ??= depsFromEnv().catch((error: unknown) => {
      deps = undefined;
      throw error;
    });
    await renderIsland(await deps, payload, { signal: ctx.signal, jobId: ctx.jobId });
  },
  { lane: 'high' },
);
