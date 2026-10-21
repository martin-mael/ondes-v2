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
] as const;

export type CacheAlertInput = {
  /** Readiness over the next hour: each missing item is a critical alert (T−1h). */
  nextHour: CacheReadiness;
  /** Readiness over the next 6 h: anything missing is a warning on the station. */
  nextSixHours: CacheReadiness;
  state: Pick<StationCacheState, 'deferred' | 'diskLow' | 'horizonBytes' | 'budgetBytes'>;
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
