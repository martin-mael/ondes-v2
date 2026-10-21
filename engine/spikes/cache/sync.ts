// Cache sync executor (spike #15): scan disk, plan, evict, fetch in air-time order with a
// concurrency limit and a shared bandwidth throttle. #31 turns this into a worker job.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  contentKey,
  ObjectNotFoundError,
  type Storage,
} from '../../../packages/storage/src/index.ts';
import {
  type CachedFile,
  evict,
  fetchToCache,
  listPartials,
  scanCache,
  Throttle,
  touch,
} from './layout.ts';
import { type HorizonItem, type Need, type Plan, plan } from './planner.ts';

export type SyncOptions = {
  storage: Storage;
  orgId: string;
  root: string;
  budgetBytes: number;
  concurrency: number;
  /** Shared cap for all downloads of this station, bytes/s. Unlimited when unset. */
  bytesPerSec?: number;
  horizonMs?: number;
};

export type Fetched = Need & { readyAt: number; ms: number; bytes: number; resumedFrom: number };
export type Failed = Need & { error: string; sourceMissing: boolean };

export type SyncReport = {
  plan: Plan;
  fetched: Fetched[];
  failed: Failed[];
  evicted: CachedFile[];
  partialsRemoved: number;
  bytes: number;
  ms: number;
};

export async function syncOnce(
  opts: SyncOptions,
  items: readonly HorizonItem[],
  now: number,
  signal?: AbortSignal,
): Promise<SyncReport> {
  const t0 = performance.now();
  const cached = await scanCache(opts.root);
  const p = plan({
    now,
    horizonMs: opts.horizonMs,
    items,
    cached,
    budgetBytes: opts.budgetBytes,
  });

  // Partial files of objects no longer planned are dropped; planned ones are resumed.
  const planned = new Set(p.fetch.map((f) => `${f.sha256}.${f.ext}.part`));
  let partialsRemoved = 0;
  for (const name of await listPartials(opts.root)) {
    if (!planned.has(name)) {
      await rm(join(opts.root, '.partial', name), { force: true });
      partialsRemoved++;
    }
  }

  for (const e of p.evict) await evict(opts.root, e);
  // mtime = last planned air time, so LRU order follows the log rather than download time.
  for (const k of p.keep) {
    if (k.lastAirAt > k.lastNeededAt) await touch(opts.root, k, k.lastAirAt);
  }

  const throttle = opts.bytesPerSec ? new Throttle(opts.bytesPerSec) : undefined;
  const fetched: Fetched[] = [];
  const failed: Failed[] = [];
  const queue = [...p.fetch];
  const worker = async () => {
    for (;;) {
      const n = queue.shift();
      if (!n || signal?.aborted) return;
      try {
        const key = contentKey({ orgId: opts.orgId, sha256: n.sha256, ext: n.ext });
        const r = await fetchToCache(opts.storage, opts.root, key, n, { throttle, signal });
        await touch(opts.root, n, n.firstAirAt);
        fetched.push({
          ...n,
          readyAt: performance.now() - t0,
          ms: r.ms,
          bytes: r.bytes,
          resumedFrom: r.resumedFrom,
        });
      } catch (err) {
        if (signal?.aborted) return;
        failed.push({
          ...n,
          error: err instanceof Error ? err.message : String(err),
          sourceMissing: err instanceof ObjectNotFoundError,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));

  return {
    plan: p,
    fetched,
    failed,
    evicted: p.evict,
    partialsRemoved,
    bytes: fetched.reduce((s, f) => s + f.bytes, 0),
    ms: performance.now() - t0,
  };
}
