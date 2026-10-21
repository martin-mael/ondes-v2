import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CachedFileInput,
  cacheLogFingerprint,
  type Db,
  forgetCacheFiles,
  getStationCache,
  listCacheHorizon,
  markCacheFileFailed,
  markCacheFileReady,
  reconcileCacheFiles,
  recordCachePass,
  type StationScope,
} from '@ondes/db';
import type { CacheFileError, CacheObject } from '@ondes/shared';
import { ObjectNotFoundError, type Storage } from '@ondes/storage';
import {
  ChecksumMismatchError,
  diskSpace,
  evict,
  fetchToCache,
  isOnDisk,
  listLocked,
  listPartials,
  scanCache,
  Throttle,
  touch,
  withFileLock,
} from './layout.ts';
import {
  diskReserveBytes,
  HOUR,
  type HorizonItem,
  type Need,
  type Plan,
  pinnedWindow,
  plan,
} from './planner.ts';

// One cache-sync pass for a station (ADR 0004):
//   1. scan media/ (disk is the source of truth for what's cached);
//   2. plan from the log horizon (pure, planner.ts);
//   3. drop stale partial files, evict what the plan says, bump the LRU stamp of kept files,
//      reconcile `playout_cache_file` with the disk;
//   4. fetch the missing files in air-time order, a few at a time, each verified and renamed
//      into place, then recorded `ready` (or `failed`, which doesn't fail the pass);
//   5. record the pass on `station_cache` (budget use, deferred files, disk low).
// If the log changed during the pass (its enqueue was collapsed by the job's in-flight key),
// run another one.

export type CacheSyncDeps = {
  db: Db;
  storage: Storage;
  /** Host directory holding one directory per station (`<root>/<stationId>`). */
  cacheRoot: string;
  /** Process-wide download slots shared by every station (default 8). */
  slots: Limiter;
  /** Concurrent downloads per station. Default 4. */
  concurrency?: number;
  /** Defaults for stations without their own settings. */
  defaults?: { budgetBytes?: number; horizonHours?: number };
  /** Free space the host keeps, from the filesystem size. Default 5 % or 2 GB. */
  diskReserve?: (totalBytes: number) => number;
  now?: () => number;
};

export type FetchFailure = Need & { error: CacheFileError; message: string };

export type CachePassReport = {
  passes: number;
  plan: Plan;
  fetched: Need[];
  failed: FetchFailure[];
  /** Planned files another process was downloading (left to it). */
  busy: Need[];
  partialsRemoved: number;
  diskLow: boolean;
};

export function stationCacheDir(cacheRoot: string, stationId: string): string {
  return join(cacheRoot, stationId);
}

/** Syncs one station; repeats (up to 3 passes) while the log keeps changing under it. */
export async function syncStation(
  deps: CacheSyncDeps,
  scope: StationScope,
  signal?: AbortSignal,
): Promise<CachePassReport> {
  for (let passes = 1; ; passes++) {
    const now = (deps.now ?? Date.now)();
    const settings = await getStationCache(deps.db, scope, deps.defaults);
    const window = pinnedWindow(now, { horizonMs: settings.horizonHours * HOUR });
    const range = { from: new Date(window.from), to: new Date(window.to) };
    const before = await cacheLogFingerprint(deps.db, scope, range);
    const report = await passOnce(deps, scope, { now, range, settings }, signal);
    const after = await cacheLogFingerprint(deps.db, scope, range);
    if (after === before || passes >= 3 || signal?.aborted) return { ...report, passes };
  }
}

async function passOnce(
  deps: CacheSyncDeps,
  scope: StationScope,
  input: {
    now: number;
    range: { from: Date; to: Date };
    settings: Awaited<ReturnType<typeof getStationCache>>;
  },
  signal?: AbortSignal,
): Promise<Omit<CachePassReport, 'passes'>> {
  const { db } = deps;
  const root = stationCacheDir(deps.cacheRoot, scope.stationId);
  await mkdir(join(root, 'media'), { recursive: true, mode: 0o755 });

  const rows = await listCacheHorizon(db, scope, input.range);
  const items: HorizonItem[] = [];
  for (const r of rows) {
    if (!r.sha256 || !r.ext || r.sizeBytes === null || !r.storageKey) continue;
    items.push({
      sha256: r.sha256,
      ext: r.ext,
      sizeBytes: r.sizeBytes,
      key: r.storageKey,
      airAt: r.airAt.getTime(),
      durationMs: r.durationMs,
    });
  }
  const cached = await scanCache(root);
  const locked = await listLocked(root);
  const p = plan({
    now: input.now,
    horizonMs: input.range.to.getTime() - input.now,
    pinPastMs: input.now - input.range.from.getTime(),
    items,
    cached,
    budgetBytes: input.settings.budgetBytes,
    inFlight: locked,
  });

  // Partial files of objects no longer planned are dropped; planned ones are resumed.
  const planned = new Set(p.fetch.map((f) => `${f.sha256}.${f.ext}.part`));
  let partialsRemoved = 0;
  for (const name of await listPartials(root)) {
    if (planned.has(name) || locked.has(name.slice(0, 64))) continue;
    await rm(join(root, '.partial', name), { force: true });
    partialsRemoved++;
  }

  for (const e of p.evict) await evict(root, e);
  await forgetCacheFiles(
    db,
    scope,
    p.evict.map((e) => e.sha256),
  );
  // mtime = last planned air time, so the LRU order follows the log, not download time.
  const lastAir = new Map(p.keep.map((k) => [k.sha256, k.lastAirAt]));
  for (const k of p.keep) {
    if (k.lastAirAt > k.lastNeededAt + 1000) await touch(root, k, k.lastAirAt);
  }
  const evicted = new Set(p.evict.map((e) => e.sha256));
  const onDisk: CachedFileInput[] = cached
    .filter((c) => !evicted.has(c.sha256))
    .map((c) => ({
      sha256: c.sha256,
      ext: c.ext,
      sizeBytes: c.sizeBytes,
      lastNeededAt: new Date(Math.max(c.lastNeededAt, lastAir.get(c.sha256) ?? 0)),
    }));
  await reconcileCacheFiles(db, scope, { onDisk, needed: p.needed });

  const reserve = deps.diskReserve ?? ((total) => diskReserveBytes(total));
  let diskLow = false;
  const roomFor = async (bytes: number) => {
    const space = await diskSpace(root);
    if (space.freeBytes - bytes < reserve(space.totalBytes)) diskLow = true;
    return !diskLow;
  };
  await roomFor(0);

  const throttle = input.settings.bytesPerSec
    ? new Throttle(input.settings.bytesPerSec)
    : undefined;
  const fetched: Need[] = [];
  const failed: FetchFailure[] = [];
  const busy: Need[] = [];
  const queue = [...p.fetch];
  const worker = async () => {
    for (;;) {
      const n = queue.shift();
      if (!n || signal?.aborted || diskLow) return;
      if (!(await roomFor(n.sizeBytes))) return;
      const outcome = await deps.slots.run(() =>
        fetchOne(deps, scope, root, n, n.lastAirAt, { throttle, signal }),
      );
      if (outcome.kind === 'fetched') fetched.push(n);
      else if (outcome.kind === 'busy') busy.push(n);
      else if (outcome.kind === 'failed') failed.push({ ...n, ...outcome });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, deps.concurrency ?? 4) }, worker));

  const finalDisk = await scanCache(root);
  await recordCachePass(db, scope, {
    usedBytes: finalDisk.reduce((s, f) => s + f.sizeBytes, 0),
    horizonBytes: p.usage.horizonBytes,
    deferred: p.deferred.map((d) => d.sha256),
    diskLow,
  });
  return { plan: p, fetched, failed, busy, partialsRemoved, diskLow };
}

export type FetchOutcome =
  | { kind: 'fetched' }
  | { kind: 'present' }
  | { kind: 'busy' }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: CacheFileError; message: string };

/**
 * Fetches one file under its lock and records the outcome. `wait`: wait for another
 * process's download of the same file instead of leaving it to that process.
 */
export async function fetchOne(
  deps: Pick<CacheSyncDeps, 'db' | 'storage'>,
  scope: StationScope,
  root: string,
  file: CacheObject & { sizeBytes: number; key: string },
  lastNeededAt: number,
  options: { throttle?: Throttle; signal?: AbortSignal; wait?: boolean } = {},
): Promise<FetchOutcome> {
  const record = { sha256: file.sha256, ext: file.ext, sizeBytes: file.sizeBytes };
  try {
    const locked = await withFileLock(
      root,
      file,
      async (): Promise<FetchOutcome> => {
        if (await isOnDisk(root, file)) return { kind: 'present' };
        await fetchToCache(deps.storage, root, file.key, file, options);
        return { kind: 'fetched' };
      },
      { wait: options.wait, signal: options.signal },
    );
    if (!locked) return { kind: 'busy' };
    await touch(root, file, lastNeededAt);
    await markCacheFileReady(deps.db, scope, { ...record, lastNeededAt: new Date(lastNeededAt) });
    return locked.value;
  } catch (err) {
    if (options.signal?.aborted) return { kind: 'aborted' };
    const error: CacheFileError =
      err instanceof ObjectNotFoundError
        ? 'source_missing'
        : err instanceof ChecksumMismatchError
          ? 'checksum_mismatch'
          : 'io';
    const message = err instanceof Error ? err.message : String(err);
    await markCacheFileFailed(deps.db, scope, { ...record, error, message });
    return { kind: 'failed', error, message };
  }
}

/** A counting semaphore: at most `size` tasks at once, the rest wait in order. */
export type Limiter = { run<T>(fn: () => Promise<T>): Promise<T> };

export function createLimiter(size: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async run(fn) {
      if (active >= size) await new Promise<void>((resolve) => waiting.push(resolve));
      else active++;
      try {
        return await fn();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active--;
      }
    },
  };
}
