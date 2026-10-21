import type { CacheReadiness } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { cacheAlerts } from './alerts.ts';

const sha = 'a'.repeat(64);
const ready: CacheReadiness = {
  from: '2026-06-10T12:00:00.000Z',
  to: '2026-06-10T13:00:00.000Z',
  items: 3,
  readyItems: 3,
  pctItems: 100,
  pctAirTime: 100,
  firstMissingAt: null,
  missing: [],
};
const missing: CacheReadiness['missing'][number] = {
  logItemId: '0199f6a0-0000-7000-8000-000000000001',
  airAt: '2026-06-10T12:30:00.000Z',
  durationMs: 180_000,
  assetFileId: '0199f6a0-0000-7000-8000-000000000002',
  sha256: sha,
  reason: 'pending',
};
const state = { deferred: [], diskLow: false, horizonBytes: 10, budgetBytes: 100 };

describe('cacheAlerts', () => {
  it('raises nothing when everything is cached', () => {
    expect(cacheAlerts({ nextHour: ready, nextSixHours: ready, state, failed: [] })).toEqual([]);
  });

  it('raises one critical alert per item missing within the hour (T−1h)', () => {
    const hour = { ...ready, readyItems: 2, missing: [missing], firstMissingAt: missing.airAt };
    const six = { ...hour, pctAirTime: 95 };
    const alerts = cacheAlerts({ nextHour: hour, nextSixHours: six, state, failed: [] });
    expect(alerts.map((a) => [a.type, a.severity, a.dedupeKey])).toEqual([
      ['cache.item_missing', 'critical', `cache.item_missing:${missing.logItemId}`],
      ['cache.horizon_degraded', 'warning', 'cache.horizon_degraded'],
    ]);
    expect(alerts[1]?.details).toMatchObject({ pctAirTime: 95, firstMissingAt: missing.airAt });
  });

  it('reports the budget, broken sources and a full disk', () => {
    const alerts = cacheAlerts({
      nextHour: ready,
      nextSixHours: ready,
      state: { ...state, deferred: [sha], diskLow: true },
      failed: [
        { sha256: sha, error: 'source_missing', errorMessage: 'Object not found' },
        { sha256: 'b'.repeat(64), error: 'checksum_mismatch', errorMessage: null },
        { sha256: 'c'.repeat(64), error: 'io', errorMessage: 'ECONNRESET' },
      ],
    });
    expect(alerts.map((a) => a.dedupeKey)).toEqual([
      'cache.budget_exceeded',
      `cache.source_missing:${sha}`,
      `cache.checksum_mismatch:${'b'.repeat(64)}`,
      'cache.disk_low',
    ]);
  });
});
