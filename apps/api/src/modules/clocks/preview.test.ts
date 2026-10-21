import { describe, expect, it } from 'vitest';
import type { LibraryCandidate } from '../rotation/repo.ts';
import { type PreviewPlacement, randomPicker, seededRandom } from './preview.ts';

const song = (id: string): LibraryCandidate => ({
  id,
  type: 'song',
  title: id,
  artists: [],
  year: null,
  explicit: false,
  durationMs: 180_000,
  startAt: null,
  killAt: null,
  addedAt: new Date(0),
  tags: [],
});
const members = ['a', 'b', 'c'].map(song);
const at = new Date('2026-10-25T10:00:00Z');

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
  it('avoids repeats while fresh members are left, then relaxes', async () => {
    const picker = randomPicker(async () => members, seededRandom('s'));
    const history: PreviewPlacement[] = [];
    for (let slotIndex = 0; slotIndex < 3; slotIndex++) {
      const pick = await picker.pick({ categoryId: 'c', slotIndex, at, history });
      expect(pick?.relaxedRules).toEqual([]);
      history.push({
        asset: pick?.asset as LibraryCandidate,
        categoryId: 'c',
        slotIndex,
        startsAt: at,
      });
    }
    expect(new Set(history.map((h) => h.asset.id))).toEqual(new Set(['a', 'b', 'c']));
    const fourth = await picker.pick({ categoryId: 'c', slotIndex: 3, at, history });
    expect(fourth?.relaxedRules).toEqual(['no_repeat_in_hour']);
  });

  it('returns null for an empty category', async () => {
    const picker = randomPicker(async () => [], Math.random);
    expect(await picker.pick({ categoryId: 'c', slotIndex: 0, at, history: [] })).toBeNull();
  });
});
