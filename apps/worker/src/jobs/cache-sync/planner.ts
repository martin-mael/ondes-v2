import type { CacheObject } from '@ondes/shared';
import type { CachedFile } from './layout.ts';

// Cache sync planner (ADR 0004), pure: log horizon + what's on disk + budget → what to fetch
// (by air time), what to evict (least recently needed, outside the pinned window) and what
// doesn't fit. Ported from the spike (engine/spikes/cache/planner.ts).

export const HOUR = 3_600_000;

/** One log item's file. Times are epoch ms (UTC): the horizon is real time, never local. */
export type HorizonItem = CacheObject & {
  sizeBytes: number;
  /** Object storage key of the file. */
  key: string;
  airAt: number;
  durationMs: number;
};

export type Need = CacheObject & {
  sizeBytes: number;
  key: string;
  firstAirAt: number;
  lastAirAt: number;
  items: number;
};

export type Plan = {
  /** Missing files that fit the budget, earliest air time first. Fetch in this order. */
  fetch: Need[];
  /** Missing files that don't fit even after evicting everything outside the window. */
  deferred: Need[];
  /** Files to delete before fetching, least recently needed first. */
  evict: CachedFile[];
  /** Cached files in the pinned window, with their last planned air time (the new mtime). */
  keep: Array<CachedFile & { lastAirAt: number }>;
  /** Every hash the pinned window needs (cached or not). */
  needed: Set<string>;
  usage: { usedBytes: number; horizonBytes: number; budgetBytes: number };
};

/**
 * The pinned window, in UTC epoch ms: from `pinPastMs` ago (default 1 h) to `horizonMs` ahead
 * (default 48 h). It is real elapsed time, so a DST change (a 23 h or 25 h local day) neither
 * shortens nor stretches it.
 */
export function pinnedWindow(
  now: number,
  options: { horizonMs?: number; pinPastMs?: number } = {},
): { from: number; to: number } {
  return { from: now - (options.pinPastMs ?? HOUR), to: now + (options.horizonMs ?? 48 * HOUR) };
}

export type PlanInput = {
  now: number;
  /** Default 48 h. */
  horizonMs?: number;
  /**
   * Items that ended less than this long ago stay pinned too (default 1 h): the log can run
   * late, an item can be re-pushed after an engine restart, and as-run lags air time.
   */
  pinPastMs?: number;
  items: readonly HorizonItem[];
  cached: readonly CachedFile[];
  budgetBytes: number;
  /** Files another process is downloading right now: never planned twice, counted as used. */
  inFlight?: ReadonlySet<string>;
  /**
   * Bytes of the pinned fallback files (#34) that no file of `cached` shares: they count
   * against the budget, and nothing evicts them.
   */
  pinnedBytes?: number;
};

/**
 * Strict air-time priority: once a file doesn't fit, every later file is deferred too, so a
 * small late item never takes the space an earlier large one (a show) needs. Eviction is
 * lazy: files outside the window stay as a warm cache until their space is needed, since
 * rotation brings most tracks back within days. Nothing the window needs is ever evicted.
 */
export function plan(input: PlanInput): Plan {
  const { now, items, cached, budgetBytes } = input;
  const window = pinnedWindow(now, input);
  const inFlight = input.inFlight ?? new Set<string>();

  // firstAirAt counts upcoming items only; a file that only aired recently is pinned if
  // cached but never fetched.
  const needs = new Map<string, Need & { upcoming: boolean }>();
  for (const it of items) {
    if (it.airAt + it.durationMs <= window.from || it.airAt >= window.to) continue;
    const upcoming = it.airAt + it.durationMs > now;
    const n = needs.get(it.sha256);
    if (n) {
      if (upcoming && (!n.upcoming || it.airAt < n.firstAirAt)) n.firstAirAt = it.airAt;
      n.upcoming ||= upcoming;
      n.lastAirAt = Math.max(n.lastAirAt, it.airAt);
      n.items++;
    } else {
      needs.set(it.sha256, {
        sha256: it.sha256,
        ext: it.ext,
        key: it.key,
        sizeBytes: it.sizeBytes,
        firstAirAt: it.airAt,
        lastAirAt: it.airAt,
        items: 1,
        upcoming,
      });
    }
  }

  const byHash = new Map(cached.map((c) => [c.sha256, c]));
  let usedBytes = cached.reduce((s, c) => s + c.sizeBytes, 0) + (input.pinnedBytes ?? 0);
  const keep: Plan['keep'] = [];
  const missing: Need[] = [];
  let horizonBytes = 0;
  for (const n of needs.values()) {
    horizonBytes += n.sizeBytes;
    const c = byHash.get(n.sha256);
    if (c) keep.push({ ...c, lastAirAt: n.lastAirAt });
    else if (inFlight.has(n.sha256)) usedBytes += n.sizeBytes;
    else if (n.upcoming) {
      const { upcoming: _u, ...need } = n;
      missing.push(need);
    }
  }
  missing.sort((a, b) => a.firstAirAt - b.firstAirAt || a.sha256.localeCompare(b.sha256));

  // A file hard-linked as a fallback stays: evicting it frees nothing.
  const candidates = cached
    .filter((c) => !needs.has(c.sha256) && !c.linked)
    .sort((a, b) => a.lastNeededAt - b.lastNeededAt || a.sha256.localeCompare(b.sha256));
  const evictList: CachedFile[] = [];
  const fetch: Need[] = [];
  const deferred: Need[] = [];
  let free = budgetBytes - usedBytes;
  let evictable = candidates.reduce((sum, c) => sum + c.sizeBytes, 0);
  for (const m of missing) {
    // Evict only when that makes room: a file that can't fit anyway costs no warm files.
    if (deferred.length === 0 && free + evictable >= m.sizeBytes) {
      while (free < m.sizeBytes) {
        const c = candidates.shift() as CachedFile;
        evictList.push(c);
        free += c.sizeBytes;
        evictable -= c.sizeBytes;
      }
      fetch.push(m);
      free -= m.sizeBytes;
      continue;
    }
    deferred.push(m);
  }

  return {
    fetch,
    deferred,
    evict: evictList,
    keep,
    needed: new Set(needs.keys()),
    usage: { usedBytes, horizonBytes, budgetBytes },
  };
}

/** Bytes of free space the host must keep: 5 % of the filesystem or 2 GB, whichever is larger. */
export function diskReserveBytes(totalBytes: number, minBytes = 2 * 1024 ** 3): number {
  return Math.max(Math.ceil(totalBytes * 0.05), minBytes);
}
