import { DEFAULT_ROTATION_RULES, type RotationRule } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { CATEGORY_IDS, fixtureLibrary } from '../generator/fixture.ts';
import type { PlayedItem } from './history.ts';
import { pickForSlot, playedFrom } from './pick.ts';
import { randomFor } from './random.ts';

// `explain: false` (the log generator's fast path) must pick exactly what the full ranking
// picks, with the same relaxed rules, on any snapshot.

const rules: RotationRule[][] = [
  DEFAULT_ROTATION_RULES,
  [],
  DEFAULT_ROTATION_RULES.map((r) => ({ ...r, breakable: r.kind !== 'artist_separation' })),
  [
    ...DEFAULT_ROTATION_RULES,
    {
      id: 'flow',
      enabled: true,
      priority: 9,
      breakable: true,
      kind: 'flow',
      maxBpmStep: 10,
      maxEnergyStep: null,
    } as RotationRule,
  ],
];

describe('the picker without explanation', () => {
  it('picks what the full ranking picks', () => {
    for (let run = 0; run < 24; run++) {
      const seed = `quick-${run}`;
      const { categories } = fixtureLibrary(30 + Math.floor(randomFor(seed, 'n') * 300), seed);
      const ruleSet = rules[run % rules.length] as RotationRule[];
      const history: PlayedItem[] = [];
      let at = new Date('2026-06-10T00:00:00Z').getTime();
      for (let slot = 0; slot < 60; slot++) {
        const ids = [CATEGORY_IDS.current, CATEGORY_IDS.recurrent, CATEGORY_IDS.gold];
        const category = categories.get(ids[slot % 3] as string);
        if (!category) throw new Error('fixture category');
        const members = category.members.map((m) => ({
          ...m,
          bpm: 90 + Math.floor(randomFor(seed, m.id) * 60),
        }));
        const input = { at: new Date(at), category, candidates: members };
        const snapshot = { timeZone: 'Europe/Paris', rules: ruleSet, history, seed };
        const full = pickForSlot(snapshot, input);
        const quick = pickForSlot({ ...snapshot, explain: false }, input);
        expect(quick.asset?.id).toBe(full.asset?.id);
        expect(quick.relaxed).toEqual(full.relaxed);
        expect(quick.unfilled).toEqual(full.unfilled);
        if (full.asset) history.push(playedFrom(full.asset, new Date(at)));
        at += 200_000;
      }
    }
  });
});
