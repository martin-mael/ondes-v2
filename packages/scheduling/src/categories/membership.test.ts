import { type CategoryRule, categoryRuleSchema } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import {
  type CategoryCandidate,
  matchesRule,
  projectTurnoverDays,
  resolveCategory,
} from './membership.ts';

let n = 0;
function song(overrides: Partial<CategoryCandidate> = {}): CategoryCandidate {
  n++;
  return {
    id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    type: 'song',
    year: null,
    explicit: false,
    durationMs: 200_000,
    startAt: null,
    killAt: null,
    tags: [],
    ...overrides,
  };
}

const all = (...children: CategoryRule['children']): CategoryRule => ({
  kind: 'group',
  match: 'all',
  children,
});
const any = (...children: CategoryRule['children']): CategoryRule => ({
  kind: 'group',
  match: 'any',
  children,
});

const house = song({
  year: 1994,
  tags: [
    { key: 'style', value: 'House' },
    { key: 'energy', value: '4' },
    { key: 'mood', value: 'happy' },
  ],
});
const techno = song({
  year: 2012,
  explicit: true,
  tags: [
    { key: 'style', value: 'techno' },
    { key: 'energy', value: '5' },
  ],
});
const ambient = song({
  year: 2020,
  tags: [
    { key: 'style', value: 'ambient' },
    { key: 'energy', value: 'low' },
  ],
});
const untagged = song();

describe('matchesRule', () => {
  it('matches tags case-insensitively, with any/all/none', () => {
    const anyOf = all({ kind: 'tag', key: 'style', op: 'any', values: ['house', 'TECHNO'] });
    expect([house, techno, ambient, untagged].map((a) => matchesRule(anyOf, a))).toEqual([
      true,
      true,
      false,
      false,
    ]);

    const allOf = all({ kind: 'tag', key: 'mood', op: 'all', values: ['happy', 'sad'] });
    expect(matchesRule(allOf, house)).toBe(false);
    const both = song({
      tags: [
        { key: 'mood', value: 'happy' },
        { key: 'mood', value: 'Sad' },
      ],
    });
    expect(matchesRule(allOf, both)).toBe(true);

    const none = all({ kind: 'tag', key: 'style', op: 'none', values: ['techno'] });
    expect([house, techno, untagged].map((a) => matchesRule(none, a))).toEqual([true, false, true]);
  });

  it('compares numeric tag values and skips non-numeric ones', () => {
    const energetic = all({ kind: 'tag_number', key: 'energy', op: 'gte', value: 4 });
    expect([house, techno, ambient, untagged].map((a) => matchesRule(energetic, a))).toEqual([
      true,
      true,
      false,
      false,
    ]);
    const exactly = all({ kind: 'tag_number', key: 'energy', op: 'eq', value: 5 });
    expect(matchesRule(exactly, techno)).toBe(true);
    expect(matchesRule(exactly, house)).toBe(false);
    const empty = song({ tags: [{ key: 'energy', value: ' ' }] });
    expect(matchesRule(all({ kind: 'tag_number', key: 'energy', op: 'eq', value: 0 }), empty)).toBe(
      false,
    );
  });

  it('filters on year and explicit; a missing year never matches', () => {
    const nineties = all(
      { kind: 'year', op: 'gte', value: 1990 },
      { kind: 'year', op: 'lt', value: 2000 },
    );
    expect([house, techno, untagged].map((a) => matchesRule(nineties, a))).toEqual([
      true,
      false,
      false,
    ]);
    expect(matchesRule(all({ kind: 'explicit', value: false }), techno)).toBe(false);
    expect(matchesRule(all({ kind: 'explicit', value: true }), techno)).toBe(true);
  });

  it('combines nested groups (style=house AND energy>=3) OR (style=ambient)', () => {
    const rule = any(
      all(
        { kind: 'tag', key: 'style', op: 'any', values: ['house'] },
        { kind: 'tag_number', key: 'energy', op: 'gte', value: 3 },
      ),
      { kind: 'tag', key: 'style', op: 'any', values: ['ambient'] },
    );
    expect([house, techno, ambient, untagged].map((a) => matchesRule(rule, a))).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });
});

describe('categoryRuleSchema', () => {
  it('accepts three levels of groups and refuses four', () => {
    const leaf = { kind: 'explicit', value: false } as const;
    expect(categoryRuleSchema.safeParse(all(all(all(leaf)))).success).toBe(true);
    expect(categoryRuleSchema.safeParse(all(all(all(all(leaf))))).success).toBe(false);
  });

  it('refuses an empty group', () => {
    expect(
      categoryRuleSchema.safeParse({ kind: 'group', match: 'all', children: [] }).success,
    ).toBe(false);
  });
});

describe('resolveCategory', () => {
  const jingle = song({ type: 'jingle', tags: [{ key: 'style', value: 'house' }] });
  const future = song({
    startAt: new Date('2030-01-01T00:00:00Z'),
    tags: [{ key: 'style', value: 'house' }],
  });
  const killed = song({
    killAt: new Date('2020-01-01T00:00:00Z'),
    tags: [{ key: 'style', value: 'house' }],
  });
  const candidates = [house, techno, ambient, untagged, jingle, future, killed];
  const at = new Date('2026-10-21T12:00:00Z');
  const houseRule = all({ kind: 'tag', key: 'style', op: 'any', values: ['house'] });

  it('takes rule matches of the category type only', () => {
    const result = resolveCategory(
      { assetType: 'song', rule: houseRule, members: [] },
      candidates,
      {
        at,
      },
    );
    expect(result.members.map((m) => m.asset.id)).toEqual([house.id, future.id, killed.id]);
    expect(result.members.every((m) => m.source === 'rule')).toBe(true);
    expect(result.counts).toEqual({
      members: 3,
      schedulable: 1,
      ruleMatches: 3,
      manualOnly: 0,
      excluded: 0,
      totalDurationMs: 600_000,
    });
  });

  it('adds manual includes, removes excludes, and reports both', () => {
    const result = resolveCategory(
      {
        assetType: 'song',
        rule: houseRule,
        members: [
          { assetId: house.id, mode: 'include' },
          { assetId: ambient.id, mode: 'include' },
          { assetId: killed.id, mode: 'exclude' },
          { assetId: techno.id, mode: 'exclude' },
          { assetId: jingle.id, mode: 'include' },
          { assetId: '00000000-0000-7000-8000-ffffffffffff', mode: 'include' },
        ],
      },
      candidates,
      { at },
    );
    expect(result.members.map((m) => [m.asset.id, m.source])).toEqual([
      [house.id, 'both'],
      [ambient.id, 'manual'],
      [future.id, 'rule'],
    ]);
    expect(result.manual.map((i) => [i.asset.id, i.mode, i.effect])).toEqual([
      [house.id, 'include', 'redundant'],
      [techno.id, 'exclude', 'redundant'],
      [ambient.id, 'include', 'added'],
      [jingle.id, 'include', 'wrong_type'],
      [killed.id, 'exclude', 'excluded'],
    ]);
    expect(result.counts).toMatchObject({
      members: 3,
      schedulable: 2,
      ruleMatches: 3,
      manualOnly: 1,
      excluded: 1,
    });
  });

  it('without a rule, holds the manual includes only', () => {
    const result = resolveCategory(
      { assetType: 'jingle', rule: null, members: [{ assetId: jingle.id, mode: 'include' }] },
      candidates,
      { at },
    );
    expect(result.members.map((m) => [m.asset.id, m.source])).toEqual([[jingle.id, 'manual']]);
    expect(result.counts.ruleMatches).toBe(0);
  });

  it('follows tag edits: membership is computed, never stored', () => {
    const asset = song();
    const category = { assetType: 'song' as const, rule: houseRule, members: [] };
    expect(resolveCategory(category, [asset], { at }).counts.members).toBe(0);
    const tagged = { ...asset, tags: [{ key: 'style' as const, value: 'house' }] };
    expect(resolveCategory(category, [tagged], { at }).counts.members).toBe(1);
  });
});

describe('projectTurnoverDays', () => {
  it('divides songs by plays per day', () => {
    expect(projectTurnoverDays(120, 40)).toBe(3);
    expect(projectTurnoverDays(0, 40)).toBeNull();
    expect(projectTurnoverDays(120, undefined)).toBeNull();
    expect(projectTurnoverDays(120, 0)).toBeNull();
  });
});
