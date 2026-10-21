import {
  ASSET_KINDS,
  type AsRunEntry,
  type AssetCues,
  LOG_TRANSITION_MS,
  type LogItem,
  type LogItemKind,
  type LogTimingConflict,
} from '@ondes/shared';
import type { HourSlot } from './time.ts';

// What the timeline derives from the log, the as-run and the clock (#51). Pure, so the rules
// (what is on air, what may still be edited, hour totals) are tested without rendering.

/**
 * How far ahead the feeder keeps the engine's queue (`minAheadMs` in
 * apps/api/src/modules/engine/feeder/plan.ts). Items starting this soon are likely pushed
 * already: an edit still lands, through the feeder's next re-plan.
 */
export const ENGINE_WINDOW_MS = 10 * 60_000;

export const startMs = (item: Pick<LogItem, 'plannedStart'>) => Date.parse(item.plannedStart);
export const endMs = (item: Pick<LogItem, 'plannedStart' | 'plannedDurationMs'>) =>
  startMs(item) + item.plannedDurationMs;

export const isAssetKind = (kind: LogItemKind) => (ASSET_KINDS as readonly string[]).includes(kind);

export interface HourGroup extends HourSlot {
  items: LogItem[];
  /** Sum of the planned durations of the items starting in the hour. */
  contentMs: number;
  /** Timing conflicts on the hour's items (overrun of the items before an anchor, or a gap). */
  overrunMs: number;
  gapMs: number;
  /** Items whose generator relaxed a rule. */
  relaxed: number;
}

/** The log's items in the hours they start in. Items outside the day are dropped. */
export function groupByHour(items: readonly LogItem[], hours: readonly HourSlot[]): HourGroup[] {
  const groups: HourGroup[] = hours.map((h) => ({
    ...h,
    items: [],
    contentMs: 0,
    overrunMs: 0,
    gapMs: 0,
    relaxed: 0,
  }));
  let g = 0;
  for (const item of items) {
    const at = startMs(item);
    while (g < groups.length && at >= (groups[g]?.end ?? 0)) g++;
    const group = groups[g];
    if (!group || at < group.start) continue;
    group.items.push(item);
    group.contentMs += item.plannedDurationMs;
    if (item.conflict) addConflict(group, item.conflict);
    if (item.relaxedRules.length > 0) group.relaxed++;
  }
  return groups;
}

function addConflict(group: HourGroup, conflict: LogTimingConflict) {
  if (conflict.kind === 'overrun') group.overrunMs += conflict.ms;
  else group.gapMs += conflict.ms;
}

export interface OnAir {
  itemId: string;
  /** `asrun`: the engine says so. `plan`: nothing aired from the log, the plan has it now. */
  source: 'asrun' | 'plan';
  entry: AsRunEntry | null;
}

/** The on-air item: the open as-run entry of a log item, else the planned item at `now`. */
export function onAirItem(
  items: readonly LogItem[],
  entries: readonly AsRunEntry[],
  now: number,
): OnAir | null {
  const open = [...entries]
    .filter((e) => e.endedAt === null)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  if (open) {
    // A safety or live entry is on air: no log item is.
    if (!open.logItemId) return null;
    // A part of an island chain: the chain (its segment item) is what the timeline lists.
    const id = open.segmentId ?? open.logItemId;
    return { itemId: id, source: 'asrun', entry: open };
  }
  let planned: LogItem | undefined;
  for (const item of items) {
    if (startMs(item) <= now && now < endMs(item)) planned = item;
  }
  return planned ? { itemId: planned.id, source: 'plan', entry: null } : null;
}

/** The as-run entries by log item (a segment's parts also under their segment, first wins). */
export function asRunByItem(entries: readonly AsRunEntry[]): Map<string, AsRunEntry> {
  const byItem = new Map<string, AsRunEntry>();
  const sorted = [...entries].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  for (const entry of sorted) {
    if (entry.logItemId && !byItem.has(entry.logItemId)) byItem.set(entry.logItemId, entry);
    if (entry.segmentId && !byItem.has(entry.segmentId)) byItem.set(entry.segmentId, entry);
  }
  return byItem;
}

export type ItemState = 'aired' | 'on_air' | 'queued' | 'planned';

/**
 * Where an item stands: `aired` (has an as-run entry, or its planned slot is over), `on_air`,
 * `queued` (starts within the engine window) or `planned`. Aired and on-air items are frozen:
 * the timeline doesn't edit the past.
 */
export function itemState(
  item: LogItem,
  ctx: { now: number; onAirId: string | null; aired: ReadonlyMap<string, AsRunEntry> },
): ItemState {
  if (item.id === ctx.onAirId) return 'on_air';
  if (ctx.aired.has(item.id) || endMs(item) <= ctx.now) return 'aired';
  if (startMs(item) - ctx.now <= ENGINE_WINDOW_MS) return 'queued';
  return 'planned';
}

export const isFrozen = (state: ItemState) => state === 'aired' || state === 'on_air';

export interface ShowBlock {
  /** The show slot, or null for show items the generator didn't tie to a slot. */
  showSlotId: string | null;
  first: boolean;
  last: boolean;
}

/** Runs of consecutive show items (same show slot): rendered as one block. */
export function showBlocks(items: readonly LogItem[]): Map<string, ShowBlock> {
  const blocks = new Map<string, ShowBlock>();
  const slotOf = (item: LogItem | undefined) =>
    item?.origin.type === 'show' ? item.origin.showSlotId : undefined;
  items.forEach((item, i) => {
    const slot = slotOf(item);
    if (slot === undefined) return;
    blocks.set(item.id, {
      showSlotId: slot,
      first: slotOf(items[i - 1]) !== slot,
      last: slotOf(items[i + 1]) !== slot,
    });
  });
  return blocks;
}

/** A position in samples as ms at `sampleRate`. */
const samplesMs = (samples: number, sampleRate: number) => (samples / sampleRate) * 1000;

/**
 * The slot an asset takes in the log (ADR 0003): what it plays up to where the next item
 * starts, plus the engine frame. From the cues when known (cue-in to crossfade start, else to
 * cue-out), else its duration.
 */
export function slotMs(durationMs: number | null, cues: AssetCues | null | undefined): number {
  const sr = cues?.sampleRate;
  const cueIn = cues?.cueIn.samples ?? 0;
  const out = cues?.crossStartNext.samples ?? cues?.cueOut.samples;
  if (sr && out != null && out > cueIn) {
    return Math.round(samplesMs(out - cueIn, sr)) + LOG_TRANSITION_MS;
  }
  return Math.max(0, durationMs ?? 0) + LOG_TRANSITION_MS;
}

/** Where an item's audio starts in its file, in seconds: its cue-in override, else the asset's. */
export function cueInSeconds(
  item: Pick<LogItem, 'cueOverrides'>,
  cues: AssetCues | null | undefined,
): number {
  const o = item.cueOverrides;
  if (o?.cueIn != null && o.sampleRate) return o.cueIn / o.sampleRate;
  if (cues?.cueIn.samples != null) return cues.cueIn.samples / cues.sampleRate;
  return 0;
}

/** How much of the outgoing item a transition preview plays before the switch, in seconds. */
export const PREVIEW_LEAD_S = 8;
/** How much of the incoming item it plays after, in seconds. */
export const PREVIEW_TAIL_S = 8;

export interface TransitionPlan {
  /** Where the outgoing item starts playing, in its file (s). */
  fromS: number;
  /** Where the outgoing item is when the incoming one starts, in its file (s). */
  switchS: number;
  /** Where the incoming item starts, in its file (s). */
  intoS: number;
}

/**
 * The transition from `a` into `b` as planned: `b` starts `a.plannedDurationMs - LOG_TRANSITION_MS`
 * after `a` does, so `a` is at `cueIn + that` in its file when `b` starts at its own cue-in.
 */
export function transitionPlan(
  a: Pick<LogItem, 'cueOverrides' | 'plannedDurationMs'>,
  cuesA: AssetCues | null | undefined,
  b: Pick<LogItem, 'cueOverrides'>,
  cuesB: AssetCues | null | undefined,
): TransitionPlan {
  const aIn = cueInSeconds(a, cuesA);
  const switchS = aIn + Math.max(0, a.plannedDurationMs - LOG_TRANSITION_MS) / 1000;
  return { fromS: Math.max(aIn, switchS - PREVIEW_LEAD_S), switchS, intoS: cueInSeconds(b, cuesB) };
}
