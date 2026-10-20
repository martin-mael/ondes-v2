// Playout cache on disk (spike #15): content-addressed paths and atomic, verified,
// resumable downloads from object storage.
//
//   <root>/                          one volume per station, mounted read-only in the engine
//     media/<aa>/<sha256>.<ext>      final files, mode 0444, only ever created by rename(2)
//     .partial/<sha256>.<ext>.part   downloads in progress (same filesystem, so rename is atomic)
//
// The engine is only ever given paths under media/, so it can never open a partial file.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Storage } from '../../../packages/storage/src/index.ts';

const SHA256 = /^[0-9a-f]{64}$/;
const EXT = /^[a-z0-9]{1,10}$/;
const MEDIA_FILE = /^([0-9a-f]{64})\.([a-z0-9]{1,10})$/;

export type CacheObject = { sha256: string; ext: string };

/** Path of a cached file relative to the cache root: `media/<aa>/<sha256>.<ext>`. */
export function playoutRelPath({ sha256, ext }: CacheObject): string {
  if (!SHA256.test(sha256)) throw new Error(`Invalid sha256: ${sha256}`);
  if (!EXT.test(ext)) throw new Error(`Invalid extension: ${ext}`);
  return `media/${sha256.slice(0, 2)}/${sha256}.${ext}`;
}

/**
 * Path resolver for the feeder: the URI pushed to the engine. `engineRoot` is where the
 * station volume is mounted inside the engine container (`/cache`).
 */
export function enginePath(engineRoot: string, obj: CacheObject): string {
  return `${engineRoot.replace(/\/$/, '')}/${playoutRelPath(obj)}`;
}

export type CachedFile = CacheObject & { sizeBytes: number; lastNeededAt: number };

/** Every complete file in the cache. `lastNeededAt` is the file's mtime (see {@link touch}). */
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
    for (const name of await readdir(join(media, shard))) {
      const m = MEDIA_FILE.exec(name);
      if (!m?.[1] || !m[2] || m[1].slice(0, 2) !== shard) continue;
      const st = await stat(join(media, shard, name));
      out.push({ sha256: m[1], ext: m[2], sizeBytes: st.size, lastNeededAt: st.mtimeMs });
    }
  }
  return out;
}

/**
 * Records when a file was last needed, as its mtime. The LRU order needs no database and
 * survives worker restarts; `noatime` mounts don't matter since atime isn't used.
 */
export async function touch(root: string, obj: CacheObject, at: number): Promise<void> {
  const d = new Date(at);
  await utimes(join(root, playoutRelPath(obj)), d, d);
}

export async function evict(root: string, obj: CacheObject): Promise<void> {
  await rm(join(root, playoutRelPath(obj)), { force: true });
}

export class ChecksumMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`sha256 mismatch: expected ${expected}, got ${actual}`);
    this.name = 'ChecksumMismatchError';
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
  /** Test hook: called with the running byte count after every chunk written. */
  onProgress?: (bytes: number) => void;
};

export type FetchResult = {
  path: string;
  bytes: number;
  /** Bytes already on disk from an interrupted attempt (fetched with a Range request). */
  resumedFrom: number;
  ms: number;
};

/**
 * Downloads `key` into the cache: append to `.partial/<file>.part` (resuming with a Range
 * request), hash while writing, check size and sha256, fsync, chmod 0444, rename into
 * `media/`, fsync the directory. A mismatch deletes the partial file and throws.
 */
export async function fetchToCache(
  storage: Storage,
  root: string,
  key: string,
  obj: CacheObject & { sizeBytes: number },
  options: FetchOptions = {},
): Promise<FetchResult> {
  const t0 = performance.now();
  const rel = playoutRelPath(obj);
  const final = join(root, rel);
  const partialDir = join(root, '.partial');
  const part = join(partialDir, `${obj.sha256}.${obj.ext}.part`);
  await mkdir(partialDir, { recursive: true });

  const hash = createHash('sha256');
  let resumedFrom = 0;
  try {
    resumedFrom = (await stat(part)).size;
  } catch {}
  if (resumedFrom > obj.sizeBytes) {
    await rm(part, { force: true });
    resumedFrom = 0;
  }
  if (resumedFrom > 0) {
    // Seed the hash with what is already on disk.
    await pipeline(createReadStream(part), hash, { end: false });
  }

  let bytes = resumedFrom;
  if (resumedFrom < obj.sizeBytes) {
    const res = await storage.get(key, resumedFrom > 0 ? { range: { start: resumedFrom } } : {});
    const fh = await open(part, 'a');
    try {
      const sink = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          bytes += chunk.length;
          fh.write(chunk).then(() => {
            options.onProgress?.(bytes);
            cb();
          }, cb);
        },
      });
      const stages: Array<NodeJS.ReadableStream | NodeJS.WritableStream> = [res.body];
      if (options.throttle) stages.push(options.throttle.transform());
      stages.push(sink);
      // @ts-expect-error variadic pipeline overload
      await pipeline(...stages, { signal: options.signal });
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  const actual = hash.digest('hex');
  if (bytes !== obj.sizeBytes || actual !== obj.sha256) {
    await rm(part, { force: true });
    throw new ChecksumMismatchError(obj.sha256, `${actual} (${bytes} bytes)`);
  }
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
  return { path: final, bytes: bytes - resumedFrom, resumedFrom, ms: performance.now() - t0 };
}

/** Partial downloads on disk, for cleanup of objects that left the plan. */
export async function listPartials(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, '.partial'))).filter((n) => n.endsWith('.part'));
  } catch {
    return [];
  }
}
