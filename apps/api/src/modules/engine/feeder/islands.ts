import {
  type AsRunTransition,
  type AsRunVoice,
  envelopeGainAt,
  type IslandSource,
  type LogItem,
  PLAYOUT_SAMPLE_RATE,
  playoutPath,
  validThroughout,
} from '@ondes/shared';
import type { SkipReason } from './plan.ts';
import {
  type ChainBody,
  type ChainIsland,
  type ChainSource,
  chainBodyRange,
  chainStepLengthsMs,
  type FeedMedia,
  islandEngineId,
  type OverlayVoice,
} from './push.ts';
import type { FeedIsland } from './repo.ts';

// How the islands of the window air (#57, ADR 0024). Pure: the feeder loads the log, its media
// and the islands its segues call for (repo.ts `loadFeedIslands`); this decides, per island:
//
// - **Chain**: its render is ready and cached, and every item it covers can play. The items
//   become one queue entry, `A body, island, B body`, pushed as one segment under the head
//   item's id (islands that follow one another join the same chain: `A, I1, B, I2, C`).
// - **Fallback**: anything else. The items air as usual, with the standard crossfade, and the
//   island's voices are laid over the transition out of its head item, the music ducked under
//   them (the engine's voice overlay). Degraded: frame-granular, not what was previewed.
//
// An item that is on air or aired during this boot can't start a chain any more: the
// transition plays the way it was pushed.

export type IslandLayoutInput = {
  /** Top-level items of the window, in play order. */
  items: readonly LogItem[];
  media: ReadonlyMap<string, FeedMedia>;
  islands: readonly FeedIsland[];
  /** Media of the assets the islands play (voices included). */
  islandMedia: ReadonlyMap<string, FeedMedia>;
  /** Why an item's or a voice's media can't air now; null when it can. */
  reason(media: FeedMedia | undefined): SkipReason | null;
  /** The engine refused this island file lately. */
  refused(sha256: string): boolean;
  /** Items no chain may cover: on air, or aired during this boot. */
  locked: ReadonlySet<string>;
  /** Engine-side cache root. */
  engineRoot?: string | undefined;
  /** The feeder's clock: a voice is checked against its validity from then on (#60). */
  nowMs?: number | undefined;
};

export type FeedChain = {
  source: ChainSource;
  /** The log items it covers, in play order (head first). */
  itemIds: string[];
  /** Engine `item_id` and length of each part, in play order. */
  parts: { id: string; durationMs: number }[];
  /** What the as-run records against each island part, by engine `item_id`. */
  transitions: Map<string, AsRunTransition>;
  /** Asset files of its bodies. */
  fileIds: string[];
};

export type FeedOverlay = {
  voices: OverlayVoice[];
  /** The voices' offsets are set once the body (and so its length) is known. */
  transition: AsRunTransition;
};

export type IslandLayout = {
  /** By head item id. */
  chains: Map<string, FeedChain>;
  /** By the item the voices follow (the island's head). */
  overlays: Map<string, FeedOverlay>;
  /** Voice files the fallback needs that can't air yet (urgent fetch). */
  missingFiles: string[];
};

const MEDIA_KINDS: readonly LogItem['kind'][] = ['song', 'vt', 'jingle', 'bed', 'episode', 'fill'];
/** The deepest duck the fallback applies, and above which a gain counts as no duck. */
const MAX_DUCK_DB = -40;
const NO_DUCK_DB = -0.5;

export function layoutIslands(input: IslandLayoutInput): IslandLayout {
  const index = new Map(input.items.map((item, i) => [item.id, i]));
  const chains = new Map<string, FeedChain>();
  const overlays = new Map<string, FeedOverlay>();
  const missing = new Set<string>();

  const sorted = [...input.islands]
    .filter((i) => index.has(i.plan.head.itemId))
    .sort((a, b) => (index.get(a.plan.head.itemId) ?? 0) - (index.get(b.plan.head.itemId) ?? 0));

  const addOverlay = (island: FeedIsland) => {
    const overlay = fallbackOverlay(island, input, missing);
    if (overlay) overlays.set(island.plan.head.itemId, overlay);
  };
  /** The chain being extended: islands that follow one another (tail = next head). */
  let run: { island: FeedIsland; items: LogItem[] }[] = [];
  const flush = () => {
    const chain = run.length ? buildChain(run, input) : null;
    if (chain) chains.set(chain.source.segmentId, chain);
    else for (const { island } of run) addOverlay(island);
    run = [];
  };

  for (const island of sorted) {
    // A voice that may not air then (a promo past its kill date, #60): the transition airs as
    // a plain crossfade, without the island or its overlay.
    if (voiceOutOfValidity(island, input, index)) {
      flush();
      continue;
    }
    const items = coveredItems(island, input, index);
    if (items && chainable(island, items, input)) {
      const last = run.at(-1);
      if (last && last.island.plan.tail.itemId !== island.plan.head.itemId) flush();
      run.push({ island, items });
      continue;
    }
    flush();
    addOverlay(island);
  }
  flush();
  return { chains, overlays, missingFiles: [...missing] };
}

/** The island's items, in the window and consecutive; null when they aren't. */
function coveredItems(
  island: FeedIsland,
  input: IslandLayoutInput,
  index: ReadonlyMap<string, number>,
): LogItem[] | null {
  const items: LogItem[] = [];
  let previous: number | null = null;
  for (const id of island.plan.itemIds) {
    const i = index.get(id);
    if (i === undefined || (previous !== null && i !== previous + 1)) return null;
    previous = i;
    items.push(input.items[i] as LogItem);
  }
  return items;
}

function chainable(island: FeedIsland, items: LogItem[], input: IslandLayoutInput): boolean {
  const r = island.rendered;
  if (!r?.cached || input.refused(r.sha256)) return false;
  // Nothing that aired (or airs) in this boot airs again inside a chain: not A, not B.
  if (items.some((item) => input.locked.has(item.id))) return false;
  return items.every((item, i) => {
    if (!MEDIA_KINDS.includes(item.kind) || !item.assetId) return false;
    const media = input.media.get(item.assetId);
    if (!media || input.reason(media)) return false;
    // The chain airs at its head's time: an item inside it can't keep an anchor of its own.
    return i === 0 || item.timing === 'flow';
  });
}

function sourceOf(item: LogItem, media: FeedMedia) {
  return { itemId: item.id, title: item.title, cueOverrides: item.cueOverrides, media };
}

function buildChain(
  run: { island: FeedIsland; items: LogItem[] }[],
  input: IslandLayoutInput,
): FeedChain | null {
  const steps: (ChainBody | ChainIsland)[] = [];
  const itemIds: string[] = [];
  const transitions = new Map<string, AsRunTransition>();
  const fileIds = new Set<string>();
  const mediaOf = (item: LogItem) => input.media.get(item.assetId as string) as FeedMedia;
  /** Where the next body starts: the previous island's tail join (null: its own cue-in). */
  let from: number | null = null;
  for (const [i, { island, items }] of run.entries()) {
    const { head, tail } = island.plan;
    const headItem = items[0] as LogItem;
    const tailItem = items.at(-1) as LogItem;
    if (i === 0) itemIds.push(headItem.id);
    for (const item of items.slice(1)) itemIds.push(item.id);
    for (const item of items) fileIds.add(mediaOf(item).fileId);
    if (head.hasBody) {
      const source = sourceOf(headItem, mediaOf(headItem));
      steps.push({ kind: 'body', source, from, to: head.joinSample });
    }
    const engineId = islandEngineId(island.hash);
    const tailMedia = mediaOf(tailItem);
    steps.push({
      kind: 'island',
      itemId: engineId,
      sha256: (island.rendered as NonNullable<FeedIsland['rendered']>).sha256,
      lengthSamples: island.plan.spec.lengthSamples,
      // The transition leads into B: listeners see B's title from its start.
      title: tailItem.title ?? tailMedia.title,
      artist: tailMedia.artists.length ? tailMedia.artists.join(', ') : null,
    });
    transitions.set(engineId, {
      rendered: true,
      islandId: island.rendered?.islandId ?? null,
      hash: island.hash,
      segueIds: island.plan.segueIds,
      voices: voicesOf(island, input).map(({ source, assetId, media }) => ({
        assetId,
        title: media?.title ?? null,
        offsetMs: samplesToMs(source.at),
        durationMs: samplesToMs(source.to - source.from),
      })),
    });
    from = tail.hasBody ? tail.joinSample : null;
    // The tail's body, unless the next island starts on that same item (its head body).
    if (tail.hasBody && !run[i + 1]) {
      steps.push({ kind: 'body', source: sourceOf(tailItem, tailMedia), from, to: null });
    }
  }
  const head = run[0]?.items[0] as LogItem;
  // A body left with nothing to play (its cue-in at or past its join) is no part.
  const parts = steps.filter((step) => step.kind === 'island' || chainBodyRange(step) !== null);
  const source: ChainSource = {
    segmentId: itemIds[0] as string,
    steps: parts,
    // The head item's own crossfade in, even when the island covers it whole.
    crossInMs: head.cueOverrides?.crossInMs,
  };
  // The engine wants two parts at least. A chain that would be its island alone (both items
  // under a second outside it) airs as the fallback instead.
  if (parts.length < 2) return null;
  const lengths = chainStepLengthsMs(source);
  return {
    source,
    itemIds,
    parts: parts.map((step, i) => ({
      id: step.kind === 'island' ? step.itemId : step.source.itemId,
      durationMs: lengths[i] ?? 0,
    })),
    transitions,
    fileIds: [...fileIds],
  };
}

/**
 * Whether a voice of the island would air outside its asset's validity. It airs around the
 * transition: from one voice length before the head item's planned end (or now, if later) to one
 * after it, the same margin the generator checks promos with.
 */
function voiceOutOfValidity(
  island: FeedIsland,
  input: IslandLayoutInput,
  index: ReadonlyMap<string, number>,
): boolean {
  const head = input.items[index.get(island.plan.head.itemId) ?? -1];
  if (!head) return false;
  const at = Math.max(
    input.nowMs ?? -Infinity,
    Date.parse(head.plannedStart) + head.plannedDurationMs,
  );
  return voicesOf(island, input).some(({ source, media }) => {
    if (!media?.validity) return false;
    const length = samplesToMs(source.to - source.from);
    return !validThroughout(media.validity, new Date(at - length), new Date(at + length));
  });
}

/** The island's sources that aren't one of its log items: its voices. */
function voicesOf(island: FeedIsland, input: IslandLayoutInput) {
  const items = new Map(input.items.map((i) => [i.id, i]));
  const music = new Set([island.plan.head.assetId, island.plan.tail.assetId]);
  for (const id of island.plan.itemIds) {
    const assetId = items.get(id)?.assetId;
    if (assetId) music.add(assetId);
  }
  return island.plan.spec.sources.flatMap((source) => {
    const assetId = island.plan.files[source.sha256]?.assetId;
    if (!assetId || music.has(assetId)) return [];
    return [{ source, assetId, media: input.islandMedia.get(assetId) }];
  });
}

const samplesToMs = (n: number) => Math.max(0, Math.round((n * 1000) / PLAYOUT_SAMPLE_RATE));
const round6 = (s: number) => Math.round(s * 1e6) / 1e6;

/** Product of a source's envelopes at island sample `at`, in dB (0 = untouched). */
function envelopeDbAt(source: IslandSource | undefined, at: number): number {
  if (!source) return 0;
  const gain = source.envelopes.reduce((g, e) => g * envelopeGainAt(e, at), 1);
  return gain <= 0 ? MAX_DUCK_DB : Math.max(MAX_DUCK_DB, 20 * Math.log10(gain));
}

/**
 * The fallback for an island that can't air: its voices, timed on the segue axis (0 = A's end),
 * each with its own trim and gain, the music ducked to what the presenter shaped where the
 * voice starts (A's envelope before A's end, B's after it).
 */
function fallbackOverlay(
  island: FeedIsland,
  input: IslandLayoutInput,
  missing: Set<string>,
): FeedOverlay | null {
  const { head, tail, files, spec } = island.plan;
  const assetOf = (s: IslandSource) => files[s.sha256]?.assetId;
  const a = spec.sources.find((s) => s.at === 0 && assetOf(s) === head.assetId);
  const b = spec.sources.findLast((s) => assetOf(s) === tail.assetId);
  const aEnd = a ? a.to - a.from : 0;
  const sr = PLAYOUT_SAMPLE_RATE;
  const voices: OverlayVoice[] = [];
  const asRun: AsRunVoice[] = [];
  for (const { source, media } of voicesOf(island, input)) {
    // A voice whose file changed since the derivation can't be laid over; one not on the
    // engine's disk yet is fetched for next time.
    if (!media || media.sha256 !== source.sha256) continue;
    if (input.reason(media)) {
      missing.add(media.fileId);
      continue;
    }
    const trimmed = source.from > 0;
    const duck = envelopeDbAt(source.at < aEnd ? a : b, source.at);
    const voice: OverlayVoice = {
      uri: playoutPath({ sha256: media.sha256, ext: media.ext }, input.engineRoot),
      start: round6((source.at - aEnd) / sr),
      duration: round6((source.to - source.from) / sr),
      // Half-sample bias, like every cue point (spike #12).
      cueOut: round6((source.to + (trimmed ? -0.5 : 0.5)) / sr),
    };
    if (trimmed) voice.cueIn = round6((source.from - 0.5) / sr);
    const gain = Math.min(24, Math.max(-60, source.gainDb));
    if (gain !== 0) voice.amplifyDb = gain;
    if (duck < NO_DUCK_DB) voice.duckDb = Math.round(duck * 100) / 100;
    voices.push(voice);
    asRun.push({
      assetId: media.assetId,
      title: media.title,
      offsetMs: 0,
      durationMs: samplesToMs(source.to - source.from),
    });
  }
  if (!voices.length) return null;
  return {
    voices,
    transition: {
      rendered: false,
      islandId: island.rendered?.islandId ?? null,
      hash: island.hash,
      segueIds: island.plan.segueIds,
      voices: asRun,
    },
  };
}
