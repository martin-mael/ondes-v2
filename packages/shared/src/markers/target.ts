import type { LogItemKind, LogItemTiming } from '../contracts/log.ts';

// What a fixed-time marker times (#52, ADR 0036). Pure, shared by the feeder
// (`resolveMarkers` in @ondes/scheduling) and the log timeline, so both name the same item.

/** Kinds a marker can time: the kinds the feeder pushes. */
export const MARKER_TARGET_KINDS: readonly LogItemKind[] = [
  'song',
  'vt',
  'jingle',
  'bed',
  'episode',
  'fill',
  'segment',
];

/**
 * What marker `i` times: `{ index }` of the first entry after it the feeder pushes, passing
 * over the ones `unplayable` says it won't push; or, when it times nothing, why:
 * - `marker` / `live_slot`: another marker or a live slot comes first (nothing to push at T,
 *   the planner holds there);
 * - `anchored`: the next item has its own anchor (a show at the marker's time keeps its policy);
 * - `end`: nothing after it.
 */
export type MarkerTarget =
  | { index: number }
  | { none: 'marker' | 'live_slot' | 'anchored' | 'end' };

export function markerTargetOf<T extends { kind: LogItemKind; timing: LogItemTiming }>(
  entries: readonly T[],
  i: number,
  unplayable: (entry: T) => boolean,
): MarkerTarget {
  for (let j = i + 1; j < entries.length; j++) {
    const e = entries[j] as T;
    if (e.kind === 'marker' || e.kind === 'live_slot') return { none: e.kind };
    if (!MARKER_TARGET_KINDS.includes(e.kind) || unplayable(e)) continue;
    return e.timing === 'flow' ? { index: j } : { none: 'anchored' };
  }
  return { none: 'end' };
}
