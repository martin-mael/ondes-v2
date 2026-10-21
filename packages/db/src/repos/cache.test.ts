import { describe, expect, it } from 'vitest';
import { type CacheHorizonItem, computeCacheReadiness } from './cache.ts';

const h = (n: number) => n.toString(16).padStart(64, '0');
const at = (min: number) => new Date(Date.parse('2026-06-10T12:00:00Z') + min * 60_000);
let ids = 0;
function item(min: number, durationMin: number, sha: string | null): CacheHorizonItem {
  ids++;
  return {
    logItemId: `0199f6a0-0000-7000-8000-${String(ids).padStart(12, '0')}`,
    airAt: at(min),
    durationMs: durationMin * 60_000,
    assetFileId: sha ? `0199f6a0-0000-7000-9000-${String(ids).padStart(12, '0')}` : null,
    sha256: sha,
    ext: sha ? 'flac' : null,
    sizeBytes: sha ? 1 : null,
    storageKey: sha ? `org/x/sha256/${sha}.flac` : null,
  };
}

describe('computeCacheReadiness', () => {
  const items = [
    item(-10, 5, h(1)), // ended before the window
    item(-2, 4, h(1)), // on air: in the window
    item(2, 30, h(2)),
    item(32, 10, h(3)),
    item(42, 10, null),
    item(52, 6, h(4)),
    item(58, 2, h(5)),
    item(60, 5, h(6)), // starts at the window's end: out
  ];
  const files = new Map([
    [h(1), { state: 'ready' as const, error: null }],
    [h(3), { state: 'failed' as const, error: 'source_missing' as const }],
    [h(5), { state: 'ready' as const, error: null }],
  ]);

  it('weighs air time, and says why each missing item is missing', () => {
    const r = computeCacheReadiness(items, files, new Set([h(4)]), { from: at(0), to: at(60) });
    expect(r.items).toBe(6);
    expect(r.readyItems).toBe(2);
    expect(r.pctItems).toBeCloseTo(100 / 3);
    // ready: 4 + 2 = 6 min of 62.
    expect(r.pctAirTime).toBeCloseTo((100 * 6) / 62);
    expect(r.firstMissingAt).toBe(at(2).toISOString());
    expect(r.missing.map((m) => m.reason)).toEqual([
      'pending',
      'source_missing',
      'no_file',
      'deferred',
    ]);
  });

  it('is 100 % for an empty window', () => {
    const r = computeCacheReadiness([], files, new Set(), { from: at(0), to: at(60) });
    expect(r).toMatchObject({ items: 0, pctItems: 100, pctAirTime: 100, firstMissingAt: null });
  });
});
