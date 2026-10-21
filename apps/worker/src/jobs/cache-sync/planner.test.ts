import { describe, expect, it } from 'vitest';
import type { CachedFile } from './layout.ts';
import { diskReserveBytes, HOUR, type HorizonItem, pinnedWindow, plan } from './planner.ts';

const MB = 1024 ** 2;
const hash = (n: number) => n.toString(16).padStart(64, '0');
const now = Date.parse('2026-06-10T12:00:00Z');

function item(
  n: number,
  airAt: number,
  opts: { size?: number; durationMs?: number } = {},
): HorizonItem {
  return {
    sha256: hash(n),
    ext: 'flac',
    key: `org/o/sha256/${hash(n)}.flac`,
    sizeBytes: opts.size ?? 10 * MB,
    airAt,
    durationMs: opts.durationMs ?? 3 * 60_000,
  };
}

function cached(n: number, lastNeededAt: number, size = 10 * MB): CachedFile {
  return { sha256: hash(n), ext: 'flac', sizeBytes: size, lastNeededAt };
}

describe('horizon set', () => {
  it('needs items from 1 h ago to 48 h ahead, once per file', () => {
    const p = plan({
      now,
      items: [
        item(1, now - 2 * HOUR), // ended long ago
        item(2, now - 30 * 60_000), // ended 27 min ago: pinned
        item(3, now + HOUR),
        item(3, now + 30 * HOUR), // same file twice
        item(4, now + 48 * HOUR - 1),
        item(5, now + 48 * HOUR), // past the horizon
      ],
      cached: [],
      budgetBytes: 1024 * MB,
    });
    expect([...p.needed].sort()).toEqual([hash(2), hash(3), hash(4)]);
    // A file that only aired recently is pinned when cached, never fetched.
    expect(p.fetch.map((f) => f.sha256)).toEqual([hash(3), hash(4)]);
    const three = p.fetch[0];
    expect(three?.items).toBe(2);
    expect(three?.firstAirAt).toBe(now + HOUR);
    expect(three?.lastAirAt).toBe(now + 30 * HOUR);
    expect(p.usage.horizonBytes).toBe(30 * MB);
  });

  it('keeps an item on air (started before now, not ended)', () => {
    const p = plan({
      now,
      items: [item(1, now - 10 * 60_000, { durationMs: 3_600_000 })],
      cached: [],
      budgetBytes: 1024 * MB,
    });
    expect(p.fetch.map((f) => f.sha256)).toEqual([hash(1)]);
  });

  it('honours a custom horizon', () => {
    const p = plan({
      now,
      horizonMs: 6 * HOUR,
      items: [item(1, now + 5 * HOUR), item(2, now + 7 * HOUR)],
      cached: [],
      budgetBytes: 1024 * MB,
    });
    expect(p.fetch.map((f) => f.sha256)).toEqual([hash(1)]);
  });

  it('fetches by first air time and skips files in flight elsewhere', () => {
    const p = plan({
      now,
      items: [item(1, now + 3 * HOUR), item(2, now + HOUR), item(3, now + 2 * HOUR)],
      cached: [],
      budgetBytes: 25 * MB,
      inFlight: new Set([hash(2)]),
    });
    // hash(2)'s 10 MB count as used: 15 MB left, one more file fits.
    expect(p.fetch.map((f) => f.sha256)).toEqual([hash(3)]);
    expect(p.deferred.map((f) => f.sha256)).toEqual([hash(1)]);
  });

  it('bumps kept files to their last planned air time', () => {
    const p = plan({
      now,
      items: [item(1, now + HOUR), item(1, now + 20 * HOUR)],
      cached: [cached(1, now - 72 * HOUR)],
      budgetBytes: 1024 * MB,
    });
    expect(p.fetch).toEqual([]);
    expect(p.keep).toEqual([{ ...cached(1, now - 72 * HOUR), lastAirAt: now + 20 * HOUR }]);
  });
});

describe('eviction', () => {
  it('is lazy: nothing goes while the budget has room', () => {
    const p = plan({
      now,
      items: [item(1, now + HOUR)],
      cached: [cached(9, now - 96 * HOUR)],
      budgetBytes: 100 * MB,
    });
    expect(p.evict).toEqual([]);
    expect(p.fetch).toHaveLength(1);
  });

  it('evicts least recently needed first, only outside the window', () => {
    const p = plan({
      now,
      items: [item(1, now + HOUR, { size: 25 * MB }), item(2, now - 20 * 60_000)],
      cached: [
        cached(2, now - 20 * 60_000), // pinned: aired 17 min ago
        cached(7, now - 24 * HOUR),
        cached(8, now - 96 * HOUR),
        cached(9, now - 48 * HOUR),
      ],
      budgetBytes: 50 * MB,
    });
    // 40 MB used, 10 free: 25 MB needs two evictions, oldest first.
    expect(p.evict.map((e) => e.sha256)).toEqual([hash(8), hash(9)]);
    expect(p.fetch.map((f) => f.sha256)).toEqual([hash(1)]);
  });

  it('never evicts what the window needs, and defers in air-time order', () => {
    const p = plan({
      now,
      items: [
        item(1, now + HOUR, { size: 40 * MB }),
        item(2, now + 2 * HOUR, { size: 40 * MB }), // doesn't fit
        item(3, now + 3 * HOUR, { size: 1 * MB }), // would fit, deferred anyway
        item(4, now + 4 * HOUR),
      ],
      cached: [cached(4, now - HOUR * 100), cached(9, now - HOUR * 200)],
      budgetBytes: 60 * MB,
    });
    // hash(1) fits in the free 40 MB; evicting hash(9) wouldn't make room for hash(2).
    expect(p.evict).toEqual([]);
    expect(p.fetch.map((f) => f.sha256)).toEqual([hash(1)]);
    expect(p.deferred.map((f) => f.sha256)).toEqual([hash(2), hash(3)]);
    expect(p.keep.map((k) => k.sha256)).toEqual([hash(4)]);
  });

  it('evicts nothing when that would not make room anyway', () => {
    const p = plan({
      now,
      items: [item(1, now + HOUR, { size: 500 * MB })],
      cached: [cached(9, now - 96 * HOUR)],
      budgetBytes: 100 * MB,
    });
    expect(p.evict).toEqual([]);
    expect(p.deferred).toHaveLength(1);
    expect(p.fetch).toEqual([]);
  });
});

describe('DST-safe horizon (Europe/Paris)', () => {
  const paris = (iso: string) => {
    // Local wall time → UTC through Intl: find the offset in force at that instant.
    const guess = Date.parse(`${iso}Z`);
    for (const offsetH of [1, 2]) {
      const t = guess - offsetH * HOUR;
      const local = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Paris',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .format(t)
        .replace(' ', 'T');
      if (local === iso) return t;
    }
    throw new Error(`no such local time: ${iso}`);
  };

  it('spans 48 real hours across the March change (23 h day)', () => {
    // Sunday 29 March 2026: 02:00 CET → 03:00 CEST.
    const start = paris('2026-03-29T00:00:00');
    const w = pinnedWindow(start);
    expect(w.to - start).toBe(48 * HOUR);
    // 48 h after local midnight is 01:00 on Tuesday, not midnight: the Sunday had 23 hours.
    expect(w.to).toBe(paris('2026-03-31T01:00:00'));
    const p = plan({
      now: start,
      items: [item(1, paris('2026-03-31T00:30:00')), item(2, paris('2026-03-31T01:30:00'))],
      cached: [],
      budgetBytes: 1024 * MB,
    });
    expect(p.fetch.map((f) => f.sha256)).toEqual([hash(1)]);
  });

  it('spans 48 real hours across the October change (25 h day)', () => {
    // Sunday 25 October 2026: 03:00 CEST → 02:00 CET; 02:30 happens twice.
    const start = paris('2026-10-25T00:00:00');
    const w = pinnedWindow(start);
    expect(w.to).toBe(paris('2026-10-26T23:00:00'));
    const firstHalfPast2 = Date.parse('2026-10-25T00:30:00Z'); // 02:30 CEST
    const secondHalfPast2 = Date.parse('2026-10-25T01:30:00Z'); // 02:30 CET
    const p = plan({
      now: start,
      items: [
        item(1, firstHalfPast2),
        item(2, secondHalfPast2),
        item(3, paris('2026-10-26T22:59:00')),
        item(4, paris('2026-10-26T23:30:00')),
      ],
      cached: [],
      budgetBytes: 1024 * MB,
    });
    expect(p.fetch.map((f) => f.sha256)).toEqual([hash(1), hash(2), hash(3)]);
  });

  it('pins the hour before now across a change', () => {
    // 03:10 CEST on 29 March: one real hour back is 01:10 CET.
    const at = paris('2026-03-29T03:10:00');
    expect(pinnedWindow(at).from).toBe(paris('2026-03-29T01:10:00'));
  });
});

describe('diskReserveBytes', () => {
  it('keeps 5 % or 2 GB, whichever is larger', () => {
    expect(diskReserveBytes(10 * 1024 ** 3)).toBe(2 * 1024 ** 3);
    expect(diskReserveBytes(1000 * 1024 ** 3)).toBe(50 * 1024 ** 3);
  });
});
