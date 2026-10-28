import type { ClockSlot, LogItemOrigin } from '@ondes/shared';
import { itemLengthMs } from '../generator/generate.ts';
import type {
  AnchorContext,
  GeneratorAsset,
  GeneratorExtensions,
  GeneratorSnapshot,
  PlannedItem,
} from '../generator/types.ts';

// Back-timing (#46, ADR 0031, after ADR 0003): the music before a hard start ends on time.
//
// The generator calls `beforeAnchor` at every anchored item with the run planned since the
// previous one (ADR 0026). Its picks fill clock slots in order and stop at the anchor, so the
// run ends up to about half a song early or late. Back-timing re-plans the end of the run:
// 1. Elastic fills the clock planned in the tail are taken out (one sized fill replaces them).
// 2. The tail's songs that overrun by more than the last one can be cut are dropped, from the
//    last one back: a VT or a jingle after them stays.
// 3. If what's left still can't be absorbed, the last song is re-picked, in its own slot's
//    category and under the rules, among the songs whose length lets the tail end on time;
//    up to two songs are added when the gap is longer than a fill.
// 4. The last song is shortened when the run still overruns (a cut-off with a fade: the feeder
//    plays an item to its log slot, ADR 0031), down to `minSongMs`.
// 5. A fill takes the remaining seconds: a bed from the clock's `fill` slot, sized to the gap
//    and picked longer than it when possible (`fillHeadroomMs`), so the feeder can stretch or
//    trim it at runtime (ADR 0003 "re-plan the tail"); else a whole jingle, the one that fits
//    best (a little longer, with the song cut to make room, or the longest that fits).
// The fill is planned at least `minFillMs` long when a fill source exists, cutting the song a
// little more if needed, so the feeder always has a flexible item right before the anchor.
// Dropped and replaced picks leave the rules' history (`AnchorTools.release`).
//
// Kept items and segments are never touched; VTs and jingles of the tail stay, only moving
// up when a song before them changes. Every `hard` and `soft` anchor is back-timed, clock
// markers included, and `not_before` markers (`isBackTimed` says why). A `not_before` marker
// only fills up to its anchor: it never cuts anything (ADR 0036), so a run that already ends
// at or after it is left as it is, and nothing is dropped or shortened (steps 2 and 4).

export interface BackTimingOptions {
  /** Below this, a residual is left to the feeder (re-plan, engine cut). */
  toleranceMs: number;
  /** Most of a song's end the plan may cut. */
  maxSongCutMs: number;
  /** A shortened song keeps at least this much. */
  minSongMs: number;
  /** Shortest fill planned. */
  minFillMs: number;
  /** How much longer than its slot a fill should be, for the feeder to stretch it. */
  fillHeadroomMs: number;
}

export const DEFAULT_BACK_TIMING: BackTimingOptions = {
  toleranceMs: 20,
  maxSongCutMs: 45_000,
  minSongMs: 90_000,
  minFillMs: 8_000,
  fillHeadroomMs: 15_000,
};

/**
 * Where an anchor's fill comes from: a category and the clock slot it stands for. A `fill`
 * slot's beds are sized to the gap (cut with a fade); a `jingle` plays whole, so only one that
 * fits is taken.
 */
interface FillSource {
  categoryId: string;
  origin: LogItemOrigin;
  sized: boolean;
  /** The longest member's log length. */
  maxMs: number;
  /** Every member's log length. */
  lengths: number[];
}

/**
 * Whether an anchor's run is back-timed: `hard` and `soft` anchors, shows and clock markers
 * alike. A soft marker must be too: at runtime the music after a soft anchor flows on from
 * wherever the music before it ended (the feeder only drops what would start after it), so an
 * hour that ends early makes every following hour early, up to the next hard start, by more
 * than its fill can stretch. Back-timing every hour keeps that drift to the runtime's own.
 * A `not_before` marker too (#52, ADR 0036): its item never starts early, so music that ends
 * early leaves a wait; back-timed, the run ends at T. Other `not_before` items (a flow item
 * after a hole, ADR 0026) wait on purpose: nothing to back-time.
 */
export function isBackTimed(anchor: PlannedItem): boolean {
  if (anchor.anchorAt === null) return false;
  if (anchor.timing === 'not_before') return anchor.kind === 'marker';
  return anchor.timing === 'hard' || anchor.timing === 'soft';
}

/** The generator extension: `generateDay(snapshot, date, { extensions: backTiming(snapshot) })`. */
export function backTiming(
  snapshot: GeneratorSnapshot,
  options: Partial<BackTimingOptions> = {},
): GeneratorExtensions {
  const o = { ...DEFAULT_BACK_TIMING, ...options };
  return { beforeAnchor: (context) => backTimeRun(snapshot, context, o) };
}

/** The run to plan before `context.anchor`. */
export function backTimeRun(
  snapshot: GeneratorSnapshot,
  context: AnchorContext,
  o: BackTimingOptions = DEFAULT_BACK_TIMING,
): PlannedItem[] {
  const { anchor, tools } = context;
  const run = [...context.run];
  if (!isBackTimed(anchor)) return run;
  const target = (anchor.anchorAt as Date).getTime();
  // Not before: late is fine, so only a run that ends early is planned up to the anchor.
  const fillOnly = anchor.timing === 'not_before';
  if (fillOnly && target - context.runEndsAt.getTime() <= o.toleranceMs) return run;
  // The run's clock, else the anchor's (a marker right after a show has an empty run).
  const fill = fillSourceFor(snapshot, [...run, anchor]);

  // The editable tail: the generator's own items after the last kept item or segment part.
  const editable = (item: PlannedItem | undefined) =>
    !!item && item.keptId === null && item.segmentId === null;
  let from = run.length;
  while (from > 0 && editable(run[from - 1])) from--;

  /** Where the run starts: its first item, or where the item before it ends. */
  const runStart = (context.run[0]?.start ?? context.runEndsAt).getTime();
  const endOf = (i = run.length - 1) => {
    const item = run[i];
    return item ? item.start.getTime() + item.plannedDurationMs : runStart;
  };
  // Each item's pick is in the rules' history at the start it was picked for.
  const pickedAt = new Map<PlannedItem, Date>(run.map((item) => [item, item.start]));
  const release = (item: PlannedItem) =>
    tools.release({ ...item, start: pickedAt.get(item) ?? item.start });
  const replace = (i: number, item: PlannedItem) => {
    pickedAt.set(item, pickedAt.get(run[i] as PlannedItem) ?? item.start);
    run[i] = item;
  };
  /** Items from `i` on follow each other again (after a removal or a length change). */
  const reflow = (i: number) => {
    for (let j = i; j < run.length; j++) {
      replace(j, { ...(run[j] as PlannedItem), start: new Date(endOf(j - 1)) });
    }
  };

  const cutOf = (item: PlannedItem | undefined) =>
    !fillOnly && item?.kind === 'song' && editable(item)
      ? Math.max(0, Math.min(o.maxSongCutMs, item.plannedDurationMs - o.minSongMs))
      : 0;
  /** The fill wanted for a gap, 0 without a fill source. */
  const fillFor = (gap: number) => (fill ? Math.max(gap, o.minFillMs) : 0);
  /** Whether a gap is absorbed by cutting `song` and planning a fill. */
  const absorbed = (gap: number, song: PlannedItem | undefined) => {
    const fillMs = fillFor(gap);
    if (fill && fillMs > fill.maxMs) return false;
    return fillMs - gap <= cutOf(song) && (fill !== null || gap <= o.toleranceMs);
  };
  /** The tail's last song: what is re-picked, cut or dropped, even before a VT or a jingle. */
  const songIndex = () => {
    for (let i = run.length - 1; i >= from; i--) if (run[i]?.kind === 'song') return i;
    return -1;
  };

  // 1. Fills the clock already planned (elastic `fill` slots) go: one fill, sized here, takes
  //    their place at the end. What followed them moves up.
  for (let i = run.length - 1; fill && i >= from; i--) {
    if ((run[i] as PlannedItem).kind !== 'fill') continue;
    release(run[i] as PlannedItem);
    run.splice(i, 1);
    reflow(i);
  }
  let gap = target - endOf();

  // 2. Drop songs the anchor cuts into by more than they can give, from the last one back
  //    (a VT or a jingle after them stays). The run's only song goes too when a fill can take
  //    its place.
  for (let si = songIndex(); si >= 0 && gap < -cutOf(run[si]); si = songIndex()) {
    const song = run[si] as PlannedItem;
    const songs = run.filter((item, n) => n >= from && item.kind === 'song').length;
    if (songs === 1 && !(fill && gap + song.plannedDurationMs <= fill.maxMs)) break;
    release(song);
    run.splice(si, 1);
    reflow(si);
    gap = target - endOf();
  }

  // 3. Re-pick the last song so the tail can end on time; when even that leaves more than a
  //    fill can take, add songs from its category (twice at most).
  let si = songIndex();
  const categoryId = si >= 0 ? slotCategory(snapshot, (run[si] as PlannedItem).origin) : null;
  if (categoryId && !absorbed(gap, run[si])) {
    const song = run[si] as PlannedItem;
    const picked = tools.pick({
      categoryId,
      at: song.start,
      accept: (asset) => {
        const length = itemLengthMs(asset);
        const g = gap + song.plannedDurationMs - length;
        return absorbed(g, { ...song, plannedDurationMs: length });
      },
    });
    if (picked) {
      release(song);
      const next = {
        ...song,
        assetId: picked.asset.id,
        plannedDurationMs: itemLengthMs(picked.asset),
        relaxedRules: picked.relaxedRules,
      };
      run[si] = next;
      pickedAt.set(next, song.start);
      reflow(si + 1);
      gap = target - endOf();
    }
  }
  const template = si >= 0 ? (run[si] as PlannedItem) : null;
  for (let added = 0; categoryId && template && added < 2; added++) {
    if (absorbed(gap, run[songIndex()])) break;
    const at = new Date(endOf());
    const fits = (length: number) => target - (at.getTime() + length);
    const song = (accept: (length: number) => boolean) =>
      tools.pick({ categoryId, at, accept: (a) => accept(itemLengthMs(a)) });
    const picked =
      song((ms) => absorbed(fits(ms), { ...template, plannedDurationMs: ms })) ??
      song((ms) => fits(ms) >= o.minFillMs);
    if (!picked) break;
    const next = {
      ...template,
      assetId: picked.asset.id,
      plannedDurationMs: itemLengthMs(picked.asset),
      relaxedRules: picked.relaxedRules,
      start: at,
    };
    run.push(next);
    pickedAt.set(next, at);
    gap = target - endOf();
  }

  // 4. Shorten the last song: the overrun, plus what the fill's minimum length needs.
  si = songIndex();
  const shorten = (ms: number) => {
    const song = run[si] as PlannedItem;
    replace(si, { ...song, plannedDurationMs: song.plannedDurationMs - ms });
    reflow(si + 1);
    gap += ms;
  };
  const cut = Math.min(cutOf(run[si]), Math.max(0, fillFor(gap) - gap, -gap));
  if (cut > 0) shorten(cut);

  // 5. A fill for the rest.
  if (!fill || gap <= o.toleranceMs) return run;
  const at = () => new Date(endOf());
  const pick = (accept: (length: number) => boolean) =>
    tools.pick({
      categoryId: fill.categoryId,
      at: at(),
      accept: (asset: GeneratorAsset) => accept(itemLengthMs(asset)),
    });
  let picked: ReturnType<typeof pick> = null;
  if (fill.sized) {
    // A bed: long enough to stretch at runtime, else long enough, else the longest there is.
    picked =
      pick((ms) => ms >= gap + o.fillHeadroomMs) ??
      pick((ms) => ms >= gap) ??
      pick((ms) => ms >= fill.maxMs);
  } else {
    // A jingle plays whole. Best, one a little longer than the gap with the song cut to make
    // room (the shortest such); else the longest that fits. Lengths are tried in that order.
    const room = cutOf(run[si]) - cut;
    const lengths = [...new Set(fill.lengths)];
    const longer = lengths.filter((l) => l >= gap && l - gap <= room).sort((a, b) => a - b);
    const shorter = lengths.filter((l) => l < gap).sort((a, b) => b - a);
    for (const length of [...longer, ...shorter]) {
      picked = pick((ms) => ms === length);
      if (!picked) continue;
      if (length > gap) shorten(length - gap);
      break;
    }
  }
  if (!picked) return run;
  const length = itemLengthMs(picked.asset);
  const item: PlannedItem = {
    keptId: null,
    kind: fill.sized ? 'fill' : 'jingle',
    plannedDurationMs: fill.sized ? Math.min(gap, length) : length,
    assetId: picked.asset.id,
    episodeId: null,
    liveSlotId: null,
    title: null,
    timing: 'flow',
    anchorAt: null,
    capMs: null,
    origin: fill.origin,
    relaxedRules: picked.relaxedRules,
    segmentId: null,
    crossOutMs: null,
    start: at(),
  };
  run.push(item);
  return run;
}

/** The category of the clock slot an item was picked for. */
function slotCategory(snapshot: GeneratorSnapshot, origin: LogItemOrigin): string | null {
  if (origin.type !== 'clock' || origin.clockId === null) return null;
  const slot = snapshot.clocks.get(origin.clockId)?.slots[origin.slotIndex];
  return slot && 'categoryId' in slot ? (slot.categoryId ?? null) : null;
}

/**
 * The fill for a run: the clock of its last clock item, its first `fill` slot with a category
 * (beds, sized), else its first `jingle` slot (played whole). Null when the clock has neither.
 */
function fillSourceFor(
  snapshot: GeneratorSnapshot,
  run: readonly PlannedItem[],
): FillSource | null {
  for (let i = run.length - 1; i >= 0; i--) {
    const origin = (run[i] as PlannedItem).origin;
    if (origin.type !== 'clock' || origin.clockId === null) continue;
    const clock = snapshot.clocks.get(origin.clockId);
    if (!clock) return null;
    for (const kind of ['fill', 'jingle'] as const) {
      const slotIndex = clock.slots.findIndex((s: ClockSlot) => s.kind === kind);
      const slot = clock.slots[slotIndex];
      const categoryId = slot && 'categoryId' in slot ? slot.categoryId : null;
      const category = categoryId ? snapshot.categories.get(categoryId) : undefined;
      if (!categoryId || !category?.members.length) continue;
      return {
        categoryId,
        origin: { type: 'clock', clockId: clock.id, slotIndex },
        sized: kind === 'fill',
        maxMs: Math.max(...category.members.map((m) => itemLengthMs(m))),
        lengths: category.members.map((m) => itemLengthMs(m)),
      };
    }
    return null;
  }
  return null;
}
