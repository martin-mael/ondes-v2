import {
  deriveIslands,
  type IslandMedia,
  type IslandSegueInput,
  islandHash,
  type LogItem,
} from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { type IslandLayoutInput, layoutIslands } from './islands.ts';
import { buildPushChain, buildPushItem, type FeedMedia } from './push.ts';
import type { FeedIsland } from './repo.ts';

const SR = 44_100;
const s = (seconds: number) => Math.round(seconds * SR);
const station = { loudnessTargetLufs: -16, truePeakLimitDbtp: -1 };
const sha = (c: string) => c.repeat(64);
const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ASSET = { a: uuid(101), b: uuid(102), c: uuid(103), vt: uuid(104), vt2: uuid(105) };
const ITEM = { a: uuid(1), b: uuid(2), c: uuid(3) };

/** Playout media; the A cue-in is off the grid on purpose. */
function feedMedia(assetId: string, c: string, seconds: number, cueIn = 0): FeedMedia {
  return {
    assetId,
    fileId: `file-${c}`,
    sha256: sha(c),
    ext: 'flac',
    flacBlockSize: 1024,
    durationSamples: s(seconds),
    sampleRate: SR,
    cached: true,
    title: `Title ${c}`,
    artists: [`Artist ${c}`],
    cues: {
      sampleRate: SR,
      cueIn,
      cueOut: null,
      fadeIn: null,
      fadeOut: null,
      crossStartNext: null,
    },
    gain: { normalizeLoudness: false, gainOverrideDb: null, loudness: null },
  };
}

const MEDIA = {
  a: feedMedia(ASSET.a, 'a', 180, 88_211),
  b: feedMedia(ASSET.b, 'b', 200),
  c: feedMedia(ASSET.c, 'c', 150),
  vt: feedMedia(ASSET.vt, 'd', 5),
  vt2: feedMedia(ASSET.vt2, 'e', 4),
};

const islandMedia = (m: FeedMedia): IslandMedia => ({
  assetId: m.assetId,
  sha256: m.sha256,
  storageKey: `org/o/sha256/${m.sha256}.flac`,
  sampleRate: SR,
  durationSamples: m.durationSamples as number,
  flacBlockSize: 1024,
  gainDb: 0,
  cueIn: m.cues?.cueIn ?? 0,
  cueOut: m.durationSamples as number,
});

function item(id: string, assetId: string, extra: Partial<LogItem> = {}): LogItem {
  return {
    id,
    logDayId: 'day',
    position: 0,
    kind: 'song',
    plannedStart: '2026-10-21T10:00:00.000Z',
    plannedDurationMs: 180_000,
    assetId,
    asset: null,
    episodeId: null,
    liveSlotId: null,
    title: null,
    cueOverrides: null,
    timing: 'flow',
    anchorAt: null,
    capMs: null,
    origin: { type: 'manual' },
    locked: false,
    relaxedRules: [],
    segmentId: null,
    conflict: null,
    parts: [],
    ...extra,
  };
}

/** A ducks to −12 dB under a 5 s voice starting 3 s before its end; B comes in under it. */
function segue(
  id: string,
  from: [string, FeedMedia],
  to: [string, FeedMedia],
  voice: FeedMedia,
): IslandSegueInput {
  return {
    segueId: id,
    fromItemId: from[0],
    toItemId: to[0],
    from: islandMedia(from[1]),
    to: islandMedia(to[1]),
    out: {
      envelope: [
        { at: s(-3.5), gainDb: 0 },
        { at: s(-3), gainDb: -12 },
      ],
    },
    in: {
      start: s(-0.5),
      envelope: [
        { at: s(2), gainDb: -12 },
        { at: s(2.5), gainDb: 0 },
      ],
    },
    voices: [
      { assetId: voice.assetId, start: s(-3), gainDb: 0, envelope: [], media: islandMedia(voice) },
    ],
  };
}

function islandsOf(chain: IslandSegueInput[], state: 'cached' | 'not_cached' | 'pending') {
  return deriveIslands(chain).map(
    (plan, i): FeedIsland => ({
      hash: islandHash(plan.spec),
      plan,
      rendered:
        state === 'pending'
          ? null
          : { islandId: uuid(900 + i), sha256: sha(String(i)), cached: state === 'cached' },
    }),
  );
}

function input(islands: FeedIsland[], extra: Partial<IslandLayoutInput> = {}): IslandLayoutInput {
  return {
    items: [item(ITEM.a, ASSET.a), item(ITEM.b, ASSET.b), item(ITEM.c, ASSET.c)],
    media: new Map([MEDIA.a, MEDIA.b, MEDIA.c].map((m) => [m.assetId, m])),
    islands,
    islandMedia: new Map(Object.values(MEDIA).map((m) => [m.assetId, m])),
    reason: (m) => (m?.cached ? null : 'not_cached'),
    refused: () => false,
    locked: new Set(),
    ...extra,
  };
}

/** What Liquidsoap plays of a request: ceil(out·sr) − ceil(in·sr) samples (spike #12). */
const played = (p: { cue_in?: number; cue_out?: number }) =>
  Math.ceil((p.cue_out as number) * SR) - Math.ceil((p.cue_in ?? 0) * SR);

const AB = () => segue(uuid(201), [ITEM.a, MEDIA.a], [ITEM.b, MEDIA.b], MEDIA.vt);
const BC = () => segue(uuid(202), [ITEM.b, MEDIA.b], [ITEM.c, MEDIA.c], MEDIA.vt2);

describe('layoutIslands: a ready, cached island', () => {
  it('airs A body, island, B body as one segment under A, cut to the sample', () => {
    const [island] = islandsOf([AB()], 'cached');
    const plan = (island as FeedIsland).plan;
    const layout = layoutIslands(input([island as FeedIsland]));
    const chain = layout.chains.get(ITEM.a);
    expect(chain?.itemIds).toEqual([ITEM.a, ITEM.b]);
    expect(layout.overlays.size).toBe(0);

    const body = buildPushChain(chain?.source as never, { station });
    expect(body.segment_id).toBe(ITEM.a);
    const [a, isl, b] = body.parts;
    // A's cue-in moved up to the grid: 88 211 → 88 064 + 1024 = 89 088 (ADR 0018).
    expect(Math.ceil((a?.cue_in as number) * SR)).toBe(89_088);
    expect(played(a as never)).toBe(plan.head.joinSample - 89_088);
    expect(a?.item_id).toBe(ITEM.a);
    expect(isl).toEqual({
      item_id: `island:${island?.hash}`,
      uri: `/cache/media/00/${sha('0')}.flac`,
      amplify_db: 0,
      title: 'Title b',
      artist: 'Artist b',
    });
    // B starts at the tail join (on its grid), biased by half a sample, and plays to its end.
    expect(plan.tail.joinSample % 1024).toBe(0);
    expect(Math.ceil((b?.cue_in as number) * SR)).toBe(plan.tail.joinSample);
    expect(played(b as never)).toBe(s(200) - plan.tail.joinSample);
    expect(body.overlay).toBeUndefined();

    expect(chain?.parts.map((p) => p.id)).toEqual([ITEM.a, `island:${island?.hash}`, ITEM.b]);
    expect(chain?.transitions.get(`island:${island?.hash}`)).toMatchObject({
      rendered: true,
      islandId: uuid(900),
      segueIds: [uuid(201)],
      voices: [{ assetId: ASSET.vt, title: 'Title d', durationMs: 5000 }],
    });
  });

  it('joins islands that share an item into one chain: A, I1, B, I2, C', () => {
    const islands = islandsOf([AB(), BC()], 'cached');
    expect(islands).toHaveLength(2);
    const layout = layoutIslands(input(islands));
    const chain = layout.chains.get(ITEM.a);
    expect(chain?.itemIds).toEqual([ITEM.a, ITEM.b, ITEM.c]);
    const body = buildPushChain(chain?.source as never, { station });
    expect(body.parts.map((p) => p.item_id)).toEqual([
      ITEM.a,
      `island:${islands[0]?.hash}`,
      ITEM.b,
      `island:${islands[1]?.hash}`,
      ITEM.c,
    ]);
    // B's body runs from the first island's tail join to the second's head join.
    const b = body.parts[2];
    expect(Math.ceil((b?.cue_in as number) * SR)).toBe(islands[0]?.plan.tail.joinSample);
    expect(played(b as never)).toBe(
      (islands[1]?.plan.head.joinSample as number) - (islands[0]?.plan.tail.joinSample as number),
    );
  });
});

describe('layoutIslands: the fallback', () => {
  it('lays the voice over A’s crossfade, ducked, when the render isn’t cached', () => {
    const [island] = islandsOf([AB()], 'not_cached');
    const layout = layoutIslands(input([island as FeedIsland]));
    expect(layout.chains.size).toBe(0);
    const overlay = layout.overlays.get(ITEM.a);
    expect(overlay?.voices).toEqual([
      {
        uri: `/cache/media/dd/${sha('d')}.flac`,
        start: -3,
        duration: 5,
        cueOut: Number(((s(5) + 0.5) / SR).toFixed(6)),
        duckDb: -12,
      },
    ]);
    expect(overlay?.transition).toMatchObject({ rendered: false, segueIds: [uuid(201)] });

    // A plays 180 s − its cue-in: the voice starts 3 s before that.
    const pushed = buildPushItem(
      { itemId: ITEM.a, title: null, cueOverrides: null, media: MEDIA.a },
      { station, overlay: overlay?.voices },
    );
    const length = (s(180) - 88_211) / SR;
    expect(pushed.overlay?.[0]?.at).toBeCloseTo(length - 3, 3);
    expect(pushed.overlay?.[0]?.duck_db).toBe(-12);
  });

  it('falls back when nothing is rendered, and fetches a voice not cached yet', () => {
    const [island] = islandsOf([AB()], 'pending');
    const notCached = new Map(Object.values(MEDIA).map((m) => [m.assetId, m]));
    notCached.set(ASSET.vt, { ...MEDIA.vt, cached: false });
    const layout = layoutIslands(input([island as FeedIsland], { islandMedia: notCached }));
    expect(layout.chains.size).toBe(0);
    expect(layout.overlays.size).toBe(0);
    expect(layout.missingFiles).toEqual(['file-d']);
  });

  it('never chains over a B that already aired in this boot', () => {
    const [island] = islandsOf([AB()], 'cached');
    const layout = layoutIslands(input([island as FeedIsland], { locked: new Set([ITEM.b]) }));
    expect(layout.chains.size).toBe(0);
    expect(layout.overlays.get(ITEM.a)?.voices).toHaveLength(1);
  });

  it('times voices after a chain that ends on its island from the island’s length', () => {
    const [island] = islandsOf([AB()], 'cached');
    const chain = layoutIslands(input([island as FeedIsland])).chains.get(ITEM.a);
    const source = { ...chain?.source, steps: chain?.source.steps.slice(0, 2) } as never;
    const body = buildPushChain(source, {
      station,
      overlay: [{ uri: '/cache/v.flac', start: -1, duration: 2 }],
    });
    const length = (island?.plan.spec.lengthSamples as number) / SR;
    expect(body.overlay?.[0]?.at).toBeCloseTo(length - 1, 2);
  });

  it('keeps an item on air or aired as it was pushed', () => {
    const [island] = islandsOf([AB()], 'cached');
    const layout = layoutIslands(input([island as FeedIsland], { locked: new Set([ITEM.a]) }));
    expect(layout.chains.size).toBe(0);
    expect(layout.overlays.get(ITEM.a)?.voices).toHaveLength(1);
  });

  it('never chains over an anchored B, nor an island file the engine refused', () => {
    const [island] = islandsOf([AB()], 'cached');
    const anchored = input([island as FeedIsland]);
    anchored.items = [
      item(ITEM.a, ASSET.a),
      item(ITEM.b, ASSET.b, { timing: 'hard', anchorAt: '2026-10-21T10:03:00.000Z' }),
    ];
    expect(layoutIslands(anchored).chains.size).toBe(0);
    const refused = layoutIslands(input([island as FeedIsland], { refused: () => true }));
    expect(refused.chains.size).toBe(0);
    expect(refused.overlays.size).toBe(1);
  });

  it('falls back when B isn’t playable', () => {
    const [island] = islandsOf([AB()], 'cached');
    const media = new Map([MEDIA.a, { ...MEDIA.b, cached: false }].map((m) => [m.assetId, m]));
    const layout = layoutIslands(input([island as FeedIsland], { media }));
    expect(layout.chains.size).toBe(0);
    expect(layout.overlays.size).toBe(1);
  });
});
