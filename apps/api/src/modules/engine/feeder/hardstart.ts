import {
  type EnginePushItem,
  type EngineSchedule,
  LOG_TRANSITION_MS,
  type LogItemKind,
} from '@ondes/shared';

// Hard-start correction (#46, ADR 0031, after ADR 0003 "re-plan the tail"). Pure.
//
// Back-timing plans the music before a hard start to end on time: songs, maybe the last one
// shortened, then a fill (a bed) sized to the gap, both shorter in the log than their media.
// At runtime the music arrives early or late (a skip, a late push, durations a frame off per
// transition), and the feeder re-plans the tail on every sync from what is on air:
// - `slotFit`: a flexible item (song, bed, fill) plays to its log slot, not to its media's end:
//   it is cut, with a fade, by what the log took off it. It may play that much longer again.
// - `stretchTail`: when the queue would end before the anchor, the flexible entries queued
//   since the previous anchor give back their cut, the last one first, so the music reaches
//   the anchor. Running late is the planner's `absorb` (drop, then trim), as before.
// Whatever is left is the engine-timed cut's (`POST /v1/schedule`, `hard` items) or, for a
// `soft` item, waits for the item on air.

/** Kinds whose end the log may cut (and the feeder trim or stretch). */
export const FLEXIBLE_KINDS: readonly LogItemKind[] = ['song', 'bed', 'fill'];

/** Below this, a log slot shorter than the media is rounding, not a planned cut. */
export const SLOT_CUT_TOLERANCE_MS = 250;

/**
 * How a flexible item's media fits its log slot: `cutMs` is how much of its end to cut so it
 * lasts its slot, `stretchMs` how much longer than its slot it may play (the same cut, given
 * back). A slot the media can't fill is no cut: the item plays whole.
 *
 * The slot model is ADR 0003's: `slot = playable − overlap into the next item + one frame`.
 */
export function slotFit(
  kind: LogItemKind,
  slotMs: number,
  playMs: number | null,
  crossOutMs: number | undefined,
): { cutMs: number; stretchMs: number } {
  if (!FLEXIBLE_KINDS.includes(kind) || playMs === null) return { cutMs: 0, stretchMs: 0 };
  const natural = playMs - Math.min(crossOutMs ?? 0, playMs) + LOG_TRANSITION_MS;
  const cutMs = natural - slotMs > SLOT_CUT_TOLERANCE_MS ? natural - slotMs : 0;
  return { cutMs, stretchMs: cutMs };
}

/** A queued entry as `stretchTail` sees it: its predicted start and its trim (negative = longer). */
export type StretchableEntry = {
  startMs: number;
  trimMs: number;
  entry: { stretchMs?: number | undefined };
};

/**
 * Lengthens the entries of `wanted` from index `from` on (the tail since the previous anchor)
 * by up to `gapMs`, the last one first, by lowering their trim down to `−stretchMs`. Later
 * entries move later by as much. Returns how much was added.
 */
export function stretchTail(wanted: StretchableEntry[], from: number, gapMs: number): number {
  let added = 0;
  for (let j = wanted.length - 1; j >= from && added < gapMs; j--) {
    const w = wanted[j] as StretchableEntry;
    const room = Math.max(0, (w.entry.stretchMs ?? 0) + w.trimMs);
    const add = Math.min(room, gapMs - added);
    if (add <= 0) continue;
    w.trimMs -= add;
    for (let k = j + 1; k < wanted.length; k++) (wanted[k] as StretchableEntry).startMs += add;
    added += add;
  }
  return added;
}

// --- Engine-timed cut ------------------------------------------------------------------

/** `POST /v1/schedule` body for a hard item, from the queue push it would have had. */
export function scheduleBody(
  push: EnginePushItem,
  atMs: number,
  fadeOutSeconds: number,
): EngineSchedule {
  const body: EngineSchedule = { item_id: push.item_id, uri: push.uri, at: atMs / 1000 };
  if (push.cue_in !== undefined) body.cue_in = push.cue_in;
  if (push.cue_out !== undefined) body.cue_out = push.cue_out;
  if (push.fade_in !== undefined) body.fade_in = push.fade_in;
  if (push.amplify_db !== undefined) body.amplify_db = push.amplify_db;
  if (push.title !== undefined) body.title = push.title;
  if (push.artist !== undefined) body.artist = push.artist;
  body.fade_out = fadeOutSeconds;
  return body;
}

/** Don't replace a schedule this close to its time: the gate could open on an empty slot. */
export const SCHEDULE_FREEZE_MS = 5_000;

/**
 * What to do with the engine's schedule:
 * - `schedule`: the plan's hard item isn't the one the engine holds (another item, another
 *   time, another body), or this feeder doesn't know what it sent;
 * - `unschedule`: the engine holds an item the log no longer starts hard;
 * - `none`: it's right, or too close to its time to touch.
 */
export function scheduleAction(input: {
  nowMs: number;
  /** What the engine holds (`GET /v1/state` `scheduled`). */
  engine: { itemId: string; atMs: number } | null;
  /** What the plan wants scheduled, with its body's fingerprint. */
  wanted: { itemId: string; atMs: number; fingerprint: string } | null;
  /** The fingerprint this feeder last scheduled in this boot, if any. */
  sent: string | null;
  /** Whether the item the engine holds is still a hard item of the log. */
  stillHard: boolean;
}): 'schedule' | 'unschedule' | 'none' {
  const { engine, wanted } = input;
  if (wanted) {
    const same =
      engine?.itemId === wanted.itemId &&
      Math.abs(engine.atMs - wanted.atMs) < 1 &&
      (input.sent === null || input.sent === wanted.fingerprint);
    if (same && input.sent !== null) return 'none';
    // Close to its time, the engine's copy of the same item stays.
    if (same && wanted.atMs - input.nowMs < SCHEDULE_FREEZE_MS) return 'none';
    return 'schedule';
  }
  if (engine && !input.stillHard) return 'unschedule';
  return 'none';
}
