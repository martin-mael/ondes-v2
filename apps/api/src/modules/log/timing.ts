import { LOG_TRANSITION_MS, type LogItemTiming, type LogTimingConflict } from '@ondes/shared';

// Planned starts of a day's items (ADR 0003). Pure: the repository calls it after every edit
// and every bulk write, so `planned_start` always follows from play order, durations and
// anchors.
//
// - `flow` items start where the previous top-level item ends. The day's first item is
//   anchored at local midnight, like a `soft` item (contracts/log.ts).
// - `hard` and `soft` items start at their anchor, whatever comes before. A gap or an overrun
//   is not fixed here (back-timing is #46): it is reported as the item's `conflict`.
// - `not_before` items start at their anchor or after the previous item, whichever is later;
//   waiting for the anchor is reported as a `gap`.
// - A segment lasts its parts' raw lengths, minus its outgoing overlap, plus one transition;
//   its parts follow each other inside it with no transition (sample-exact joins).

export interface TimedItem {
  id: string;
  kind: string;
  plannedDurationMs: number;
  timing: LogItemTiming;
  anchorAt: Date | null;
  segmentId: string | null;
  /** Segments only: the overlap into the next item (`cueOverrides.crossOutMs`). */
  crossOutMs?: number | null;
}

export interface Timed {
  plannedStart: Date;
  plannedDurationMs: number;
  conflict: LogTimingConflict | null;
}

/** Duration of a segment from its parts (contracts/log.ts `plannedDurationMs`). */
export function segmentDurationMs(partsMs: readonly number[], crossOutMs = 0): number {
  const raw = partsMs.reduce((sum, ms) => sum + ms, 0);
  return Math.max(0, raw - crossOutMs + LOG_TRANSITION_MS);
}

function conflictOf(endBefore: number, anchor: number): LogTimingConflict | null {
  if (endBefore > anchor) return { kind: 'overrun', ms: endBefore - anchor };
  if (endBefore < anchor) return { kind: 'gap', ms: anchor - endBefore };
  return null;
}

/**
 * Items of one day in play order, segment parts right after their segment. `previousEnd` is
 * where the day before ends (its last top-level item's planned end), if there is one: the
 * first item's conflict is measured against it. Returns one entry per item.
 */
export function retime(
  items: readonly TimedItem[],
  dayStart: Date,
  previousEnd: Date | null = null,
): Timed[] {
  const out: Timed[] = [];
  let cursor = dayStart.getTime();
  let first = true;
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as TimedItem;
    if (item.segmentId !== null) {
      throw new Error(`log item ${item.id} is a part outside of its segment`);
    }
    const parts: TimedItem[] = [];
    if (item.kind === 'segment') {
      while (items[i + 1]?.segmentId === item.id) parts.push(items[++i] as TimedItem);
    }
    const duration =
      item.kind === 'segment'
        ? segmentDurationMs(
            parts.map((p) => p.plannedDurationMs),
            item.crossOutMs ?? 0,
          )
        : item.plannedDurationMs;

    // What the items before end at: the previous day's end for the first item, when known.
    const endBefore = first ? (previousEnd?.getTime() ?? null) : cursor;
    let start: number;
    let conflict: LogTimingConflict | null = null;
    if (item.timing === 'flow') {
      start = cursor;
      if (first && endBefore !== null) conflict = conflictOf(endBefore, start);
    } else {
      const anchor = item.anchorAt?.getTime() ?? cursor;
      start = item.timing === 'not_before' ? Math.max(anchor, cursor) : anchor;
      if (endBefore !== null) {
        const found = conflictOf(endBefore, anchor);
        // not_before only waits: an earlier anchor is no conflict.
        conflict = item.timing === 'not_before' && found?.kind === 'overrun' ? null : found;
      } else if (first && anchor > cursor) {
        conflict = conflictOf(cursor, anchor);
      }
    }
    out.push({ plannedStart: new Date(start), plannedDurationMs: duration, conflict });
    let partStart = start;
    for (const part of parts) {
      out.push({
        plannedStart: new Date(partStart),
        plannedDurationMs: part.plannedDurationMs,
        conflict: null,
      });
      partStart += part.plannedDurationMs;
    }
    cursor = start + duration;
    first = false;
  }
  return out;
}

/** Where a retimed day ends: its last top-level item's planned end, or null when empty. */
export function dayEnd(items: readonly TimedItem[], timed: readonly Timed[]): Date | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.segmentId !== null) continue;
    const t = timed[i];
    if (t) return new Date(t.plannedStart.getTime() + t.plannedDurationMs);
  }
  return null;
}
