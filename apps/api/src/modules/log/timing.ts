import type { LogItemTiming } from '@ondes/shared';

// Planned starts of a day's items (ADR 0003). Pure: the repository calls it after every edit
// and every bulk write, so `planned_start` always follows from durations and anchors.
//
// - `flow` items start where the previous top-level item ends; the first one at the day's start.
// - `hard` and `soft` items start at their anchor, whatever comes before (a gap or an overrun is
//   left for back-timing, #46, to fix; the engine-timed cut and the feeder handle it on air).
// - `not_before` items start at their anchor or after the previous item, whichever is later.
// - A segment lasts the sum of its parts; its parts follow each other inside it.

export interface TimedItem {
  id: string;
  kind: string;
  plannedDurationMs: number;
  timing: LogItemTiming;
  anchorAt: Date | null;
  segmentId: string | null;
}

export interface Timed {
  plannedStart: Date;
  plannedDurationMs: number;
}

/** Items in play order, segment parts right after their segment. Returns one entry per item. */
export function retime(items: readonly TimedItem[], dayStart: Date): Timed[] {
  const out: Timed[] = [];
  let cursor = dayStart.getTime();
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
        ? parts.reduce((sum, p) => sum + p.plannedDurationMs, 0)
        : item.plannedDurationMs;
    const anchor = item.anchorAt?.getTime() ?? cursor;
    const start =
      item.timing === 'flow'
        ? cursor
        : item.timing === 'not_before'
          ? Math.max(anchor, cursor)
          : anchor;
    out.push({ plannedStart: new Date(start), plannedDurationMs: duration });
    let partStart = start;
    for (const part of parts) {
      out.push({ plannedStart: new Date(partStart), plannedDurationMs: part.plannedDurationMs });
      partStart += part.plannedDurationMs;
    }
    cursor = start + duration;
  }
  return out;
}
