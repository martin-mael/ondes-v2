import { randomUUID } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type FallbackFileInput,
  type FallbackSource,
  listFallbackSources,
  recordFallbackSync,
  type StationScope,
} from '@ondes/db';
import {
  type CacheFileError,
  type CacheObject,
  EMERGENCY_FILE,
  playoutRelPath,
  SAFETY_DIR,
} from '@ondes/shared';
import { ObjectNotFoundError } from '@ondes/storage';
import {
  ChecksumMismatchError,
  diskSpace,
  fetchToCache,
  isOnDisk,
  type Throttle,
  withFileLock,
} from './layout.ts';
import { diskReserveBytes } from './planner.ts';
import type { CacheSyncDeps } from './sync.ts';

// The template's fallbacks (#34, ADR 0007): the station's safety playlist and emergency file,
// pinned in its cache for good, outside the evictable media/ tree:
//
//   safety/<sha256>.flac     one hard link per selected asset; the engine's playlist watches
//                            the directory and reloads when it changes
//   emergency.flac           a hard link, replaced by rename(2): the engine re-opens it on
//                            every loop, so a new file plays from the next loop on
//   .emergency.sha256        what emergency.flac holds, so a sync doesn't re-hash it
//
// Each file first lands in media/ like any other (verified download under its lock, see
// layout.ts), then is hard-linked into place: a link shares the verified bytes, costs no
// space while media/ keeps its copy, and survives that copy's eviction. Playout files are
// always FLAC (ingest, #18), hence the fixed extension the template expects.
//
// Runs at the end of every cache-sync job: the selection changes rarely, and the api enqueues
// a pass when it does. `safety/` always exists after a sync: Liquidsoap's watched playlist
// never picks up a directory created after the engine started (measured on 2.4.6).

const EXT = 'flac';
const EMERGENCY_SHA = '.emergency.sha256';
const SAFETY_FILE = /^([0-9a-f]{64})\.flac$/;

export type FallbackSyncReport = {
  /** Files linked into place by this sync. */
  linked: number;
  /** Safety files removed (deselected). */
  removed: number;
  failed: Array<{ sha256: string; error: CacheFileError; message: string }>;
  /** Fetching stopped: the disk is under its reserve. */
  diskLow: boolean;
};

export async function syncFallbacks(
  deps: Pick<CacheSyncDeps, 'db' | 'storage' | 'diskReserve'>,
  scope: StationScope,
  root: string,
  options: { throttle?: Throttle; signal?: AbortSignal } = {},
): Promise<FallbackSyncReport> {
  const safetyDir = join(root, SAFETY_DIR);
  await mkdir(safetyDir, { recursive: true, mode: 0o755 });
  const sources = await listFallbackSources(deps.db, scope);
  const report: FallbackSyncReport = { linked: 0, removed: 0, failed: [], diskLow: false };
  const rows: FallbackFileInput[] = [];

  const reserve = deps.diskReserve ?? ((total: number) => diskReserveBytes(total));
  const roomFor = async (bytes: number) => {
    if (report.diskLow) return false;
    const space = await diskSpace(root);
    if (space.freeBytes - bytes < reserve(space.totalBytes)) report.diskLow = true;
    return !report.diskLow;
  };

  /** Puts the file in place at `dest` (via media/); records its row. False if it isn't. */
  async function place(
    kind: 'safety' | 'emergency',
    file: FallbackSource,
    dest: string,
    alreadyThere: () => Promise<boolean>,
  ): Promise<boolean> {
    if (await alreadyThere()) {
      rows.push({ kind, sha256: file.sha256, state: 'ready' });
      return true;
    }
    const obj: CacheObject & { sizeBytes: number } = {
      sha256: file.sha256,
      ext: EXT,
      sizeBytes: file.sizeBytes,
    };
    try {
      const done = await withFileLock(
        root,
        obj,
        async () => {
          if (!(await isOnDisk(root, obj))) {
            if (!(await roomFor(obj.sizeBytes))) return false;
            await fetchToCache(deps.storage, root, file.storageKey, obj, options);
          }
          await linkInto(root, join(root, playoutRelPath(obj)), dest);
          return true;
        },
        { wait: true, signal: options.signal },
      );
      if (!done?.value) return false;
      report.linked++;
      rows.push({ kind, sha256: file.sha256, state: 'ready' });
      return true;
    } catch (err) {
      if (options.signal?.aborted) return false;
      const error: CacheFileError =
        err instanceof ObjectNotFoundError
          ? 'source_missing'
          : err instanceof ChecksumMismatchError
            ? 'checksum_mismatch'
            : 'io';
      const message = err instanceof Error ? err.message : String(err);
      report.failed.push({ sha256: file.sha256, error, message });
      rows.push({ kind, sha256: file.sha256, state: 'failed', error, errorMessage: message });
      return false;
    }
  }

  // Emergency first: it's the last thing between the station and silence.
  const emergencyPath = join(root, EMERGENCY_FILE);
  const shaPath = join(root, EMERGENCY_SHA);
  const emergency = sources.emergency;
  const onDisk = async () =>
    (await exists(emergencyPath))
      ? (await readFile(shaPath, 'utf8').catch(() => '')).trim() || null
      : null;
  if (emergency) {
    const current = async () => (await onDisk()) === emergency.sha256;
    if (await place('emergency', emergency, emergencyPath, current)) {
      await replaceFile(shaPath, `${emergency.sha256}\n`);
    }
  }
  if (sources.emergencySelected) {
    // The selected file couldn't be placed (not ingested yet, failed, no room): the previous
    // one keeps playing, since it beats silence. Record it so the api can say so.
    const previous = await onDisk();
    if (previous && previous !== emergency?.sha256) {
      rows.push({ kind: 'emergency', sha256: previous, state: 'ready' });
    }
  } else {
    // Cleared on purpose. A selected asset that isn't ingested yet keeps the previous file.
    await rm(emergencyPath, { force: true });
    await rm(shaPath, { force: true });
  }

  const wanted = new Set(sources.safety.map((s) => s.sha256));
  for (const name of await readdir(safetyDir)) {
    const sha = SAFETY_FILE.exec(name)?.[1];
    if (sha && wanted.has(sha)) continue;
    await rm(join(safetyDir, name), { recursive: true, force: true });
    report.removed++;
  }
  for (const file of sources.safety) {
    if (options.signal?.aborted) break;
    const dest = join(safetyDir, `${file.sha256}.${EXT}`);
    await place('safety', file, dest, () => exists(dest));
  }

  if (!options.signal?.aborted) await recordFallbackSync(deps.db, scope, rows);
  return report;
}

/**
 * Bytes of the fallback files (safety/, emergency.flac) that no file of `media` shares (its
 * copy was evicted, or never there): disk the cache budget must count, once per inode.
 */
export async function pinnedFallbackBytes(
  root: string,
  media: ReadonlyArray<{ ino?: number }>,
): Promise<number> {
  const shared = new Set(media.map((m) => m.ino));
  const seen = new Set<number>();
  let bytes = 0;
  const names = (await readdir(join(root, SAFETY_DIR)).catch(() => [] as string[])).map((n) =>
    join(SAFETY_DIR, n),
  );
  for (const name of [...names, EMERGENCY_FILE]) {
    const st = await stat(join(root, name)).catch(() => null);
    if (!st?.isFile() || shared.has(st.ino) || seen.has(st.ino)) continue;
    seen.add(st.ino);
    bytes += st.size;
  }
  return bytes;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hard-links `from` at `to`, atomically replacing whatever `to` was. The temporary link lives
 * in `.partial/` (same filesystem), never in the directory the engine watches.
 */
async function linkInto(root: string, from: string, to: string): Promise<void> {
  const tmp = join(root, '.partial', `${randomUUID()}.link`);
  await link(from, tmp);
  try {
    await rename(tmp, to);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

async function replaceFile(path: string, content: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { mode: 0o444 });
  await rename(tmp, path);
}
