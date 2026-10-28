import { describe, expect, it } from 'vitest';
import { createSnapshotCache, etagMatches, etagOf } from './snapshot.ts';

// The shared public snapshot (#74): one build per key however many readers, invalidation,
// expiry, ETags.

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('createSnapshotCache', () => {
  it('builds once for concurrent readers and serves the same body after', async () => {
    let builds = 0;
    const gate = deferred<void>();
    const cache = createSnapshotCache(
      async (key: string) => {
        builds++;
        await gate.promise;
        return { key, n: builds };
      },
      { ttlMs: 10_000, maxEntries: 10 },
    );
    const readers = Array.from({ length: 100 }, () => cache.get('a'));
    gate.resolve();
    const results = await Promise.all(readers);
    expect(builds).toBe(1);
    expect(new Set(results).size).toBe(1);
    expect(await cache.get('a')).toBe(results[0]);
    expect(results[0]?.body).toBe('{"key":"a","n":1}');
  });

  it('rebuilds after invalidate, and does not keep a build that was invalidated mid-way', async () => {
    let n = 0;
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    const cache = createSnapshotCache(
      async () => {
        const gate = deferred<void>();
        gates.push(gate);
        n++;
        const mine = n;
        await gate.promise;
        return mine;
      },
      { ttlMs: 10_000, maxEntries: 10 },
    );
    const first = cache.get('a');
    cache.invalidate('a');
    // A reader after the invalidation doesn't join the stale build.
    const second = cache.get('a');
    gates[0]?.resolve();
    gates[1]?.resolve();
    expect((await first).value).toBe(1);
    expect((await second).value).toBe(2);
    expect((await cache.get('a')).value).toBe(2);
  });

  it('expires on its TTL or on the time the value names, whichever is first', async () => {
    let clock = 1_000;
    let n = 0;
    const cache = createSnapshotCache(async () => ({ n: ++n, endsAt: 1_500 }), {
      ttlMs: 10_000,
      maxEntries: 10,
      expiresAt: (value) => value.endsAt,
      now: () => clock,
    });
    expect((await cache.get('a')).expiresAt).toBe(1_500);
    clock = 1_499;
    expect((await cache.get('a')).value.n).toBe(1);
    clock = 1_500;
    expect((await cache.get('a')).value.n).toBe(2);
  });

  it('hashes the fingerprint, not the volatile fields', async () => {
    let n = 0;
    const cache = createSnapshotCache(async () => ({ at: ++n, content: 'same' }), {
      ttlMs: 0,
      maxEntries: 10,
      fingerprint: ({ at: _, ...rest }) => rest,
    });
    const a = await cache.get('a');
    const b = await cache.get('a');
    expect(a.body).not.toBe(b.body);
    expect(a.etag).toBe(b.etag);
  });

  it('evicts the oldest key past maxEntries', async () => {
    let builds = 0;
    const cache = createSnapshotCache(
      async (key: number) => {
        builds++;
        return key;
      },
      {
        ttlMs: 10_000,
        maxEntries: 2,
      },
    );
    await cache.get(1);
    await cache.get(2);
    await cache.get(3);
    expect(cache.size).toBe(2);
    await cache.get(1);
    expect(builds).toBe(4);
  });
});

describe('etagMatches', () => {
  const etag = etagOf('x');
  it('matches the tag, a list, weak forms and *', () => {
    expect(etagMatches(etag, etag)).toBe(true);
    expect(etagMatches(`"other", W/${etag}`, etag)).toBe(true);
    expect(etagMatches('*', etag)).toBe(true);
    expect(etagMatches('"other"', etag)).toBe(false);
    expect(etagMatches(undefined, etag)).toBe(false);
  });
});
