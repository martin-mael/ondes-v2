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
  const K1 = 'org/o/sha256/aa.flac';
  const K2 = 'org/o/sha256/bb.flac';

  it('rejects uploads over the limit', async () => {
    const store = createMemoryQuotaStore({ o: 100 });
    await chargeStoredObject(store, 'o', K1, 60);
    await expect(assertQuota(store, 'o', 40)).resolves.toEqual({ usedBytes: 60, limitBytes: 100 });
    await expect(assertQuota(store, 'o', 41)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('treats a null limit as unlimited', async () => {
    const store = createMemoryQuotaStore();
    await expect(assertQuota(store, 'o', Number.MAX_SAFE_INTEGER)).resolves.toBeDefined();
  });

  it('charges a shared object once, even for concurrent references', async () => {
    const store = createMemoryQuotaStore();
    const totals = await Promise.all([
      chargeStoredObject(store, 'o', K1, 10),
      chargeStoredObject(store, 'o', K1, 10),
    ]);
    expect(Math.max(...totals)).toBe(10);
    expect((await store.get('o')).usedBytes).toBe(10);
  });

  it('deletes a shared object only when its last reference goes', async () => {
    const store = createMemoryQuotaStore();
    const deleted: string[] = [];
    const storage = { delete: async (key: string) => void deleted.push(key) };
    await chargeStoredObject(store, 'o', K1, 10);
    await chargeStoredObject(store, 'o', K1, 10); // a second asset with the same content
    await chargeStoredObject(store, 'o', K2, 5);

    expect(await releaseStoredObject(storage, store, 'o', K1)).toEqual({
      usedBytes: 15,
      deleted: false,
    });
    expect(deleted).toEqual([]);
    expect(await releaseStoredObject(storage, store, 'o', K1)).toEqual({
      usedBytes: 5,
      deleted: true,
    });
    expect(deleted).toEqual([K1]);
    // Releasing an unknown reference is a no-op.
    expect(await releaseStoredObject(storage, store, 'o', K1)).toEqual({
      usedBytes: 5,
      deleted: false,
    });
  });

  it('rejects invalid byte counts', async () => {
    const store = createMemoryQuotaStore();
    await expect(chargeStoredObject(store, 'o', K1, -1)).rejects.toThrow();
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
