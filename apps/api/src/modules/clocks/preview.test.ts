import type { Db, StationScope } from '@ondes/db';
import { describe, expect, it } from 'vitest';
import type { LibraryCandidate } from '../rotation/repo.ts';
import { type PickSlotsFn, randomPicker, rulesPicker, seededRandom } from './preview.ts';

const song = (id: string, type: LibraryCandidate['type'] = 'song'): LibraryCandidate => ({
  id,
  type,
  title: id,
  artists: [`${id} artist`],
  year: null,
  explicit: false,
  durationMs: 180_000,
  startAt: null,
  killAt: null,
  addedAt: new Date(0),
  tags: [{ key: 'style', value: 'house' }],
});
const members = ['a', 'b', 'c'].map((id) => song(id));
const at = new Date('2026-10-25T10:00:00Z');
const later = (min: number) => new Date(at.getTime() + min * 60_000);

describe('seededRandom', () => {
  it('repeats for a seed and differs across seeds', () => {
    const a = seededRandom('x');
    const b = seededRandom('x');
    const seq = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(seq);
    expect(seq.every((n) => n >= 0 && n < 1)).toBe(true);
    expect(seededRandom('y')()).not.toBe(seq[0]);
  });
});

describe('randomPicker', () => {
  const requests = (n: number) =>
    Array.from({ length: n }, (_, slotIndex) => ({
      categoryId: 'c',
      slotIndex,
      at: later(slotIndex),
    }));

  it('avoids repeats (fixed items included) while fresh members are left, then relaxes', async () => {
    const picker = randomPicker(async () => members, seededRandom('s'));
    const picks = await picker.pickAll(requests(3), [
      { asset: members[0] as LibraryCandidate, at },
    ]);
    expect(new Set(picks.slice(0, 2).map((p) => p?.asset.id))).toEqual(new Set(['b', 'c']));
    expect(picks[0]?.relaxedRules).toEqual([]);
    expect(picks[2]?.relaxedRules).toEqual(['no_repeat_in_hour']);
  });

  it('resolves members at each slot time', async () => {
    const seen: Date[] = [];
    const picker = randomPicker(async (_, when) => {
      seen.push(when);
      return when >= later(1) ? [] : members;
    }, Math.random);
    const picks = await picker.pickAll(requests(2), []);
    expect(seen).toEqual([at, later(1)]);
    expect(picks[1]).toBeNull();
  });
});

describe('rulesPicker', () => {
  const db = {} as Db;
  const scope = { orgId: 'o', stationId: 's' } as StationScope;

  it('picks the whole hour in one call, with the fixed items as history', async () => {
    const calls: Parameters<PickSlotsFn>[] = [];
    const pickSlots: PickSlotsFn = async (...args) => {
      calls.push(args);
      return {
        picks: [
          {
            asset: { id: 'b', title: 'B', artists: ['X'], durationMs: 200_000 },
            relaxed: [{ rule: 'artist_separation', reason: 'only one artist' }],
          },
          { asset: null, relaxed: [] },
        ],
      };
    };
    const picker = rulesPicker(pickSlots, db, scope, {
      seed: 'abc',
      assetTypeOf: (id) => (id === 'ids' ? 'jingle' : 'song'),
    });
    expect(picker.source).toBe('rules');
    const picks = await picker.pickAll(
      [
        { categoryId: 'gold', slotIndex: 1, at: later(1) },
        { categoryId: 'ids', slotIndex: 3, at: later(5) },
      ],
      [{ asset: song('fixed', 'other'), at }],
    );
    expect(picks).toEqual([
      {
        asset: { id: 'b', type: 'song', title: 'B', artists: ['X'], durationMs: 200_000 },
        relaxedRules: ['artist_separation'],
      },
      null,
    ]);
    expect(calls).toHaveLength(1);
    const [, , input, options] = calls[0] as Parameters<PickSlotsFn>;
    expect(input).toEqual({
      slots: [
        { categoryId: 'gold', at: later(1).toISOString() },
        { categoryId: 'ids', at: later(5).toISOString() },
      ],
      seed: 'abc',
    });
    expect(options?.history).toEqual([
      {
        assetId: 'fixed',
        type: 'other',
        title: 'fixed',
        artists: ['fixed artist'],
        album: null,
        tags: [{ key: 'style', value: 'house' }],
        at,
      },
    ]);
  });

  it('skips the call when nothing is to be picked', async () => {
    const picker = rulesPicker(
      async () => {
        throw new Error('called');
      },
      db,
      scope,
      { seed: 's', assetTypeOf: () => 'song' },
    );
    expect(await picker.pickAll([], [])).toEqual([]);
  });
});
