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
// 1. Trailing songs that overrun by more than the last one can be cut are dropped.
// 2. If what's left still can't be absorbed, the last song is re-picked, in its own slot's
//    category and under the rules, among the songs whose length lets the tail end on time.
// 3. The last song is shortened when the run still overruns (a cut-off with a fade: the feeder
//    plays an item to its log slot, ADR 0031), down to `minSongMs`.
// 4. A fill item (a bed from the clock's `fill` slot, else a jingle) takes the remaining seconds.
//    It is picked longer than its slot when possible (`fillHeadroomMs`): the feeder stretches or
//    trims it at runtime, re-planning from the as-run (ADR 0003 "re-plan the tail").
// The fill is planned at least `minFillMs` long when a fill source exists, cutting the song a
// little more if needed, so the feeder always has a flexible item right before the anchor.
//
// Kept items, segments and items other than songs and fills are never touched: only the
// generator's own trailing songs and fills are. Every `hard` and `soft` anchor is back-timed,
// clock markers included (`isBackTimed` says why).

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
}

/**
 * Whether an anchor's run is back-timed: `hard` and `soft` anchors, shows and clock markers
 * alike. A soft marker must be too: at runtime the music after a soft anchor flows on from
 * wherever the music before it ended (the feeder only drops what would start after it), so an
 * hour that ends early makes every following hour early, up to the next hard start, by more
 * than its fill can stretch. Back-timing every hour keeps that drift to the runtime's own.
 * `not_before` anchors wait for their time: nothing to back-time.
 */
export function isBackTimed(anchor: PlannedItem): boolean {
  return anchor.anchorAt !== null && (anchor.timing === 'hard' || anchor.timing === 'soft');
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
  // The run's clock, else the anchor's (a marker right after a show has an empty run).
  const fill = fillSourceFor(snapshot, [...run, anchor]);

  // The editable tail: trailing new songs and fills (a kept item or a segment ends it).
  const editable = (item: PlannedItem | undefined) =>
    !!item && item.keptId === null && item.segmentId === null;
  /** Where the run starts: its first item, or where the item before it ends. */
  const runStart = (context.run[0]?.start ?? context.runEndsAt).getTime();
  const endOf = () => {
    const last = run.at(-1);
    return last ? last.start.getTime() + last.plannedDurationMs : runStart;
  };
  const cutOf = (item: PlannedItem) =>
    item.kind === 'song' && editable(item)
      ? Math.max(0, Math.min(o.maxSongCutMs, item.plannedDurationMs - o.minSongMs))
      : 0;
  /** The fill wanted for a gap, 0 without a fill source. */
  const fillFor = (gap: number) => (fill ? Math.max(gap, o.minFillMs) : 0);
  /** Whether a gap is absorbed by cutting `last` and planning a fill. */
  const absorbed = (gap: number, last: PlannedItem) => {
    const fillMs = fillFor(gap);
    if (fill && fillMs > fill.maxMs) return false;
    return fillMs - gap <= cutOf(last) && (fill !== null || gap <= o.toleranceMs);
  };
  /** Steps 1–3 on the editable tail; returns the gap left for the fill. */
  function reshapeTail(): number {
    // Fills the clock already planned (elastic `fill` slots) after the last kept item or segment
    // go: one fill, sized here, takes their place at the end. What followed them moves up.
    let fixedUntil = run.length;
    while (fixedUntil > 0 && editable(run[fixedUntil - 1])) fixedUntil--;
    for (let i = run.length - 1; i >= Math.max(fixedUntil, 1); i--) {
      if ((run[i] as PlannedItem).kind !== 'fill') continue;
      run.splice(i, 1);
      for (let j = i; j < run.length; j++) {
        const prev = run[j - 1] as PlannedItem;
        const at = new Date(prev.start.getTime() + prev.plannedDurationMs);
        run[j] = { ...(run[j] as PlannedItem), start: at };
      }
    }

    // 1. Drop trailing songs the anchor cuts into by more than they can give.
    let gap = target - endOf();
    // The run's only song goes too when a fill can take its place.
    while (run.length > 0) {
      const last = run.at(-1) as PlannedItem;
      if (last.kind !== 'song' || !editable(last) || gap >= -cutOf(last)) break;
      if (run.length === 1 && !(fill && gap + last.plannedDurationMs <= fill.maxMs)) break;
      run.pop();
      gap = target - endOf();
    }
    const last = run.at(-1);
    if (!last) return gap;
    /** The last song of the tail: its slot's category gives the songs added below. */
    const lastSong = run.findLast((i, n) => n >= fixedUntil && i.kind === 'song');

    // 2. Re-pick the last song so the tail can end on time; when even that leaves more than a
    //    fill can take, add a song from the same category (twice at most).
    const categoryId = lastSong ? slotCategory(snapshot, lastSong.origin) : null;
    if (categoryId && last === lastSong && !absorbed(gap, last)) {
      const before = last.start.getTime();
      const picked = tools.pick({
        categoryId,
        at: last.start,
        accept: (asset) => {
          const length = itemLengthMs(asset);
          return absorbed(target - (before + length), { ...last, plannedDurationMs: length });
        },
      });
      if (picked) {
        run[run.length - 1] = {
          ...last,
          assetId: picked.asset.id,
          plannedDurationMs: itemLengthMs(picked.asset),
          relaxedRules: picked.relaxedRules,
        };
        gap = target - endOf();
      }
    }
    for (
      let added = 0;
      categoryId && added < 2 && !absorbed(gap, run.at(-1) as PlannedItem);
      added++
    ) {
      const from = endOf();
      const song = (accept: (length: number) => boolean) =>
        tools.pick({ categoryId, at: new Date(from), accept: (a) => accept(itemLengthMs(a)) });
      const fits = (length: number) => target - (from + length);
      const picked =
        song((ms) => absorbed(fits(ms), { ...(lastSong as PlannedItem), plannedDurationMs: ms })) ??
        song((ms) => fits(ms) >= o.minFillMs);
      if (!picked) break;
      run.push({
        ...(lastSong as PlannedItem),
        assetId: picked.asset.id,
        plannedDurationMs: itemLengthMs(picked.asset),
        relaxedRules: picked.relaxedRules,
        start: new Date(from),
      });
      gap = target - endOf();
    }

    // 3. Shorten the last song: the overrun, plus what the fill's minimum length needs.
    const tail = run.at(-1) as PlannedItem;
    const cut = Math.min(cutOf(tail), Math.max(0, fillFor(gap) - gap, -gap));
    if (cut > 0) {
      run[run.length - 1] = { ...tail, plannedDurationMs: tail.plannedDurationMs - cut };
      gap += cut;
    }
    return gap;
  }

  let gap = target - endOf();
  // Only a fill can go after a kept item, a segment, or nothing (steps 1–3 need a song).
  if (editable(run.at(-1))) gap = reshapeTail();

  // 4. A fill for the rest.
  if (fill && gap > o.toleranceMs) {
    const at = new Date(endOf());
    const pick = (accept: (length: number) => boolean) =>
      tools.pick({
        categoryId: fill.categoryId,
        at,
        accept: (asset: GeneratorAsset) => accept(itemLengthMs(asset)),
      });
    // A bed: long enough to stretch at runtime, else long enough, else the longest there is.
    // A jingle: the longest that fits, within a few seconds of the gap if possible.
    const picked = fill.sized
      ? (pick((ms) => ms >= gap + o.fillHeadroomMs) ??
        pick((ms) => ms >= gap) ??
        pick((ms) => ms >= fill.maxMs))
      : (pick((ms) => ms <= gap && ms >= gap - o.minFillMs) ?? pick((ms) => ms <= gap));
    if (picked) {
      const length = itemLengthMs(picked.asset);
      run.push({
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
        start: at,
      });
    }
  }
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
      };
    }
    return null;
  }
  return null;
}
