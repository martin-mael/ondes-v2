import { createDb } from '@ondes/db';
import { createS3Storage, loadStorageConfig } from '@ondes/storage';
import { type CacheSyncDeps, createLimiter } from './sync.ts';

// Jobs get no dependencies from the worker, so the cache jobs open their own database pool and
// storage client from the environment, on first use (importing a job stays free, which the
// registry relies on). Shared by `cache-sync` and `cache-fetch`, so both draw on one pool of
// download slots.
//
// PLAYOUT_CACHE_ROOT: the host directory of the station caches as the worker sees it (the
//   engines mount `<ENGINE_CACHE_ROOT>/<stationId>`; on one host both are the same path, the
//   default). Unset: the worker keeps no cache and the cache jobs do nothing.
// CACHE_BUDGET_GB (40), CACHE_HORIZON_HOURS (48): defaults for stations without settings.
// CACHE_CONCURRENCY (4 per station), CACHE_WORKER_DOWNLOADS (8 per process).

export function cacheRootFromEnv(env = process.env): string | undefined {
  return env.PLAYOUT_CACHE_ROOT || env.ENGINE_CACHE_ROOT || undefined;
}

function positive(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

let deps: Promise<CacheSyncDeps | null> | undefined;

async function depsFromEnv(env = process.env): Promise<CacheSyncDeps | null> {
  const cacheRoot = cacheRootFromEnv(env);
  if (!cacheRoot) return null;
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const database = createDb(databaseUrl, { applicationName: 'ondes-worker-cache' });
  const budgetGb = positive(env, 'CACHE_BUDGET_GB');
  return {
    db: database.db,
    storage: createS3Storage(loadStorageConfig(env)),
    cacheRoot,
    slots: createLimiter(positive(env, 'CACHE_WORKER_DOWNLOADS') ?? 8),
    concurrency: positive(env, 'CACHE_CONCURRENCY') ?? 4,
    defaults: {
      budgetBytes: budgetGb ? Math.round(budgetGb * 1024 ** 3) : undefined,
      horizonHours: positive(env, 'CACHE_HORIZON_HOURS'),
    },
  };
}

/** The cache jobs' dependencies, or null when this worker keeps no cache. */
export function cacheDeps(): Promise<CacheSyncDeps | null> {
  deps ??= depsFromEnv().catch((error: unknown) => {
    deps = undefined;
    throw error;
  });
  return deps;
}
