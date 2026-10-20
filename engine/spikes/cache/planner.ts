// Cache sync planner (spike #15). Pure: log horizon + what's on disk + budget → what to
// fetch (by air time), what to evict (LRU outside the horizon) and what doesn't fit.
import type { CachedFile, CacheObject } from './layout.ts';

export const HOUR = 3_600_000;

export type HorizonItem = CacheObject & {
  itemId: string;
  sizeBytes: number;
  /** Planned start, epoch ms (UTC). */
  airAt: number;
  durationMs: number;
};

export type Need = CacheObject & { sizeBytes: number; firstAirAt: number; items: number };

export type Plan = {
  /** Missing files that fit the budget, earliest air time first. Fetch in this order. */
  fetch: Need[];
  /** Missing files that don't fit even after evicting everything outside the horizon. */
  deferred: Need[];
  /** Files to delete before fetching, least recently needed first. */
  evict: CachedFile[];
  /** Cached files that are in the horizon: mtime is bumped to their last air time. */
  keep: Array<CachedFile & { lastAirAt: number }>;
  usage: { usedBytes: number; horizonBytes: number; budgetBytes: number };
};

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
  /** Files being downloaded right now: never planned twice, counted as used. */
  inFlight?: ReadonlySet<string>;
};

/**
 * Strict air-time priority: once a file doesn't fit, every later file is deferred too, so
 * a small late item never takes the space an earlier large one (a show) needs. Eviction is
 * lazy: files outside the horizon stay as a warm cache until their space is needed, since
 * rotation brings most tracks back within days.
 */
export function plan(input: PlanInput): Plan {
  const { now, items, cached, budgetBytes } = input;
  const horizonEnd = now + (input.horizonMs ?? 48 * HOUR);
  const pinFrom = now - (input.pinPastMs ?? HOUR);
  const inFlight = input.inFlight ?? new Set<string>();

  // firstAirAt counts upcoming items only; a file that only aired recently is pinned if
  // cached but never fetched.
  const needs = new Map<string, Need & { lastAirAt: number; upcoming: boolean }>();
  for (const it of items) {
    if (it.airAt + it.durationMs <= pinFrom || it.airAt >= horizonEnd) continue;
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
        sizeBytes: it.sizeBytes,
        firstAirAt: it.airAt,
        lastAirAt: it.airAt,
        items: 1,
        upcoming,
      });
    }
  }

  const byHash = new Map(cached.map((c) => [c.sha256, c]));
  let usedBytes = cached.reduce((s, c) => s + c.sizeBytes, 0);
  const keep: Plan['keep'] = [];
  const missing: Need[] = [];
  let horizonBytes = 0;
  for (const n of needs.values()) {
    horizonBytes += n.sizeBytes;
    const c = byHash.get(n.sha256);
    if (c) keep.push({ ...c, lastAirAt: n.lastAirAt });
    else if (inFlight.has(n.sha256)) usedBytes += n.sizeBytes;
    else if (n.upcoming) {
      const { lastAirAt: _l, upcoming: _u, ...need } = n;
      missing.push(need);
    }
  }
  missing.sort((a, b) => a.firstAirAt - b.firstAirAt);

  const candidates = cached
    .filter((c) => !needs.has(c.sha256))
    .sort((a, b) => a.lastNeededAt - b.lastNeededAt);
  const evictList: CachedFile[] = [];
  const fetch: Need[] = [];
  const deferred: Need[] = [];
  let free = budgetBytes - usedBytes;
  for (const m of missing) {
    if (deferred.length === 0) {
      while (free < m.sizeBytes && candidates.length > 0) {
        const c = candidates.shift() as CachedFile;
        evictList.push(c);
        free += c.sizeBytes;
      }
      if (free >= m.sizeBytes) {
        fetch.push(m);
        free -= m.sizeBytes;
        continue;
      }
    }
    deferred.push(m);
  }

  return {
    fetch,
    deferred,
    evict: evictList,
    keep,
    usage: { usedBytes, horizonBytes, budgetBytes },
  };
}

export type Readiness = {
  items: number;
  readyItems: number;
  /** Share of horizon items whose file is on disk, 0–100. */
  pctItems: number;
  /** Share of planned air time that is on disk, 0–100 (the number to show in the UI). */
  pctAirTime: number;
  /** Earliest air time of an item that isn't cached, or null. */
  firstMissingAt: number | null;
  missing: HorizonItem[];
};

export function readiness(
  items: readonly HorizonItem[],
  isCached: (sha256: string) => boolean,
  now: number,
  windowMs = 48 * HOUR,
): Readiness {
  const inWindow = items.filter((i) => i.airAt + i.durationMs > now && i.airAt < now + windowMs);
  const missing = inWindow.filter((i) => !isCached(i.sha256));
  const total = inWindow.reduce((s, i) => s + i.durationMs, 0);
  const missingMs = missing.reduce((s, i) => s + i.durationMs, 0);
  return {
    items: inWindow.length,
    readyItems: inWindow.length - missing.length,
    pctItems: inWindow.length ? (100 * (inWindow.length - missing.length)) / inWindow.length : 100,
    pctAirTime: total ? (100 * (total - missingMs)) / total : 100,
    firstMissingAt: missing.length ? Math.min(...missing.map((i) => i.airAt)) : null,
    missing,
  };
}

export type CacheAlert =
  | {
      type: 'cache.item_missing';
      severity: 'critical';
      itemId: string;
      airAt: number;
      sha256: string;
    }
  | {
      type: 'cache.horizon_degraded';
      severity: 'warning';
      pctAirTime: number;
      firstMissingAt: number;
    }
  | {
      type: 'cache.budget_exceeded';
      severity: 'warning';
      horizonBytes: number;
      budgetBytes: number;
    }
  | { type: 'cache.source_missing'; severity: 'critical'; sha256: string; firstAirAt: number };

/**
 * Alert rules: any item airing within the next hour that isn't cached is critical (one alert
 * per item); anything missing in the next 6 h is a warning on the station; a horizon that
 * doesn't fit the budget is a warning raised by the planner.
 */
export function cacheAlerts(
  items: readonly HorizonItem[],
  isCached: (sha256: string) => boolean,
  now: number,
  p?: Pick<Plan, 'deferred' | 'usage'>,
): CacheAlert[] {
  const alerts: CacheAlert[] = [];
  for (const i of readiness(items, isCached, now, HOUR).missing) {
    alerts.push({
      type: 'cache.item_missing',
      severity: 'critical',
      itemId: i.itemId,
      airAt: i.airAt,
      sha256: i.sha256,
    });
  }
  const six = readiness(items, isCached, now, 6 * HOUR);
  if (six.firstMissingAt !== null) {
    alerts.push({
      type: 'cache.horizon_degraded',
      severity: 'warning',
      pctAirTime: six.pctAirTime,
      firstMissingAt: six.firstMissingAt,
    });
  }
  if (p && p.deferred.length > 0) {
    alerts.push({
      type: 'cache.budget_exceeded',
      severity: 'warning',
      horizonBytes: p.usage.horizonBytes,
      budgetBytes: p.usage.budgetBytes,
    });
  }
  return alerts;
}
