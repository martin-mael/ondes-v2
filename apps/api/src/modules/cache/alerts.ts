import type { CacheFileRow, StationCacheState } from '@ondes/db';
import { type AlertSeverity, alertTypes, type CacheReadiness } from '@ondes/shared';

// Cache alerts (#31, ADR 0004), derived from the cache tables the worker keeps. Pure: the
// alerts a station should have open right now. `evaluateCacheAlerts` (service.ts) raises them
// and resolves the open cache alerts that are no longer in the list.

export type DesiredAlert = {
  type: string;
  severity: AlertSeverity;
  dedupeKey: string;
  title: string;
  message?: string;
  details: Record<string, unknown>;
};

/** Every alert type this module raises; open alerts of these types are reconciled. */
export const CACHE_ALERT_TYPES = [
  alertTypes.cacheItemMissing,
  alertTypes.cacheHorizonDegraded,
  alertTypes.cacheBudgetExceeded,
  alertTypes.cacheSourceMissing,
  alertTypes.cacheChecksumMismatch,
  alertTypes.cacheDiskLow,
  alertTypes.cacheSyncFailing,
] as const;

export type CacheAlertInput = {
  /** Readiness over the next hour: each missing item is a critical alert (T−1h). */
  nextHour: CacheReadiness;
  /** Readiness over the next 6 h: anything missing is a warning on the station. */
  nextSixHours: CacheReadiness;
  state: Pick<
    StationCacheState,
    'deferred' | 'diskLow' | 'horizonBytes' | 'budgetBytes' | 'lastError'
  >;
  /** The station's `failed` cache rows (kept only while the horizon needs them). */
  failed: ReadonlyArray<Pick<CacheFileRow, 'sha256' | 'error' | 'errorMessage'>>;
};

export function cacheAlerts(input: CacheAlertInput): DesiredAlert[] {
  const out: DesiredAlert[] = [];
  for (const m of input.nextHour.missing) {
    out.push({
      type: alertTypes.cacheItemMissing,
      severity: 'critical',
      dedupeKey: `${alertTypes.cacheItemMissing}:${m.logItemId}`,
      title: 'Log item not cached',
      message: `An item airing at ${m.airAt} isn't in the playout cache (${m.reason}); it will be skipped if it doesn't arrive in time.`,
      details: { ...m },
    });
  }
  const six = input.nextSixHours;
  if (six.firstMissingAt !== null) {
    out.push({
      type: alertTypes.cacheHorizonDegraded,
      severity: 'warning',
      dedupeKey: alertTypes.cacheHorizonDegraded,
      title: 'Playout cache incomplete for the next 6 hours',
      details: {
        pctAirTime: Math.round(six.pctAirTime * 10) / 10,
        firstMissingAt: six.firstMissingAt,
        missingItems: six.items - six.readyItems,
      },
    });
  }
  if (input.state.deferred.length > 0) {
    out.push({
      type: alertTypes.cacheBudgetExceeded,
      severity: 'warning',
      dedupeKey: alertTypes.cacheBudgetExceeded,
      title: "The log horizon doesn't fit the station's cache budget",
      details: {
        horizonBytes: input.state.horizonBytes,
        budgetBytes: input.state.budgetBytes,
        deferredFiles: input.state.deferred.length,
      },
    });
  }
  for (const f of input.failed) {
    if (f.error !== 'source_missing' && f.error !== 'checksum_mismatch') continue;
    const type =
      f.error === 'source_missing'
        ? alertTypes.cacheSourceMissing
        : alertTypes.cacheChecksumMismatch;
    out.push({
      type,
      severity: 'critical',
      dedupeKey: `${type}:${f.sha256}`,
      title:
        f.error === 'source_missing'
          ? 'A scheduled file is missing from storage'
          : "A stored file doesn't match its checksum",
      message: f.errorMessage ?? undefined,
      details: { sha256: f.sha256 },
    });
  }
  if (input.state.lastError) {
    out.push({
      type: alertTypes.cacheSyncFailing,
      severity: 'warning',
      dedupeKey: alertTypes.cacheSyncFailing,
      title: 'Playout cache sync is failing',
      message: input.state.lastError.message,
      details: {
        error: input.state.lastError.message,
        at: input.state.lastError.at.toISOString(),
      },
    });
  }
  if (input.state.diskLow) {
    out.push({
      type: alertTypes.cacheDiskLow,
      severity: 'critical',
      dedupeKey: alertTypes.cacheDiskLow,
      title: 'Cache disk almost full: downloads paused',
      details: {},
    });
  }
  return out;
}

/**
 * Why an open cache alert that is no longer wanted closes:
 * - `cache_ok`: its file is now cached (or the station-wide condition cleared);
 * - `no_longer_needed`: the item aired, left the next hour or the log, or the file left the
 *   horizon, without ever being cached.
 */
export function cacheAlertResolution(
  dedupeKey: string,
  ready: { itemIds: ReadonlySet<string>; sha256s: ReadonlySet<string> },
): 'cache_ok' | 'no_longer_needed' {
  const [type, id] = splitKey(dedupeKey);
  if (type === alertTypes.cacheItemMissing) {
    return id && ready.itemIds.has(id) ? 'cache_ok' : 'no_longer_needed';
  }
  if (type === alertTypes.cacheSourceMissing || type === alertTypes.cacheChecksumMismatch) {
    return id && ready.sha256s.has(id) ? 'cache_ok' : 'no_longer_needed';
  }
  return 'cache_ok';
}

function splitKey(key: string): [string, string | undefined] {
  const i = key.indexOf(':');
  return i < 0 ? [key, undefined] : [key.slice(0, i), key.slice(i + 1)];
}
