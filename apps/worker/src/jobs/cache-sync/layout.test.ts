import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { playoutRelPath } from '@ondes/shared';
import { ObjectNotFoundError, type Storage } from '@ondes/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ChecksumMismatchError,
  fetchToCache,
  listLocked,
  scanCache,
  touch,
  withFileLock,
} from './layout.ts';

/** Just `get` (with ranges), from memory; counts calls. */
function memoryStorage(objects: Map<string, Buffer>) {
  const calls: Array<{ key: string; start: number }> = [];
  const storage = {
    async get(key: string, options: { range?: { start: number } } = {}) {
      const data = objects.get(key);
      if (!data) throw new ObjectNotFoundError(key);
      const start = options.range?.start ?? 0;
      calls.push({ key, start });
      const body = data.subarray(start);
      return { body: Readable.from([body]), contentLength: body.length, etag: '"x"' };
    },
  } as unknown as Storage;
  return { storage, calls };
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ondes-cache-layout-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('fetchToCache', () => {
  it('downloads, verifies and renames into media/ read-only', async () => {
    const data = randomBytes(100_000);
    const obj = { sha256: sha(data), ext: 'flac', sizeBytes: data.length };
    const { storage } = memoryStorage(new Map([['k', data]]));
    const r = await fetchToCache(storage, root, 'k', obj);
    expect(r).toMatchObject({ bytes: data.length, resumedFrom: 0 });
    expect(r.path).toBe(join(root, playoutRelPath(obj)));
    expect(await readFile(r.path)).toEqual(data);
    expect((await stat(r.path)).mode & 0o777).toBe(0o444);
    expect(await scanCache(root)).toMatchObject([{ sha256: obj.sha256, sizeBytes: data.length }]);
  });

  it('resumes a partial download with a range request', async () => {
    const data = randomBytes(100_000);
    const obj = { sha256: sha(data), ext: 'flac', sizeBytes: data.length };
    await mkdir(join(root, '.partial'), { recursive: true });
    await writeFile(join(root, '.partial', `${obj.sha256}.flac.part`), data.subarray(0, 40_000));
    const { storage, calls } = memoryStorage(new Map([['k', data]]));
    const r = await fetchToCache(storage, root, 'k', obj);
    expect(r).toMatchObject({ bytes: 60_000, resumedFrom: 40_000 });
    expect(calls).toEqual([{ key: 'k', start: 40_000 }]);
    expect(await readFile(r.path)).toEqual(data);
  });

  it('starts over once when the resumed bytes were corrupt', async () => {
    const data = randomBytes(100_000);
    const obj = { sha256: sha(data), ext: 'flac', sizeBytes: data.length };
    await mkdir(join(root, '.partial'), { recursive: true });
    await writeFile(join(root, '.partial', `${obj.sha256}.flac.part`), randomBytes(40_000));
    const { storage, calls } = memoryStorage(new Map([['k', data]]));
    const r = await fetchToCache(storage, root, 'k', obj);
    expect(calls.map((c) => c.start)).toEqual([40_000, 0]);
    expect(r.resumedFrom).toBe(0);
    expect(await readFile(r.path)).toEqual(data);
  });

  it('rejects an object that does not match its hash, leaving nothing behind', async () => {
    const data = randomBytes(1000);
    const obj = { sha256: sha(randomBytes(1000)), ext: 'flac', sizeBytes: 1000 };
    const { storage } = memoryStorage(new Map([['k', data]]));
    await expect(fetchToCache(storage, root, 'k', obj)).rejects.toBeInstanceOf(
      ChecksumMismatchError,
    );
    expect(await scanCache(root)).toEqual([]);
    await expect(stat(join(root, '.partial', `${obj.sha256}.flac.part`))).rejects.toThrow();
  });

  it('rejects a size mismatch', async () => {
    const data = randomBytes(1000);
    const obj = { sha256: sha(data), ext: 'flac', sizeBytes: 999 };
    const { storage } = memoryStorage(new Map([['k', data]]));
    await expect(fetchToCache(storage, root, 'k', obj)).rejects.toBeInstanceOf(
      ChecksumMismatchError,
    );
  });

  it('reports a missing object', async () => {
    const { storage } = memoryStorage(new Map());
    await expect(
      fetchToCache(storage, root, 'k', { sha256: 'a'.repeat(64), ext: 'flac', sizeBytes: 1 }),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
  });
});

describe('scanCache', () => {
  it('lists media/ only: fallbacks and stray files are never cache entries', async () => {
    const data = randomBytes(10);
    const obj = { sha256: sha(data), ext: 'flac', sizeBytes: 10 };
    await fetchToCache(memoryStorage(new Map([['k', data]])).storage, root, 'k', obj);
    await mkdir(join(root, 'safety'), { recursive: true });
    await writeFile(join(root, 'safety', 'a.flac'), 'x');
    await writeFile(join(root, 'emergency.flac'), 'x');
    await mkdir(join(root, 'media', 'zz'), { recursive: true });
    await writeFile(join(root, 'media', 'zz', 'not-a-hash.flac'), 'x');
    await touch(root, obj, Date.parse('2026-01-01T00:00:00Z'));
    expect(await scanCache(root)).toEqual([
      { ...obj, lastNeededAt: Date.parse('2026-01-01T00:00:00Z') },
    ]);
  });
});

describe('withFileLock', () => {
  const obj = { sha256: 'b'.repeat(64), ext: 'flac' };

  it('lets one holder in at a time', async () => {
    let release = () => {};
    const held = withFileLock(root, obj, () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 20));
    expect(await listLocked(root)).toEqual(new Set([obj.sha256]));
    expect(await withFileLock(root, obj, async () => 1)).toBeNull();
    const waiting = withFileLock(root, obj, async () => 2, { wait: true });
    release();
    expect(await held).toEqual({ value: undefined });
    expect(await waiting).toEqual({ value: 2 });
    expect(await listLocked(root)).toEqual(new Set());
  });

  it('takes over a stale lock', async () => {
    await mkdir(join(root, '.partial'), { recursive: true });
    const lock = join(root, '.partial', `${obj.sha256}.flac.lock`);
    await writeFile(lock, '');
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lock, old, old);
    expect(await withFileLock(root, obj, async () => 'mine')).toEqual({ value: 'mine' });
  });
});
