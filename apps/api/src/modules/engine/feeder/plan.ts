import type { EngineSource, LogItemKind, LogItemTiming } from '@ondes/shared';
import { FLEXIBLE_KINDS, stretchTail } from './hardstart.ts';

// Just-in-time planning (ADR 0002 "Just-in-time feeding", ADR 0003 "Feeder"). Pure: given the
// clock, what the engine has on air and the log around now, decide which entries should be
// queued, in order, and how much to trim them; then compare that with the engine's queue.
// The feeder (feeder.ts) runs it on every tick, engine event and log change, so a plan is
// never kept: it is recomputed from the engine state and the log each time.
//
// Timing model: an entry occupies its log slot (`plannedDurationMs`: what it plays minus its
// overlap with the next entry, plus one 20 ms frame, ADR 0003). The predicted start of each
// entry chains from the end of the one on air, so drift (a skip, a late push, a live overrun)
// shows up as a difference between the predicted start and the log's anchors.
//
// Anchors (contracts/log.ts `timing`):
// - `hard`: an overrun is absorbed by the tail before it: drop whole queued entries that fit
//   in the overrun, trim the flexible ones (songs, beds, fills) down to `minKeepMs`. A gap is
//   closed by stretching the tail's flexible entries back toward their media's length
//   (`stretchTail`, #46). With `engineCut`, the item is not queued: it is handed to the engine
//   (`scheduled`, `POST /v1/schedule`), which starts it at its anchor to the frame and fades
//   out whatever is on air; the tail aims `cutOverlapMs` past the anchor so the music never
//   runs dry before it. Without it, a gap bigger than `holdGapMs` holds the item until its
//   anchor and what the tail can't absorb is reported in `late`.
// - `soft`: entries that would start at or after the anchor are dropped; so is the last one
//   past `anchor + cap` is cut, else dropped (`absorb`). A gap is stretched like a hard one's,
//   aiming `cutOverlapMs` past the anchor, and one bigger than `holdGapMs` holds the item until
//   its anchor: a soft item starts when the music ends, not early. When the item on air itself
//   runs past the cap, the engine cuts it there (`scheduled` at `anchor + cap`, with
//   `engineCut`); without it, that is reported in `late`.
// - `not_before`: held until its anchor when it would start more than `holdGapMs` early.
// - `live_slot`: nothing to push; the entries after it are held until the slot's end.
// - `marker`: a timing point only (its anchor applies), nothing to push.

export type SkipReason = 'not_cached' | 'unresolvable' | 'no_media_file';

/** A top-level log item, as the planner sees it. */
export type FeedEntry = {
  /** Log item id; for a segment, the segment item's id (the engine's `segment_id`). */
  id: string;
  kind: LogItemKind;
  plannedStartMs: number;
  /** The log slot: `plannedDurationMs`. */
  slotMs: number;
  timing: LogItemTiming;
  anchorAtMs: number | null;
  capMs: number | null;
  /** Segment parts in play order, with their raw lengths. Empty for other kinds. */
  parts: { id: string; durationMs: number }[];
  /** Why it can't be pushed; null when it can (or has nothing to push: marker, live slot). */
  unplayable: SkipReason | null;
  /** How much its end may be cut by a hard-start re-plan, in ms. 0 = not flexible. */
  flexMs: number;
  /** How much longer than its slot it may play (the cut back-timing planned), in ms. */
  stretchMs?: number;
};

/** What the engine has on air (`GET /v1/state` `on_air`). */
export type OnAir = {
  itemId: string | null;
  segmentId: string | null;
  source: EngineSource;
  /** Time since it went on air. */
  elapsedMs: number;
  /** Trim the feeder pushed it with, when known. */
  trimMs?: number;
};

export type PlanOptions = {
  /** Keep at least this many entries queued... */
  minItems: number;
  /** ...and at least this much audio queued past the item on air. */
  minAheadMs: number;
  /** Never queue more than this many entries. */
  maxItems: number;
  /** How far ahead anchors are looked for (they can trim entries already queued). */
  lookaheadMs: number;
  /** Nothing of the log on air: an entry planned less than this ago still starts (late). */
  joinLateMs: number;
  /** A gap before a hard or not-before item bigger than this holds the item. */
  holdGapMs: number;
  /** A held item is pushed this long before its anchor (push + takeover latency). */
  pushLeadMs: number;
  /** Error below which an anchor counts as met: one engine frame. */
  toleranceMs: number;
  /** The engine starts `hard` items itself (`POST /v1/schedule`, #46). */
  engineCut: boolean;
  /**
   * How far past a `hard` anchor the tail aims when the engine cuts (faded out under the item),
   * and past a `soft` one always (its item waits for the end: never early).
   */
  cutOverlapMs: number;
};

export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  minItems: 2,
  minAheadMs: 10 * 60_000,
  maxItems: 8,
  lookaheadMs: 45 * 60_000,
  joinLateMs: 60_000,
  holdGapMs: 5_000,
  pushLeadMs: 500,
  toleranceMs: 20,
  engineCut: false,
  cutOverlapMs: 500,
};

export type PlanInput = {
  nowMs: number;
  onAir: OnAir | null;
  /** Top-level items of published days around now, in play order. */
  entries: readonly FeedEntry[];
  /** Log item ids that went on air during this engine boot. */
  aired?: ReadonlySet<string>;
  options?: Partial<PlanOptions>;
};

export type PlannedEntry = {
  entry: FeedEntry;
  /** Predicted start, epoch ms. */
  startMs: number;
  /** How much its end is cut, in ms. */
  trimMs: number;
};

export type FeedPlan = {
  /** Index of the on-air entry in `entries`, or null when the log isn't on air. */
  onAirIndex: number | null;
  /** Where the on-air entry ends (predicted), or null. */
  onAirEndMs: number | null;
  /**
   * The entries to have queued, in play order. The first `need` must be queued now; the
   * others may stay queued if they already are (a queue a bit longer than needed is fine).
   */
  wanted: PlannedEntry[];
  need: number;
  /** Entries passed over before the next anchor: unplayable, or dropped to meet an anchor. */
  skipped: { entry: FeedEntry; reason: SkipReason | 'dropped' }[];
  /** The next entry waits for its anchor (not pushed before `untilMs`). */
  hold: { itemId: string; untilMs: number } | null;
  /** Anchors the plan can't meet by re-planning alone, and by how much. */
  late: { itemId: string; ms: number }[];
  /**
   * With `engineCut`: the `hard` item the engine should start at `atMs` (never queued). The
   * plan stops there: nothing after it is queued before it airs.
   */
  scheduled: { entry: FeedEntry; atMs: number } | null;
};

/** Kinds the planner pushes. */
const PUSHED: readonly LogItemKind[] = [
  'song',
  'vt',
  'jingle',
  'bed',
  'episode',
  'fill',
  'segment',
];

/** Whether a kind's end may be trimmed by a hard-start re-plan. */
export const isFlexibleKind = (kind: LogItemKind) => FLEXIBLE_KINDS.includes(kind);

export function planFeed(input: PlanInput): FeedPlan {
  const o = { ...DEFAULT_PLAN_OPTIONS, ...input.options };
  const { nowMs, entries } = input;
  const aired = input.aired ?? new Set<string>();
  const wanted: PlannedEntry[] = [];
  const skipped: FeedPlan['skipped'] = [];
  const late: FeedPlan['late'] = [];
  let hold: FeedPlan['hold'] = null;
  let scheduled: FeedPlan['scheduled'] = null;
  /** Index in `wanted` where the tail since the last anchored entry starts. */
  let tailFrom = 0;

  const onAirIndex = locateOnAir(entries, input.onAir);
  /** Floor set by a live slot (or a long item not joined): what follows waits for its end. */
  let notBefore: number | null = null;
  let t: number;
  let from: number;
  let onAirEndMs: number | null = null;
  if (onAirIndex !== null && input.onAir) {
    const e = entries[onAirIndex] as FeedEntry;
    const startMs = nowMs - input.onAir.elapsedMs - partOffsetMs(e, input.onAir.itemId);
    onAirEndMs = startMs + e.slotMs - (input.onAir.trimMs ?? 0);
    t = onAirEndMs;
    from = onAirIndex + 1;
  } else {
    // The log isn't on air (boot, safety, live, a dry queue): what we push airs right away.
    t = nowMs;
    from = entries.findIndex((e) => e.plannedStartMs >= nowMs - o.joinLateMs && !aired.has(e.id));
    if (from < 0) from = entries.length;
    // The entry planned over `now`, if it started too long ago to join (a live slot, an
    // episode half-way through): what follows waits for its planned end, as it would on air.
    const current = findLastIndex(
      entries,
      (e) =>
        e.kind !== 'marker' && e.plannedStartMs <= nowMs && nowMs < e.plannedStartMs + e.slotMs,
    );
    const c = entries[current];
    if (c && current < from && !aired.has(c.id)) {
      from = current + 1;
      notBefore = c.plannedStartMs + c.slotMs;
    }
  }

  /** Removes `wanted[j]` or cuts its end by `ms`; later entries move earlier by as much. */
  const shorten = (j: number, ms: number, drop: boolean) => {
    const w = wanted[j] as PlannedEntry;
    for (let k = j + 1; k < wanted.length; k++) (wanted[k] as PlannedEntry).startMs -= ms;
    t -= ms;
    if (drop) {
      wanted.splice(j, 1);
      skipped.push({ entry: w.entry, reason: 'dropped' });
    } else {
      w.trimMs += ms;
    }
  };

  /**
   * Absorbs `overrun` ms in the tail since the previous anchor (`tailFrom`), from its end:
   * first whole flexible entries (song, bed, fill) that fit in it, then trims of the flexible
   * ones, and only then whole other entries (a VT, a jingle), so a voice track stays when the
   * music around it can give the time. Returns what's left.
   */
  const absorb = (overrun: number): number => {
    let left = overrun;
    const pass = (test: (w: PlannedEntry) => boolean, trim: boolean) => {
      for (let j = wanted.length - 1; j >= tailFrom && left > o.toleranceMs; j--) {
        const w = wanted[j] as PlannedEntry;
        if (!test(w)) continue;
        const length = w.entry.slotMs - w.trimMs;
        if (!trim && left >= length) {
          shorten(j, length, true);
          left -= length;
          continue;
        }
        const cut = trim ? Math.min(left, Math.max(0, w.entry.flexMs - w.trimMs)) : 0;
        if (cut > 0) {
          shorten(j, cut, false);
          left -= cut;
        }
      }
    };
    const flexible = (w: PlannedEntry) => isFlexibleKind(w.entry.kind);
    pass(flexible, false);
    pass(flexible, true);
    pass((w) => !flexible(w), false);
    return left;
  };

  /** Waits for `anchor` if `t` is more than `holdGapMs` before it. False = hold here. */
  const waitFor = (e: FeedEntry, anchor: number): boolean => {
    if (t >= anchor - o.holdGapMs) return true;
    const untilMs = anchor - o.pushLeadMs;
    if (nowMs < untilMs) {
      hold = { itemId: e.id, untilMs };
      return false;
    }
    // Its time has come and the queue ends before it: it airs as soon as it's pushed.
    t = Math.max(t, nowMs);
    return true;
  };

  for (let i = from; i < entries.length; i++) {
    const e = entries[i] as FeedEntry;
    if (t - nowMs > o.lookaheadMs && wanted.length >= o.minItems) break;
    if (onAirIndex === null && aired.has(e.id)) continue;

    const anchor = e.timing === 'flow' ? null : e.anchorAtMs;
    if (anchor !== null && e.timing === 'hard') {
      // Segments (island chains) can't be scheduled: they keep the re-plan alone.
      const cut = o.engineCut && PUSHED.includes(e.kind) && e.kind !== 'segment' && !e.unplayable;
      const target = anchor + (cut ? o.cutOverlapMs : 0);
      if (t - target > o.toleranceMs) {
        const left = absorb(t - target);
        if (left > o.toleranceMs && !cut) late.push({ itemId: e.id, ms: left });
      } else if (target - t > o.toleranceMs) {
        t += stretchTail(wanted, tailFrom, target - t);
      }
      if (cut) {
        scheduled = { entry: e, atMs: anchor };
        break;
      }
      if (!waitFor(e, anchor)) break;
    } else if (anchor !== null && e.timing === 'soft') {
      // Whatever would start at or after the anchor makes way for this item.
      while (wanted.length > tailFrom && (wanted.at(-1) as PlannedEntry).startMs >= anchor) {
        const last = wanted.at(-1) as PlannedEntry;
        shorten(wanted.length - 1, last.entry.slotMs - last.trimMs, true);
      }
      // At most `capMs` late: the tail is cut (or dropped) down to the cap.
      const cap = anchor + (e.capMs ?? 0);
      const left = t > cap ? absorb(t - cap) : 0;
      if (left > o.toleranceMs) {
        // The item on air itself runs past the cap: the engine cuts it there (#46).
        if (o.engineCut && PUSHED.includes(e.kind) && e.kind !== 'segment' && !e.unplayable) {
          scheduled = { entry: e, atMs: cap };
          break;
        }
        late.push({ itemId: e.id, ms: left });
      }
      // Not early: the tail aims a little past the anchor, the item waits for its end; a gap
      // the tail can't stretch over holds the item until its anchor, like a hard one.
      const aim = anchor + o.cutOverlapMs;
      if (aim - t > o.toleranceMs) t += stretchTail(wanted, tailFrom, aim - t);
      if (!waitFor(e, anchor)) break;
    } else if (anchor !== null && e.timing === 'not_before') {
      if (!waitFor(e, anchor)) break;
    }
    // The tail of the next anchor starts after this one (a marker or a live slot included).
    if (anchor !== null) tailFrom = wanted.length;
    if (notBefore !== null && e.kind !== 'marker') {
      const floor = notBefore;
      notBefore = null;
      if (!waitFor(e, floor)) break;
    }

    if (e.kind === 'live_slot') {
      // Nothing is queued for it: the queue still ends at `t`, what follows waits for its end.
      notBefore = t + e.slotMs;
      continue;
    }
    if (!PUSHED.includes(e.kind)) continue;
    if (e.unplayable) {
      skipped.push({ entry: e, reason: e.unplayable });
      continue;
    }
    wanted.push({ entry: e, startMs: t, trimMs: 0 });
    t += e.slotMs;
    if (e.timing !== 'flow') tailFrom = wanted.length;
  }

  let need = 0;
  while (need < wanted.length && need < o.maxItems) {
    const last = wanted[need - 1];
    const ahead = last ? last.startMs + last.entry.slotMs - last.trimMs - nowMs : 0;
    if (need >= o.minItems && ahead >= o.minAheadMs) break;
    need++;
  }
  return { onAirIndex, onAirEndMs, wanted, need, skipped, hold, late, scheduled };
}

function findLastIndex<T>(list: readonly T[], test: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i] as T)) return i;
  return -1;
}

function locateOnAir(entries: readonly FeedEntry[], onAir: OnAir | null): number | null {
  if (onAir?.source !== 'queue') return null;
  const id = onAir.segmentId ?? onAir.itemId;
  if (!id) return null;
  const index = entries.findIndex((e) => e.id === id);
  return index < 0 ? null : index;
}

/** How far into a segment its on-air part starts. 0 for anything else. */
function partOffsetMs(e: FeedEntry, partId: string | null): number {
  let offset = 0;
  for (const part of e.parts) {
    if (part.id === partId) return offset;
    offset += part.durationMs;
  }
  return 0;
}

// --- Queue diff ------------------------------------------------------------------------

/** One entry of the engine queue (segment parts collapsed), with what the feeder pushed. */
export type QueuedEntry = {
  id: string;
  /** Fingerprint of the body it was pushed with; null when unknown (another replica). */
  fingerprint: string | null;
  trimMs: number;
};

/** A wanted entry with the fingerprint of the body it would be pushed with. */
export type WantedEntry = { id: string; fingerprint: string; trimMs: number };

export type QueueActions = {
  /** Queued entries to remove, from the first that differs from the plan on. */
  remove: string[];
  /** Entries to push, in order, once the removals are done. */
  push: number[];
};

/**
 * What to do to the engine queue: keep the longest prefix that matches the plan, remove the
 * rest, push what's missing up to `need`. A queued entry matches when it is the same item,
 * pushed with the same body, and a trim within `trimToleranceMs` (the prediction jitters by
 * a frame or two; re-pushing for that would churn). `push` holds indexes into `wanted`.
 * The item on air is never in the engine queue, so it is never touched.
 */
export function diffQueue(
  queued: readonly QueuedEntry[],
  wanted: readonly WantedEntry[],
  need: number,
  trimToleranceMs = 250,
): QueueActions {
  let m = 0;
  while (m < queued.length && m < wanted.length) {
    const q = queued[m] as QueuedEntry;
    const w = wanted[m] as WantedEntry;
    if (q.id !== w.id || q.fingerprint !== w.fingerprint) break;
    if (Math.abs(q.trimMs - w.trimMs) > trimToleranceMs) break;
    m++;
  }
  const push: number[] = [];
  for (let i = m; i < need; i++) push.push(i);
  return { remove: queued.slice(m).map((q) => q.id), push };
}
