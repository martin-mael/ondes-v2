import type { RotationRule } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { normalizeTitle, type PlayedItem } from './history.ts';
import {
  type PickCandidate,
  type PickCategory,
  type PickSnapshot,
  pickForSlot,
  pickSequence,
  playedFrom,
  relaxationOrder,
} from './pick.ts';
import { randomFor } from './random.ts';

const TZ = 'Europe/Paris';
let n = 0;
function song(overrides: Partial<PickCandidate> = {}): PickCandidate {
  n++;
  return {
    id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    type: 'song',
    year: null,
    explicit: false,
    durationMs: 200_000,
    startAt: null,
    killAt: null,
    addedAt: new Date('2026-01-01T00:00:00Z'),
    tags: [],
    title: `Song ${n}`,
    artists: [`Artist ${n}`],
    album: null,
    ...overrides,
  };
}

const category = (overrides: Partial<PickCategory> = {}): PickCategory => ({
  id: '00000000-0000-7000-8000-00000000c001',
  assetType: 'song',
  rotationOrder: 'least_recently_played',
  searchDepthPercent: 100,
  restMinutes: 0,
  maxPlaysPerDay: null,
  maxPlaysPerWeek: null,
  ...overrides,
});

const base = (id: string, priority: number) => ({ id, enabled: true, priority, breakable: true });
const artistRule = (value: number, extra: Partial<RotationRule> = {}): RotationRule =>
  ({
    ...base('artist', 5),
    kind: 'artist_separation',
    unit: 'minutes',
    value,
    includeFeatured: true,
    ...extra,
  }) as RotationRule;

const played = (asset: PickCandidate, at: string): PlayedItem => playedFrom(asset, new Date(at));

function snapshot(rules: RotationRule[], history: PlayedItem[] = [], seed?: string): PickSnapshot {
  return { timeZone: TZ, rules, history, ...(seed ? { seed } : {}) };
}

const at = new Date('2026-06-10T12:00:00Z');

describe('rotation order', () => {
  it('least recently played first, never played before anything', () => {
    const [a, b, c] = [song(), song(), song()] as [PickCandidate, PickCandidate, PickCandidate];
    const history = [played(a, '2026-06-10T09:00:00Z'), played(b, '2026-06-10T08:00:00Z')];
    const result = pickForSlot(snapshot([], history), {
      at,
      category: category(),
      candidates: [a, b, c],
    });
    expect(result.ranked.map((r) => r.asset.id)).toEqual([c.id, b.id, a.id]);
    expect(result.asset?.id).toBe(c.id);
  });

  it('sequential: round-robin after the member that played last', () => {
    const songs = [song(), song(), song(), song()];
    const history = [played(songs[1] as PickCandidate, '2026-06-10T11:00:00Z')];
    const result = pickForSlot(snapshot([], history), {
      at,
      category: category({ rotationOrder: 'sequential' }),
      candidates: songs,
    });
    expect(result.asset?.id).toBe(songs[2]?.id);
  });

  it('skips members outside their start/kill window', () => {
    const killed = song({ killAt: new Date('2026-06-01T00:00:00Z') });
    const ok = song();
    const result = pickForSlot(snapshot([]), {
      at,
      category: category(),
      candidates: [killed, ok],
    });
    expect(result.ranked).toHaveLength(1);
    expect(result.asset?.id).toBe(ok.id);
  });
});

describe('separation', () => {
  it('artist in minutes, either side of the slot, featured artists included', () => {
    const daft = song({ artists: ['Daft Punk'] });
    const feat = song({ artists: ['Romanthony', ' daft  PUNK'] });
    const other = song({ artists: ['Air'] });
    const history = [played(daft, '2026-06-10T11:30:00Z')];
    const result = pickForSlot(snapshot([artistRule(60)], history), {
      at,
      category: category(),
      candidates: [feat, daft, other],
    });
    expect(result.asset?.id).toBe(other.id);
    const featVerdict = result.ranked.find((r) => r.asset.id === feat.id);
    expect(featVerdict?.violations).toEqual([
      expect.objectContaining({ kind: 'artist_separation', values: { minutes: 30, limit: 60 } }),
    ]);
    // A planned item after the slot clashes too.
    const later = pickForSlot(snapshot([artistRule(60)], [played(other, '2026-06-10T12:20:00Z')]), {
      at,
      category: category(),
      candidates: [other],
    });
    expect(later.ranked[0]?.violations).toHaveLength(1);
  });

  it('primary artist only without includeFeatured', () => {
    const feat = song({ artists: ['Romanthony', 'Daft Punk'] });
    const daft = song({ artists: ['Daft Punk'] });
    const result = pickForSlot(
      snapshot(
        [artistRule(60, { includeFeatured: false })],
        [played(feat, '2026-06-10T11:30:00Z')],
      ),
      { at, category: category(), candidates: [daft] },
    );
    expect(result.ranked[0]?.violations).toEqual([]);
  });

  it('artist in items counts songs only', () => {
    const daft = song({ artists: ['Daft Punk'] });
    const fillers = [song(), song()];
    const jingle: PlayedItem = { ...played(song(), '2026-06-10T11:58:00Z'), type: 'jingle' };
    const history = [
      played(daft, '2026-06-10T11:40:00Z'),
      played(fillers[0] as PickCandidate, '2026-06-10T11:44:00Z'),
      played(fillers[1] as PickCandidate, '2026-06-10T11:48:00Z'),
      jingle,
    ];
    const rule = artistRule(3, { unit: 'items' });
    const result = pickForSlot(snapshot([rule], history), {
      at,
      category: category(),
      candidates: [daft],
    });
    expect(result.ranked[0]?.violations[0]?.values).toEqual({ items: 2, limit: 3 });
    const ok = pickForSlot(snapshot([artistRule(2, { unit: 'items' })], history), {
      at,
      category: category(),
      candidates: [daft],
    });
    expect(ok.ranked[0]?.violations).toEqual([]);
  });

  it('title ignores bracketed versions; album ignores missing albums', () => {
    expect(normalizeTitle('One More Time (Radio Edit) [2001 Remaster]')).toBe('one more time');
    const edit = song({ title: 'One More Time (Radio Edit)', album: 'Discovery' });
    const original = song({ title: 'one more time', album: null });
    const sameAlbum = song({ album: 'discovery' });
    const rules: RotationRule[] = [
      { ...base('title', 3), kind: 'title_separation', unit: 'minutes', value: 180 },
      { ...base('album', 6), kind: 'album_separation', unit: 'minutes', value: 120 },
    ];
    const result = pickForSlot(snapshot(rules, [played(edit, '2026-06-10T11:00:00Z')]), {
      at,
      category: category(),
      candidates: [original, sameAlbum],
    });
    expect(result.ranked.map((r) => r.violations.map((v) => v.kind))).toEqual([
      ['title_separation'],
      ['album_separation'],
    ]);
  });

  it('song rest uses the category rest and older plays', () => {
    const a = song();
    const rule: RotationRule = { ...base('rest', 2), kind: 'song_rest' };
    const snap: PickSnapshot = {
      ...snapshot([rule]),
      lastPlayedAt: new Map([[a.id, new Date('2026-06-10T10:00:00Z')]]),
    };
    const result = pickForSlot(snap, {
      at,
      category: category({ restMinutes: 180 }),
      candidates: [a],
    });
    expect(result.ranked[0]?.violations[0]?.values).toEqual({ minutes: 120, limit: 180 });
    const rested = pickForSlot(snap, {
      at,
      category: category({ restMinutes: 90 }),
      candidates: [a],
    });
    expect(rested.ranked[0]?.violations).toEqual([]);
  });
});

describe('tag rules', () => {
  const low = { key: 'energy' as const, value: '1' };
  const pop = { key: 'style' as const, value: 'Pop' };

  it('tag_run: no third energy=1 in a row', () => {
    const calm = [song({ tags: [low] }), song({ tags: [low] }), song({ tags: [low] })];
    const rule: RotationRule = { ...base('calm', 7), kind: 'tag_run', tag: low, maxRun: 2 };
    const history = [
      played(calm[0] as PickCandidate, '2026-06-10T11:50:00Z'),
      played(calm[1] as PickCandidate, '2026-06-10T11:54:00Z'),
    ];
    const result = pickForSlot(snapshot([rule], history), {
      at,
      category: category(),
      candidates: [calm[2] as PickCandidate],
    });
    expect(result.ranked[0]?.violations[0]?.values).toMatchObject({ run: 3, limit: 2 });
  });

  it('segue_ban: style X never right after style Y', () => {
    const rock = song({ tags: [{ key: 'style', value: 'rock' }] });
    const popSong = song({ tags: [{ key: 'style', value: 'pop' }] });
    const rule: RotationRule = {
      ...base('pop-after-rock', 7),
      kind: 'segue_ban',
      from: { key: 'style', value: 'Rock' },
      to: pop,
    };
    const result = pickForSlot(snapshot([rule], [played(rock, '2026-06-10T11:56:00Z')]), {
      at,
      category: category(),
      candidates: [popSong],
    });
    expect(result.ranked[0]?.violations[0]?.kind).toBe('segue_ban');
  });

  it('max_tag_per_hour counts the station-local clock hour', () => {
    const pops = [song({ tags: [pop] }), song({ tags: [pop] }), song({ tags: [pop] })];
    const rule: RotationRule = {
      ...base('pop-hour', 7),
      kind: 'max_tag_per_hour',
      tag: pop,
      max: 2,
    };
    // 11:59 UTC is 13:59 in Paris: the 13:00 hour. 12:00 UTC is 14:00: a new hour.
    const history = [
      played(pops[0] as PickCandidate, '2026-06-10T11:10:00Z'),
      played(pops[1] as PickCandidate, '2026-06-10T11:30:00Z'),
    ];
    const inHour = pickForSlot(snapshot([rule], history), {
      at: new Date('2026-06-10T11:59:00Z'),
      category: category(),
      candidates: [pops[2] as PickCandidate],
    });
    expect(inHour.ranked[0]?.violations).toHaveLength(1);
    const nextHour = pickForSlot(snapshot([rule], history), {
      at,
      category: category(),
      candidates: [pops[2] as PickCandidate],
    });
    expect(nextHour.ranked[0]?.violations).toEqual([]);
  });

  it('flow is a soft goal: reorders, never rejects', () => {
    const prev = song({ bpm: 120, energy: 0.5 });
    const jump = song({ bpm: 170, energy: 0.9 });
    const smooth = song({ bpm: 124, energy: 0.6 });
    const rule: RotationRule = {
      ...base('flow', 9),
      kind: 'flow',
      maxBpmStep: 10,
      maxEnergyStep: 0.2,
    };
    const history = [played(prev, '2026-06-10T11:56:00Z')];
    const result = pickForSlot(snapshot([rule], history), {
      at,
      category: category(),
      candidates: [jump, smooth],
    });
    expect(result.asset?.id).toBe(smooth.id);
    expect(result.relaxed).toEqual([]);
    const only = pickForSlot(snapshot([rule], history), {
      at,
      category: category(),
      candidates: [jump],
    });
    expect(only.asset?.id).toBe(jump.id);
    expect(only.ranked[0]?.notes[0]?.kind).toBe('flow');
    expect(only.relaxed).toEqual([]);
  });
});

describe('relaxation ladder', () => {
  const rules: RotationRule[] = [
    { ...base('title', 3), kind: 'title_separation', unit: 'minutes', value: 180 },
    artistRule(60),
    { ...base('album', 6), kind: 'album_separation', unit: 'minutes', value: 120 },
  ];

  it('drops the highest priority number first, ties by id', () => {
    expect(
      relaxationOrder([
        ...rules,
        { ...base('b-off', 6), enabled: false, kind: 'search_depth' },
        { ...base('a-hard', 9), breakable: false, kind: 'search_depth' },
        { ...base('aa', 6), kind: 'search_depth' },
      ]).map((r) => r.id),
    ).toEqual(['aa', 'album', 'artist', 'title']);
  });

  it('relaxes the lowest-priority rule and reports only what the pick breaks', () => {
    const daft = song({ artists: ['Daft Punk'], album: 'Discovery' });
    const sameAlbum = song({ artists: ['Other'], album: 'Discovery' });
    const sameArtist = song({ artists: ['Daft Punk'], album: 'Homework' });
    const history = [played(daft, '2026-06-10T11:30:00Z')];
    const result = pickForSlot(snapshot(rules, history), {
      at,
      category: category(),
      candidates: [sameArtist, sameAlbum],
    });
    expect(result.asset?.id).toBe(sameAlbum.id);
    expect(result.relaxed).toEqual([
      { rule: 'album_separation', reason: expect.stringContaining('album: blocked 1 of 2') },
    ]);
  });

  it('goes further down the ladder when it must, and falls back to rotation order', () => {
    const daft = song({ artists: ['Daft Punk'], album: 'Discovery', title: 'Aerodynamic' });
    const twin = song({ artists: ['Daft Punk'], album: 'Discovery', title: 'Aerodynamic' });
    const result = pickForSlot(snapshot(rules, [played(daft, '2026-06-10T11:30:00Z')]), {
      at,
      category: category(),
      candidates: [twin],
    });
    expect(result.asset?.id).toBe(twin.id);
    expect(result.relaxed.map((r) => r.rule)).toEqual([
      'album_separation',
      'artist_separation',
      'title_separation',
    ]);
  });

  it('never relaxes an unbreakable rule: the slot stays empty', () => {
    const daft = song({ artists: ['Daft Punk'] });
    const result = pickForSlot(
      snapshot([artistRule(60, { breakable: false })], [played(daft, '2026-06-10T11:30:00Z')]),
      { at, category: category(), candidates: [song({ artists: ['Daft Punk'] })] },
    );
    expect(result.asset).toBeNull();
  });

  it('search depth is a rule like the others', () => {
    const songs = [song(), song(), song(), song()];
    const history = songs.slice(0, 3).map((s, i) => played(s, `2026-06-10T11:${10 + i}:00Z`));
    const rules: RotationRule[] = [
      { ...base('depth', 4), kind: 'search_depth' },
      { ...base('rest', 2), kind: 'song_rest' },
    ];
    // Depth 25 %: only the least recently played (songs[3]) is within reach.
    const result = pickForSlot(snapshot(rules, history), {
      at,
      category: category({ searchDepthPercent: 25, restMinutes: 30 }),
      candidates: songs,
    });
    expect(result.asset?.id).toBe(songs[3]?.id);
    // With a 60 min rest every song rested too little: relaxing the depth (priority 4) is not
    // enough, so rest (2) goes too, and the pick (within depth) only breaks rest.
    const tired = pickForSlot(
      snapshot(rules, [...history, played(songs[3] as PickCandidate, '2026-06-10T11:40:00Z')]),
      { at, category: category({ searchDepthPercent: 25, restMinutes: 60 }), candidates: songs },
    );
    expect(tired.asset?.id).toBe(songs[0]?.id);
    expect(tired.relaxed.map((r) => r.rule)).toEqual(['song_rest']);
  });
});

describe('determinism', () => {
  const songs = Array.from({ length: 30 }, () => song());
  const weighted = category({ rotationOrder: 'weighted_random' });

  it('same seed, same pick; another seed, another draw', () => {
    const pick = (seed: string) =>
      pickForSlot(snapshot([], [], seed), { at, category: weighted, candidates: songs }).asset?.id;
    expect(pick('a')).toBe(pick('a'));
    const picks = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(pick));
    expect(picks.size).toBeGreaterThan(1);
  });

  it('randomFor is stable', () => {
    expect(randomFor('seed', 'key')).toBe(randomFor('seed', 'key'));
    expect(randomFor('seed', 'key')).not.toBe(randomFor('seed', 'other'));
  });

  it('weights favour long-idle songs', () => {
    const [fresh, idle] = [song(), song()];
    const history = [
      played(fresh as PickCandidate, '2026-06-10T11:59:00Z'),
      played(idle as PickCandidate, '2026-06-03T12:00:00Z'),
    ];
    let idleWins = 0;
    for (let i = 0; i < 50; i++) {
      const r = pickForSlot(snapshot([], history, `s${i}`), {
        at,
        category: weighted,
        candidates: [fresh as PickCandidate, idle as PickCandidate],
      });
      if (r.asset?.id === idle?.id) idleWins++;
    }
    expect(idleWins).toBeGreaterThan(45);
  });
});

describe('DST windows (Europe/Paris)', () => {
  const capped = category({ maxPlaysPerDay: 1, maxPlaysPerWeek: 2 });
  const rule: RotationRule = { ...base('max', 1), kind: 'max_plays' };

  it('day cap uses the 23-hour day of the last Sunday of March', () => {
    const a = song();
    // 2026-03-29: Paris day runs 2026-03-28T23:00Z → 2026-03-29T22:00Z (23 h).
    const history = [played(a, '2026-03-28T23:05:00Z')]; // 00:05 CET on the 29th
    const sameDay = pickForSlot(snapshot([rule], history), {
      at: new Date('2026-03-29T21:55:00Z'), // 23:55 CEST on the 29th
      category: capped,
      candidates: [a],
    });
    expect(sameDay.ranked[0]?.violations[0]?.values).toMatchObject({ window: 'day', plays: 1 });
    const nextDay = pickForSlot(snapshot([rule], history), {
      at: new Date('2026-03-29T22:00:00Z'), // 00:00 on the 30th
      category: capped,
      candidates: [a],
    });
    expect(nextDay.ranked[0]?.violations).toEqual([]);
  });

  it('day cap uses the 25-hour day of the last Sunday of October', () => {
    const a = song();
    // 2026-10-25: Paris day runs 2026-10-24T22:00Z → 2026-10-25T23:00Z (25 h).
    const history = [played(a, '2026-10-24T22:05:00Z')];
    const sameDay = pickForSlot(snapshot([rule], history), {
      at: new Date('2026-10-25T22:55:00Z'), // 23:55 CET on the 25th
      category: capped,
      candidates: [a],
    });
    expect(sameDay.ranked[0]?.violations).toHaveLength(1);
    const before = pickForSlot(snapshot([rule], history), {
      at: new Date('2026-10-24T21:55:00Z'), // 23:55 CEST on the 24th
      category: capped,
      candidates: [a],
    });
    expect(before.ranked[0]?.violations).toEqual([]);
  });

  it('week cap spans the ISO week across both changes', () => {
    const a = song();
    // Week of Monday 2026-10-19 (Paris) to Monday 2026-10-26 00:00 CET = 2026-10-25T23:00Z.
    const history = [
      played(a, '2026-10-18T22:30:00Z'), // 00:30 CEST Monday 19th: in the week
      played(a, '2026-10-22T10:00:00Z'),
    ];
    const lastHour = pickForSlot(snapshot([rule], history), {
      at: new Date('2026-10-25T22:59:00Z'), // 23:59 CET Sunday 25th
      category: category({ maxPlaysPerWeek: 2 }),
      candidates: [a],
    });
    expect(lastHour.ranked[0]?.violations[0]?.values).toMatchObject({ window: 'week', plays: 2 });
    const nextWeek = pickForSlot(snapshot([rule], history), {
      at: new Date('2026-10-25T23:00:00Z'),
      category: category({ maxPlaysPerWeek: 2 }),
      candidates: [a],
    });
    expect(nextWeek.ranked[0]?.violations).toEqual([]);
  });

  it('same hour yesterday follows wall-clock hours across the changes', () => {
    const a = song();
    const rule: RotationRule = {
      ...base('kick', 7),
      kind: 'same_hour_yesterday',
      windowMinutes: 60,
    };
    // Saturday 28 March 10:15 CET = 09:15Z; Sunday 29 March 10:30 CEST = 08:30Z.
    const march = pickForSlot(snapshot([rule], [played(a, '2026-03-28T09:15:00Z')]), {
      at: new Date('2026-03-29T08:30:00Z'),
      category: category(),
      candidates: [a],
    });
    expect(march.ranked[0]?.violations[0]?.kind).toBe('same_hour_yesterday');
    // Monday 26 Oct 10:30 CET = 09:30Z; Sunday 25 Oct 10:15 CET = 09:15Z: same wall hour.
    const october = pickForSlot(snapshot([rule], [played(a, '2026-10-25T09:15:00Z')]), {
      at: new Date('2026-10-26T09:30:00Z'),
      category: category(),
      candidates: [a],
    });
    expect(october.ranked[0]?.violations).toHaveLength(1);
    // 24 h earlier is not the rule: 08:15Z on the 25th was 09:15 CET, another hour.
    const other = pickForSlot(snapshot([rule], [played(a, '2026-10-25T08:15:00Z')]), {
      at: new Date('2026-10-26T09:30:00Z'),
      category: category(),
      candidates: [a],
    });
    expect(other.ranked[0]?.violations).toEqual([]);
  });

  it('a window inside the spring-forward gap is empty', () => {
    const a = song();
    const rule: RotationRule = {
      ...base('kick', 7),
      kind: 'same_hour_yesterday',
      windowMinutes: 60,
    };
    // Monday 30 March 02:30 CEST = 00:30Z. Yesterday's 02:00–03:00 never happened; 01:59 CET
    // (00:59Z) and 03:00 CEST (01:00Z) are outside it.
    const result = pickForSlot(
      snapshot([rule], [played(a, '2026-03-29T00:59:00Z'), played(a, '2026-03-29T01:00:00Z')]),
      { at: new Date('2026-03-30T00:30:00Z'), category: category(), candidates: [a] },
    );
    expect(result.ranked[0]?.violations).toEqual([]);
  });
});

describe('a generated week (property)', () => {
  /** Small seeded PRNG for the generator. */
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), s | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('never breaks a rule it did not relax', () => {
    for (const seed of [1, 2]) {
      const r = rng(seed);
      const artists = Array.from({ length: 120 }, (_, i) => `Band ${i}`);
      const styles = ['pop', 'rock', 'soul'];
      const library = Array.from({ length: 400 }, (_, i) =>
        song({
          artists:
            r() < 0.2
              ? [artists[Math.floor(r() * 120)] as string, artists[Math.floor(r() * 120)] as string]
              : [artists[Math.floor(r() * 120)] as string],
          album: r() < 0.7 ? `Album ${Math.floor(r() * 150)}` : null,
          title: `Title ${i % 350}`,
          tags: [
            { key: 'style', value: styles[Math.floor(r() * 3)] as string },
            { key: 'energy', value: String(1 + Math.floor(r() * 3)) },
          ],
        }),
      );
      const rules: RotationRule[] = [
        { ...base('max', 1), kind: 'max_plays' },
        { ...base('rest', 2), kind: 'song_rest' },
        { ...base('title', 3), kind: 'title_separation', unit: 'minutes', value: 180 },
        { ...base('depth', 4), kind: 'search_depth' },
        artistRule(70),
        { ...base('album', 6), kind: 'album_separation', unit: 'minutes', value: 120 },
        { ...base('kick', 7), kind: 'same_hour_yesterday', windowMinutes: 60 },
        {
          ...base('calm', 8),
          kind: 'tag_run',
          tag: { key: 'energy', value: '1' },
          maxRun: 2,
        },
        {
          ...base('rock-pop', 9),
          kind: 'segue_ban',
          from: { key: 'style', value: 'rock' },
          to: { key: 'style', value: 'pop' },
        },
        {
          ...base('soul-hour', 10),
          kind: 'max_tag_per_hour',
          tag: { key: 'style', value: 'soul' },
          max: 4,
        },
      ];
      const cat = category({
        restMinutes: 360,
        searchDepthPercent: 60,
        maxPlaysPerDay: 3,
        maxPlaysPerWeek: 12,
        rotationOrder: seed === 2 ? 'weighted_random' : 'least_recently_played',
      });
      // A week of 4-minute slots, starting the Monday before the October change.
      const start = new Date('2026-10-19T00:00:00Z').getTime();
      const slots = Array.from({ length: 7 * 24 * 15 }, (_, i) => ({
        at: new Date(start + i * 4 * 60_000),
        category: cat,
        candidates: library,
      }));
      const snap = snapshot(rules, [], `week-${seed}`);
      const results = pickSequence(snap, slots);

      const picks = results.map((result, i) => {
        expect(result.asset).not.toBeNull();
        // The pick's own verdict lists exactly the rules the ladder relaxed for it.
        const verdict = result.ranked.find((v) => v.picked);
        expect(new Set(verdict?.violations.map((v) => v.kind))).toEqual(
          new Set(result.relaxed.map((x) => x.rule)),
        );
        return { asset: result.asset as PickCandidate, at: slots[i]?.at as Date, result };
      });

      // Independent oracle for a few rules: brute force over the earlier picks.
      picks.forEach((pick, i) => {
        const relaxed = new Set(pick.result.relaxed.map((x) => x.rule));
        const artists = new Set(pick.asset.artists.map((a) => a.toLowerCase()));
        for (let j = i - 1; j >= 0; j--) {
          const other = picks[j] as (typeof picks)[number];
          const minutes = (pick.at.getTime() - other.at.getTime()) / 60_000;
          if (minutes >= 360) break;
          if (!relaxed.has('song_rest')) expect(other.asset.id).not.toBe(pick.asset.id);
          if (minutes < 70 && !relaxed.has('artist_separation')) {
            expect(other.asset.artists.some((a) => artists.has(a.toLowerCase()))).toBe(false);
          }
          if (minutes < 180 && !relaxed.has('title_separation')) {
            expect(normalizeTitle(other.asset.title)).not.toBe(normalizeTitle(pick.asset.title));
          }
        }
      });
      // The library is big enough for the rules to hold most of the time.
      const relaxedSlots = results.filter((x) => x.relaxed.length > 0).length;
      expect(relaxedSlots / results.length).toBeLessThan(0.1);
    }
  }, 60_000);
});
