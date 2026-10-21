import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readdir, rename, rm, stat, statfs, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type CacheObject, playoutRelPath } from '@ondes/shared';
import type { Storage } from '@ondes/storage';

// A station's playout cache on disk (ADR 0004), ported from the spike (engine/spikes/cache):
//
//   <root>/                          <cache root>/<stationId>, read-only at /cache in the engine
//     media/<aa>/<sha256>.<ext>      final files, mode 0444, only ever created by rename(2)
//     .partial/<sha256>.<ext>.part   downloads in progress (same filesystem: rename is atomic)
//     .partial/<sha256>.<ext>.lock   held by the process downloading that file
//     safety/, emergency.flac        the template's fallbacks: outside media/, never touched
//
// The engine is only ever given paths under media/, so it can never open a partial file.

const MEDIA_FILE = /^([0-9a-f]{64})\.([a-z0-9]{1,10})$/;

export type CachedFile = CacheObject & { sizeBytes: number; lastNeededAt: number };

/** Every complete file under `media/`. `lastNeededAt` is the file's mtime (see {@link touch}). */
export async function scanCache(root: string): Promise<CachedFile[]> {
  const out: CachedFile[] = [];
  const media = join(root, 'media');
  let shards: string[];
  try {
    shards = await readdir(media);
  } catch {
    return out;
  }
  for (const shard of shards) {
    let names: string[];
    try {
      names = await readdir(join(media, shard));
    } catch {
      continue;
    }
    for (const name of names) {
      const m = MEDIA_FILE.exec(name);
      if (!m?.[1] || !m[2] || m[1].slice(0, 2) !== shard) continue;
      try {
        const st = await stat(join(media, shard, name));
        out.push({ sha256: m[1], ext: m[2], sizeBytes: st.size, lastNeededAt: st.mtimeMs });
      } catch {
        // Evicted meanwhile.
      }
    }
  }
  return out;
}

/**
 * Records when a file was last needed, as its mtime: the LRU order needs no database and
 * survives worker restarts; `noatime` mounts don't matter since atime isn't used.
 */
export async function touch(root: string, obj: CacheObject, at: number): Promise<void> {
  const d = new Date(at);
  await utimes(join(root, playoutRelPath(obj)), d, d);
}

export async function evict(root: string, obj: CacheObject): Promise<void> {
  await rm(join(root, playoutRelPath(obj)), { force: true });
}

export async function isOnDisk(root: string, obj: CacheObject): Promise<boolean> {
  try {
    await stat(join(root, playoutRelPath(obj)));
    return true;
  } catch {
    return false;
  }
}

export class ChecksumMismatchError extends Error {
  override name = 'ChecksumMismatchError';
  constructor(expected: string, actual: string) {
    super(`sha256 mismatch: expected ${expected}, got ${actual}`);
  }
}

/** Shared download throttle (token bucket, bytes per second across every download). */
export class Throttle {
  private readonly rate: number;
  private allowance: number;
  private last = performance.now();

  constructor(bytesPerSec: number) {
    this.rate = bytesPerSec;
    this.allowance = bytesPerSec / 10;
  }

  async take(n: number): Promise<void> {
    for (;;) {
      const now = performance.now();
      this.allowance = Math.min(
        this.rate / 10,
        this.allowance + ((now - this.last) / 1000) * this.rate,
      );
      this.last = now;
      if (this.allowance >= n || this.allowance >= this.rate / 10) {
        this.allowance -= n;
        return;
      }
      await new Promise((r) => setTimeout(r, Math.ceil(((n - this.allowance) / this.rate) * 1000)));
    }
  }

  transform(): Transform {
    const t = this;
    return new Transform({
      transform(chunk: Buffer, _enc, cb: TransformCallback) {
        t.take(chunk.length).then(() => cb(null, chunk), cb);
      },
    });
  }
}

export type FetchOptions = {
  signal?: AbortSignal;
  throttle?: Throttle;
};

export type FetchResult = {
  path: string;
  /** Bytes downloaded by this call. */
  bytes: number;
  /** Bytes already on disk from an interrupted attempt (fetched with a Range request). */
  resumedFrom: number;
};

/**
 * Downloads `key` into the cache: append to `.partial/<file>.part` (resuming with a Range
 * request), hash while writing, check size and sha256, fsync, chmod 0444, rename into
 * `media/`, fsync the directory. A mismatch after a resume starts over once from byte 0 (the
 * bytes on disk may be the bad ones); a mismatch of a full download deletes the partial file
 * and throws {@link ChecksumMismatchError}: the object itself is wrong.
 *
 * Callers hold the file's lock ({@link withFileLock}): two writers must not append to one
 * partial file.
 */
export async function fetchToCache(
  storage: Storage,
  root: string,
  key: string,
  obj: CacheObject & { sizeBytes: number },
  options: FetchOptions = {},
): Promise<FetchResult> {
  const part = partialPath(root, obj);
  await mkdir(join(root, '.partial'), { recursive: true });

  let resumedFrom = 0;
  try {
    resumedFrom = (await stat(part)).size;
  } catch {}
  if (resumedFrom > obj.sizeBytes) {
    await rm(part, { force: true });
    resumedFrom = 0;
  }
  try {
    const bytes = await download(storage, part, key, obj, resumedFrom, options);
    return { path: await publish(root, part, obj), bytes, resumedFrom };
  } catch (error) {
    if (!(error instanceof ChecksumMismatchError) || resumedFrom === 0) throw error;
  }
  const bytes = await download(storage, part, key, obj, 0, options);
  return { path: await publish(root, part, obj), bytes, resumedFrom: 0 };
}

function partialPath(root: string, obj: CacheObject): string {
  return join(root, '.partial', `${obj.sha256}.${obj.ext}.part`);
}

/** Appends the object to `part` from `offset` and verifies the whole file. */
async function download(
  storage: Storage,
  part: string,
  key: string,
  obj: CacheObject & { sizeBytes: number },
  offset: number,
  options: FetchOptions,
): Promise<number> {
  if (offset === 0) await rm(part, { force: true });
  const hash = createHash('sha256');
  // Seed the hash with what is already on disk.
  if (offset > 0) await pipeline(createReadStream(part), hash, { end: false });

  let bytes = offset;
  if (offset < obj.sizeBytes || obj.sizeBytes === 0) {
    const res = await storage.get(key, offset > 0 ? { range: { start: offset } } : {});
    const fh = await open(part, 'a');
    try {
      const sink = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          bytes += chunk.length;
          fh.write(chunk).then(() => cb(), cb);
        },
      });
      if (options.throttle) {
        await pipeline(res.body, options.throttle.transform(), sink, { signal: options.signal });
      } else {
        await pipeline(res.body, sink, { signal: options.signal });
      }
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  const actual = hash.digest('hex');
  if (bytes !== obj.sizeBytes || actual !== obj.sha256) {
    await rm(part, { force: true });
    throw new ChecksumMismatchError(obj.sha256, `${actual} (${bytes} of ${obj.sizeBytes} bytes)`);
  }
  return bytes - offset;
}

/** chmod 0444, rename into media/, fsync the directory. */
async function publish(root: string, part: string, obj: CacheObject): Promise<string> {
  const final = join(root, playoutRelPath(obj));
  await chmod(part, 0o444);
  const dir = join(root, 'media', obj.sha256.slice(0, 2));
  await mkdir(dir, { recursive: true, mode: 0o755 });
  await rename(part, final);
  const dh = await open(dir, 'r');
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
  return final;
}

// --- Locks -------------------------------------------------------------------------------

/** A lock whose download wrote nothing for this long belongs to a dead process. */
const STALE_LOCK_MS = 120_000;

/**
 * Runs `fn` holding the download lock of one file (`.partial/<file>.lock`, created with
 * O_EXCL), across worker processes sharing the cache root. Null when another process holds it
 * and `wait` is false. A lock is stale when neither it nor its partial file changed for
 * two minutes (a crashed worker); it is then taken over.
 */
export async function withFileLock<T>(
  root: string,
  obj: CacheObject,
  fn: () => Promise<T>,
  options: { wait?: boolean; signal?: AbortSignal; staleMs?: number } = {},
): Promise<{ value: T } | null> {
  const dir = join(root, '.partial');
  const lock = join(dir, `${obj.sha256}.${obj.ext}.lock`);
  await mkdir(dir, { recursive: true });
  for (;;) {
    try {
      const fh = await open(lock, 'wx');
      await fh.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (await isStale(lock, partialPath(root, obj), options.staleMs ?? STALE_LOCK_MS)) {
      await rm(lock, { force: true });
      continue;
    }
    if (!options.wait || options.signal?.aborted) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
  // Keep the lock fresh while the download runs (a throttled one may write slowly).
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(lock, now, now).catch(() => {});
  }, 10_000);
  try {
    return { value: await fn() };
  } finally {
    clearInterval(heartbeat);
    await rm(lock, { force: true });
  }
}

async function isStale(lock: string, part: string, staleMs: number): Promise<boolean> {
  let newest = 0;
  for (const path of [lock, part]) {
    try {
      newest = Math.max(newest, (await stat(path)).mtimeMs);
    } catch {}
  }
  // A lock that vanished meanwhile: try again at once.
  return newest === 0 || Date.now() - newest > staleMs;
}

/** Files being downloaded by any process right now (their lock exists). */
export async function listLocked(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const name of await listDir(join(root, '.partial'))) {
    const m = /^([0-9a-f]{64})\.[a-z0-9]{1,10}\.lock$/.exec(name);
    if (m?.[1]) out.add(m[1]);
  }
  return out;
}

/** Partial downloads on disk (`<sha256>.<ext>.part`), for cleanup of objects that left the plan. */
export async function listPartials(root: string): Promise<string[]> {
  return (await listDir(join(root, '.partial'))).filter((n) => n.endsWith('.part'));
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Free and total bytes of the filesystem holding `path` (for the host safety reserve). */
export async function diskSpace(path: string): Promise<{ freeBytes: number; totalBytes: number }> {
  const s = await statfs(path);
  return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
}
