import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getCacheSourceFile, type StationScope } from '@ondes/db';
import { diskSpace } from './layout.ts';
import { diskReserveBytes } from './planner.ts';
import { type CacheSyncDeps, type FetchOutcome, fetchOne, stationCacheDir } from './sync.ts';

/**
 * The feeder's urgent fetch (#29, `cache-fetch` job): one file it is about to push. Ignores
 * the station's budget (the next pass evicts to make up for it) but not the host's free-space
 * reserve. Waits for another process already downloading the file rather than skipping it.
 */
export async function urgentFetch(
  deps: CacheSyncDeps,
  scope: StationScope,
  assetFileId: string,
  signal?: AbortSignal,
): Promise<FetchOutcome | { kind: 'unknown_file' } | { kind: 'disk_low' }> {
  const file = await getCacheSourceFile(deps.db, scope, assetFileId);
  if (!file) return { kind: 'unknown_file' };
  const root = stationCacheDir(deps.cacheRoot, scope.stationId);
  await mkdir(join(root, 'media'), { recursive: true, mode: 0o755 });
  const space = await diskSpace(root);
  const reserve = (deps.diskReserve ?? ((total) => diskReserveBytes(total)))(space.totalBytes);
  if (space.freeBytes - file.sizeBytes < reserve) return { kind: 'disk_low' };
  return deps.slots.run(() =>
    fetchOne(deps, scope, root, file, (deps.now ?? Date.now)(), { signal, wait: true }),
  );
}
