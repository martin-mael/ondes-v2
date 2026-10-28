import { createHash } from 'node:crypto';

// One shared, in-memory snapshot per key (a station, a slug) for the public API (#74, ADR
// 0041). Every anonymous reader of a station gets the same serialised body: it is built at most
// once at a time (concurrent readers wait for the same build), kept until it expires or an
// event invalidates it, and carries an ETag so clients can revalidate for free. Per process:
// each api replica keeps its own, fed by the same event fanout.

export interface Snapshot<T> {
  value: T;
  /** The JSON body, serialised once. */
  body: string;
  /** Strong ETag of the content (quoted). */
  etag: string;
  builtAt: number;
  /** After this (ms epoch) the next read rebuilds it. */
  expiresAt: number;
}

export interface SnapshotCacheOptions<T> {
  /** Longest a snapshot is kept without an event. */
  ttlMs: number;
  /** Keys kept; the oldest built is evicted first. */
  maxEntries: number;
  /** An earlier expiry the value itself names (a show block ending). */
  expiresAt?: (value: T, builtAt: number) => number | null;
  /**
   * What the ETag hashes: by default the body. Fields that change on every build without
   * changing the content (the snapshot's own `at`) are left out here.
   */
  fingerprint?: (value: T) => unknown;
  now?: () => number;
}

export interface SnapshotCache<K, T> {
  get(key: K): Promise<Snapshot<T>>;
  /** The next read of `key` rebuilds it (a build in flight is not reused either). */
  invalidate(key: K): void;
  clear(): void;
  readonly size: number;
}

export const etagOf = (content: string) =>
  `"${createHash('sha256').update(content).digest('base64url').slice(0, 27)}"`;

/** Whether an `If-None-Match` header matches `etag` (weak comparison, RFC 9110 §13.1.2). */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const value = Array.isArray(header) ? header.join(',') : header;
  if (value.trim() === '*') return true;
  const strip = (tag: string) => tag.trim().replace(/^W\//, '');
  const wanted = strip(etag);
  return value.split(',').some((tag) => strip(tag) === wanted);
}

export function createSnapshotCache<K, T>(
  build: (key: K) => Promise<T>,
  options: SnapshotCacheOptions<T>,
): SnapshotCache<K, T> {
  const now = options.now ?? Date.now;
  const entries = new Map<K, Snapshot<T>>();
  const building = new Map<K, { generation: number; promise: Promise<Snapshot<T>> }>();
  const generations = new Map<K, number>();
  const generationOf = (key: K) => generations.get(key) ?? 0;

  const rebuild = (key: K) => {
    const generation = generationOf(key);
    const promise = (async () => {
      const value = await build(key);
      const builtAt = now();
      const body = JSON.stringify(value);
      const fingerprint = options.fingerprint ? JSON.stringify(options.fingerprint(value)) : body;
      const named = options.expiresAt?.(value, builtAt) ?? null;
      const snapshot: Snapshot<T> = {
        value,
        body,
        etag: etagOf(fingerprint),
        builtAt,
        expiresAt: Math.min(builtAt + options.ttlMs, named ?? Number.POSITIVE_INFINITY),
      };
      // Invalidated while building: hand it to the readers already waiting, keep nothing.
      if (generationOf(key) === generation) {
        entries.delete(key);
        entries.set(key, snapshot);
        while (entries.size > options.maxEntries) {
          const oldest = entries.keys().next();
          if (oldest.done) break;
          entries.delete(oldest.value);
        }
      }
      return snapshot;
    })().finally(() => {
      if (building.get(key)?.promise === promise) building.delete(key);
    });
    building.set(key, { generation, promise });
    return promise;
  };

  return {
    get(key) {
      const cached = entries.get(key);
      if (cached && cached.expiresAt > now()) return Promise.resolve(cached);
      const inFlight = building.get(key);
      if (inFlight && inFlight.generation === generationOf(key)) return inFlight.promise;
      return rebuild(key);
    },
    invalidate(key) {
      entries.delete(key);
      generations.set(key, generationOf(key) + 1);
      // Bounded like the entries: a generation only matters while a build is in flight.
      if (generations.size > options.maxEntries * 2) {
        for (const k of generations.keys()) if (!building.has(k)) generations.delete(k);
      }
    },
    clear() {
      for (const key of [...entries.keys(), ...building.keys()]) {
        generations.set(key, generationOf(key) + 1);
      }
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
