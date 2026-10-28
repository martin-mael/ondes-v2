import { type LogItemKind, type LogItemTiming, markerTargetOf } from '@ondes/shared';

// Fixed-time markers (#52, ADR 0036). Pure.
//
// A marker is a zero-length log item (`kind: 'marker'`) with an anchored timing: a clock's
// marker slot (top of the hour, "news at :30") or one added on the log timeline. It times the
// item right after it, the marker's item, which is what airs at the marker's time:
// - `hard`: the marker's item starts at T; whatever is on air fades out under it (the engine
//   cut, `POST /v1/schedule`, #46).
// - `soft`: the item on air ends first, then the marker's item starts, at most `capMs` after
//   T; the queued items that would start after T are skipped. Past the cap, the engine cuts
//   the item on air at `T + cap`.
// - `not_before`: the marker's item never starts before T. The music before it stretches
//   toward T; what it can't cover waits (the safety source). It is never cut and never
//   skips anything: late is fine.
//
// The feeder's planner (#29, #46) already enforces these timings on the item that carries
// them. `resolveMarkers` hands each marker's timing to its item, so a marker gets the same
// machinery as a show start: the re-plan of the tail, the engine-timed cut, the soft cap's
// backstop. The log keeps the marker as its own item (what the timeline shows and edits,
// what regeneration keeps); this is only the feeder's view of it. Which item a marker times is
// `markerTargetOf` (@ondes/shared), the rule the log timeline shows too.

/** What `resolveMarkers` needs of a log entry. */
export interface MarkerEntry {
  id: string;
  kind: LogItemKind;
  timing: LogItemTiming;
  anchorAtMs: number | null;
  capMs: number | null;
  /** Truthy when the entry won't be pushed (not cached, unresolvable…): passed over. */
  unplayable?: unknown;
}

/** An entry a marker times: `markerId` is the marker's id. */
export type MarkedEntry<T extends MarkerEntry> = T & { markerId?: string };

/**
 * The entries with each anchored marker's timing moved onto its item: the first entry after
 * it that the feeder pushes, passing over unplayable ones (the planner skips them anyway).
 * The marker becomes `flow` (a point with nothing to do). A marker keeps its own timing, as a
 * plain timing point, when there is no such item before:
 * - another marker or a live slot (nothing to push at T: the planner holds there as before);
 * - an item anchored itself (a show starting at the marker's time keeps its own policy);
 * - the end of the entries.
 * Returns the same array when nothing changes; changed entries are copies.
 */
export function resolveMarkers<T extends MarkerEntry>(entries: readonly T[]): MarkedEntry<T>[] {
  let out: MarkedEntry<T>[] | null = null;
  for (let i = 0; i < entries.length; i++) {
    const marker = entries[i] as T;
    if (marker.kind !== 'marker' || marker.timing === 'flow' || marker.anchorAtMs === null) {
      continue;
    }
    const found = markerTargetOf(entries, i, (e) => !!e.unplayable);
    if (!('index' in found)) continue;
    const j = found.index;
    out ??= [...entries];
    const target = entries[j] as T;
    out[i] = { ...marker, timing: 'flow', anchorAtMs: null, capMs: null };
    out[j] = {
      ...target,
      timing: marker.timing,
      anchorAtMs: marker.anchorAtMs,
      capMs: marker.timing === 'soft' ? marker.capMs : null,
      markerId: marker.id,
    };
  }
  return out ?? (entries as MarkedEntry<T>[]);
}
