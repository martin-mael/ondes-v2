import { describe, expect, it } from 'vitest';
import {
  assertQuota,
  chargeStoredObject,
  createMemoryQuotaStore,
  measureOrgUsage,
  QuotaExceededError,
  reconcileOrgUsage,
  releaseStoredObject,
} from './quota.ts';
import type { ListedObject, Storage } from './storage.ts';

describe('quota accounting', () => {
  it('rejects uploads over the limit', async () => {
    const store = createMemoryQuotaStore({ o: 100 });
    await chargeStoredObject(store, 'o', 60);
    await expect(assertQuota(store, 'o', 40)).resolves.toEqual({ usedBytes: 60, limitBytes: 100 });
    await expect(assertQuota(store, 'o', 41)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('treats a null limit as unlimited', async () => {
    const store = createMemoryQuotaStore();
    await expect(assertQuota(store, 'o', Number.MAX_SAFE_INTEGER)).resolves.toBeDefined();
  });

  it('does not double count deduplicated objects', async () => {
    const store = createMemoryQuotaStore();
    await chargeStoredObject(store, 'o', 10);
    expect(await chargeStoredObject(store, 'o', 10, { alreadyExisted: true })).toBe(10);
  });

  it('releases bytes without going negative', async () => {
    const store = createMemoryQuotaStore();
    await chargeStoredObject(store, 'o', 10);
    expect(await releaseStoredObject(store, 'o', 4)).toBe(6);
    expect(await releaseStoredObject(store, 'o', 100)).toBe(0);
  });

  it('rejects invalid byte counts', async () => {
    const store = createMemoryQuotaStore();
    await expect(chargeStoredObject(store, 'o', -1)).rejects.toThrow();
    await expect(assertQuota(store, 'o', 1.5)).rejects.toThrow();
  });

  it('measures and reconciles from the bucket listing', async () => {
    const objects: Record<string, ListedObject[]> = {
      'org/o/': [
        { key: 'org/o/sha256/a.flac', size: 7, etag: 'x' },
        { key: 'org/o/sha256/b.mp3', size: 5, etag: 'y' },
      ],
    };
    const storage = {
      async *list(prefix: string) {
        yield* objects[prefix] ?? [];
      },
    } as unknown as Storage;
    const store = createMemoryQuotaStore();
    await store.set('o', 999);
    expect(await measureOrgUsage(storage, 'o')).toBe(12);
    expect(await reconcileOrgUsage(storage, store, 'o')).toBe(12);
    expect((await store.get('o')).usedBytes).toBe(12);
  });
});
