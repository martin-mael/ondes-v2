import { type ClockSlot, clockSlotSchema, LOG_TRANSITION_MS } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { fixtureAsset } from '../generator/fixture.ts';
import type {
  AnchorTools,
  GeneratorAsset,
  GeneratorCategory,
  GeneratorSnapshot,
  PlannedItem,
} from '../generator/types.ts';
import { type PlayedItem, pickForSlot, playedFrom, removeFromHistory } from '../rules/index.ts';
import { backTimeRun } from './backtime.ts';

// `backTimeRun` on hand-made runs (#46 review): the tail past a VT, the jingle that fits best,
// and the picks it drops leaving the rules' history.

const CLOCK = '00000000-0000-7000-8c10-0000000000c1';
const MUSIC = '00000000-0000-7000-8c01-0000000000c1';
const JINGLES = '00000000-0000-7000-8c01-0000000000c2';
const T = Date.parse('2026-06-10T12:00:00Z');
const S = 1_000;

const slot = (input: Record<string, unknown>): ClockSlot => clockSlotSchema.parse(input);
/** An asset whose log length is exactly `ms`. */
const asset = (n: number, ms: number, type: GeneratorAsset['type'] = 'song') =>
  fixtureAsset(n, { type, durationMs: ms - LOG_TRANSITION_MS, overlapMs: 0 });

function snapshot(songs: GeneratorAsset[], jingles: GeneratorAsset[]): GeneratorSnapshot {
  const category = (id: string, members: GeneratorAsset[]): GeneratorCategory => ({
    id,
    assetType: members[0]?.type ?? 'song',
    rotationOrder: 'sequential',
    searchDepthPercent: 100,
    restMinutes: 0,
    maxPlaysPerDay: null,
    maxPlaysPerWeek: null,
    members,
  });
  return {
    stationId: '00000000-0000-7000-8000-0000000000c1',
    timeZone: 'Europe/Paris',
    grid: { defaultClockId: CLOCK, cells: [], overrides: [] },
    clocks: new Map([
      [
        CLOCK,
        {
          id: CLOCK,
          targetDurationMs: 3_600_000,
          slots: [
            slot({ kind: 'category', categoryId: MUSIC }),
            slot({ kind: 'jingle', categoryId: JINGLES }),
          ],
        },
      ],
    ]),
    categories: new Map([
      [MUSIC, category(MUSIC, songs)],
      [JINGLES, category(JINGLES, jingles)],
    ]),
    assets: new Map(),
    rules: [],
    history: [],
    occurrences: [],
  };
}

/** Picks the first accepted member, records releases. */
function tools(snap: GeneratorSnapshot) {
  const released: { assetId: string | null; start: string }[] = [];
  const t: AnchorTools = {
    pick: ({ categoryId, accept }) => {
      const found = snap.categories.get(categoryId)?.members.find(accept);
      return found ? { asset: found, relaxedRules: [] } : null;
    },
    release: (item) => released.push({ assetId: item.assetId, start: item.start.toISOString() }),
  };
  return { tools: t, released };
}

function item(kind: PlannedItem['kind'], start: number, ms: number, a?: GeneratorAsset) {
  return {
    keptId: null,
    kind,
    plannedDurationMs: ms,
    assetId: a?.id ?? null,
    episodeId: null,
    liveSlotId: null,
    title: null,
    timing: 'flow',
    anchorAt: null,
    capMs: null,
    origin: { type: 'clock', clockId: CLOCK, slotIndex: kind === 'song' ? 0 : 1 },
    relaxedRules: [],
    segmentId: null,
    crossOutMs: null,
    start: new Date(start),
  } satisfies PlannedItem;
}

const anchor: PlannedItem = {
  ...item('episode', T, 3_600_000),
  timing: 'hard',
  anchorAt: new Date(T),
  origin: { type: 'show', showSlotId: null },
};
const end = (run: PlannedItem[]) => {
  const last = run.at(-1) as PlannedItem;
  return last.start.getTime() + last.plannedDurationMs;
};

describe('backTimeRun on a hand-made tail', () => {
  it('fits the jingle a little longer than the gap, cutting the song to make room', () => {
    const song = asset(1, 200 * S);
    const snap = snapshot([song], [asset(10, 2 * S, 'jingle'), asset(11, 10 * S, 'jingle')]);
    // The song ends 9 s before the anchor: the 10 s jingle, the song cut by 1 s.
    const run = [item('song', T - 209 * S, 200 * S, song)];
    const out = backTimeRun(snap, {
      anchor,
      run,
      runEndsAt: new Date(T - 9 * S),
      tools: tools(snap).tools,
    });
    expect(out.map((i) => [i.kind, i.plannedDurationMs])).toEqual([
      ['song', 199 * S],
      ['jingle', 10 * S],
    ]);
    expect(end(out)).toBe(T);
  });

  it('takes the longest jingle that fits when the song can not give the time', () => {
    // 91 s: at most 1 s may go, not the 3 s a 12 s jingle needs.
    const song = asset(1, 91 * S);
    const snap = snapshot(
      [song],
      [asset(10, 2 * S, 'jingle'), asset(11, 8 * S, 'jingle'), asset(12, 12 * S, 'jingle')],
    );
    const run = [item('song', T - 100 * S, 91 * S, song)];
    const out = backTimeRun(snap, {
      anchor,
      run,
      runEndsAt: new Date(T - 9 * S),
      tools: tools(snap).tools,
    });
    expect(out.at(-1)).toMatchObject({ kind: 'jingle', plannedDurationMs: 8 * S });
    expect(T - end(out)).toBe(S);
  });

  it('keeps a VT at the end of the tail, cutting the song before it', () => {
    const song = asset(1, 200 * S);
    const vt = asset(20, 20 * S, 'vt');
    const snap = snapshot([song], [asset(10, 15 * S, 'jingle')]);
    // Song then VT end 5 s past the anchor.
    const run = [item('song', T - 215 * S, 200 * S, song), item('vt', T - 15 * S, 20 * S, vt)];
    const out = backTimeRun(snap, {
      anchor,
      run,
      runEndsAt: new Date(T + 5 * S),
      tools: tools(snap).tools,
    });
    expect(out.map((i) => i.kind)).toEqual(['song', 'vt', 'jingle']);
    expect(out[1]).toMatchObject({ assetId: vt.id, plannedDurationMs: 20 * S });
    expect(end(out)).toBe(T);
  });

  it('releases the picks it drops, at the start they were picked for', () => {
    const a = asset(1, 200 * S);
    const b = asset(2, 200 * S);
    const snap = snapshot([a, b], [asset(10, 2 * S, 'jingle')]);
    // b starts 30 s before the anchor and can give 45 s at most: it goes (170 s too long).
    const run = [item('song', T - 230 * S, 200 * S, a), item('song', T - 30 * S, 200 * S, b)];
    const t = tools(snap);
    const out = backTimeRun(snap, {
      anchor,
      run,
      runEndsAt: new Date(T + 170 * S),
      tools: t.tools,
    });
    expect(out.map((i) => i.assetId)).not.toContain(b.id);
    expect(t.released).toContainEqual({
      assetId: b.id,
      start: new Date(T - 30 * S).toISOString(),
    });
  });
});

describe('backTimeRun before a not-before marker (#52, ADR 0036)', () => {
  const marker: PlannedItem = {
    ...item('marker', T, 0),
    timing: 'not_before',
    anchorAt: new Date(T),
  };

  it('drops and shortens nothing when the run ends after the marker', () => {
    const a = asset(1, 200 * S);
    const b = asset(2, 200 * S);
    const snap = snapshot([a, b], [asset(10, 2 * S, 'jingle')]);
    // Hard, b would go (170 s too long); not before, it airs whole and the item waits.
    const run = [item('song', T - 230 * S, 200 * S, a), item('song', T - 30 * S, 200 * S, b)];
    const t = tools(snap);
    const out = backTimeRun(snap, {
      anchor: marker,
      run,
      runEndsAt: new Date(T + 170 * S),
      tools: t.tools,
    });
    expect(out).toEqual(run);
    expect(t.released).toEqual([]);
  });

  it('leaves a run that ends a few seconds late as it is', () => {
    const song = asset(1, 200 * S);
    const snap = snapshot([song], [asset(10, 10 * S, 'jingle')]);
    const run = [item('song', T - 195 * S, 200 * S, song)];
    const out = backTimeRun(snap, {
      anchor: marker,
      run,
      runEndsAt: new Date(T + 5 * S),
      tools: tools(snap).tools,
    });
    expect(out).toEqual(run);
  });

  it('fills an early run up to the marker without cutting the song', () => {
    const song = asset(1, 200 * S);
    const snap = snapshot(
      [song],
      [asset(10, 2 * S, 'jingle'), asset(11, 8 * S, 'jingle'), asset(12, 10 * S, 'jingle')],
    );
    // 9 s early: hard would take the 10 s jingle and cut the song by 1 s; not before takes the
    // 8 s one and leaves the song whole (the item waits a second).
    const run = [item('song', T - 209 * S, 200 * S, song)];
    const out = backTimeRun(snap, {
      anchor: marker,
      run,
      runEndsAt: new Date(T - 9 * S),
      tools: tools(snap).tools,
    });
    expect(out.map((i) => [i.kind, i.plannedDurationMs])).toEqual([
      ['song', 200 * S],
      ['jingle', 8 * S],
    ]);
    expect(end(out)).toBeLessThanOrEqual(T);
  });
});

describe('releasing a pick', () => {
  it('takes it out of the history the picker has indexed', () => {
    const songs = [asset(1, 200 * S), asset(2, 200 * S), asset(3, 200 * S)];
    const snap = snapshot(songs, []);
    const category = {
      ...(snap.categories.get(MUSIC) as GeneratorCategory),
      rotationOrder: 'least_recently_played' as const,
    };
    const history: PlayedItem[] = [];
    const pick = (at: number) =>
      pickForSlot(
        { timeZone: snap.timeZone, rules: [], history, explain: false },
        { at: new Date(at), category, candidates: category.members },
      ).asset;
    const first = pick(T) as GeneratorAsset;
    history.push(playedFrom(first, new Date(T)));
    // Played: rotation moves on to another song.
    const second = pick(T + 200 * S) as GeneratorAsset;
    expect(second.id).not.toBe(first.id);
    // Released: the first song is the least recently played again.
    expect(removeFromHistory(history, (p) => p.assetId === first.id)).toBe(1);
    expect(pick(T + 200 * S)?.id).toBe(first.id);
  });
});
