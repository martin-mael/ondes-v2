import type { CacheReadiness } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { cacheAlertResolution, cacheAlerts } from './alerts.ts';

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
const state = {
  deferred: [],
  diskLow: false,
  horizonBytes: 10,
  budgetBytes: 100,
  lastError: null,
};

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

describe('cache.sync_failing', () => {
  it('is raised while the last pass failed', () => {
    const alerts = cacheAlerts({
      nextHour: ready,
      nextSixHours: ready,
      state: { ...state, lastError: { at: new Date('2026-06-10T12:00:00Z'), message: 'EACCES' } },
      failed: [],
    });
    expect(alerts).toMatchObject([
      {
        type: 'cache.sync_failing',
        severity: 'warning',
        dedupeKey: 'cache.sync_failing',
        details: { error: 'EACCES', at: '2026-06-10T12:00:00.000Z' },
      },
    ]);
  });
});

describe('cacheAlertResolution', () => {
  const item = '0199f6a0-0000-7000-8000-000000000001';
  const ready = { itemIds: new Set([item]), sha256s: new Set([sha]) };
  const none = { itemIds: new Set<string>(), sha256s: new Set<string>() };

  it('says cache_ok when the file arrived', () => {
    expect(cacheAlertResolution(`cache.item_missing:${item}`, ready)).toBe('cache_ok');
    expect(cacheAlertResolution(`cache.source_missing:${sha}`, ready)).toBe('cache_ok');
    expect(cacheAlertResolution('cache.disk_low', none)).toBe('cache_ok');
  });

  it('says no_longer_needed when the item aired or left the log uncached', () => {
    expect(cacheAlertResolution(`cache.item_missing:${item}`, none)).toBe('no_longer_needed');
    expect(cacheAlertResolution(`cache.checksum_mismatch:${sha}`, none)).toBe('no_longer_needed');
  });
});
