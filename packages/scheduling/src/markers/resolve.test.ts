import type { LogItemKind, LogItemTiming } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { type MarkerEntry, resolveMarkers } from './resolve.ts';

const T = Date.parse('2026-10-21T10:00:00Z');

function e(
  id: string,
  kind: LogItemKind,
  timing: LogItemTiming = 'flow',
  extra: Partial<MarkerEntry> = {},
): MarkerEntry {
  return {
    id,
    kind,
    timing,
    anchorAtMs: timing === 'flow' ? null : T,
    capMs: null,
    ...extra,
  };
}

describe('resolveMarkers', () => {
  it("hands a marker's timing to the item after it, and leaves the marker a plain point", () => {
    const entries = [
      e('s1', 'song'),
      e('m', 'marker', 'soft', { capMs: 30_000 }),
      e('j', 'jingle'),
    ];
    const out = resolveMarkers(entries);
    expect(out[1]).toMatchObject({ id: 'm', timing: 'flow', anchorAtMs: null, capMs: null });
    expect(out[2]).toMatchObject({
      id: 'j',
      timing: 'soft',
      anchorAtMs: T,
      capMs: 30_000,
      markerId: 'm',
    });
    expect(out[0]).toBe(entries[0]);
    // Pure: the input is untouched.
    expect(entries[2]?.timing).toBe('flow');
  });

  it('keeps the cap for soft markers only', () => {
    const out = resolveMarkers([e('m', 'marker', 'hard', { capMs: 30_000 }), e('j', 'jingle')]);
    expect(out[1]).toMatchObject({ timing: 'hard', capMs: null });
  });

  it('passes over unplayable items and kinds with nothing to push', () => {
    const out = resolveMarkers([
      e('m', 'marker', 'not_before'),
      e('x', 'song', 'flow', { unplayable: 'not_cached' }),
      e('n', 'vt'),
    ]);
    expect(out.map((x) => [x.id, x.timing])).toEqual([
      ['m', 'flow'],
      ['x', 'flow'],
      ['n', 'not_before'],
    ]);
  });

  it('times segments, episodes and every pushed kind', () => {
    for (const kind of ['song', 'vt', 'jingle', 'bed', 'episode', 'fill', 'segment'] as const) {
      expect(resolveMarkers([e('m', 'marker', 'hard'), e('x', kind)])[1]?.timing).toBe('hard');
    }
  });

  it('keeps its own timing when nothing after it can carry it', () => {
    const cases: MarkerEntry[][] = [
      // A show at the marker's time keeps its own policy.
      [e('m', 'marker', 'soft'), e('ep', 'episode', 'hard')],
      // Nothing to push before the next marker or a live slot: the planner holds there.
      [e('m', 'marker', 'hard'), e('m2', 'marker', 'soft'), e('j', 'jingle')],
      [e('m', 'marker', 'hard'), e('live', 'live_slot')],
      // The end of the window.
      [e('s', 'song'), e('m', 'marker', 'hard')],
    ];
    for (const entries of cases) {
      const out = resolveMarkers(entries);
      const marker = out.find((x) => x.id === 'm');
      expect(marker?.timing).not.toBe('flow');
    }
    // The second marker of a pair still times its own item.
    const pair = resolveMarkers([
      e('m', 'marker', 'hard'),
      e('m2', 'marker', 'soft'),
      e('j', 'jingle'),
    ]);
    expect(pair[2]).toMatchObject({ id: 'j', timing: 'soft', markerId: 'm2' });
  });

  it('returns the same array when there is nothing to resolve', () => {
    const entries = [e('s', 'song'), e('m', 'marker'), e('j', 'jingle')];
    expect(resolveMarkers(entries)).toBe(entries);
  });
});
