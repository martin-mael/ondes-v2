import type { LogItem, LogSegmentPart, OnAirHardEvent, OnAirNextItem } from '@ondes/shared';

// Next items and the next hard event (#70, ADR 0034). Pure: the log around now, what is on
// air and the time in, estimates out.
//
// The log's `plannedStart` is the plan (`retime`, packages/scheduling/src/log). What really
// aired drifts from it, so the next items move by the same amount: a `flow` item keeps the
// drift of the item before it, a `hard` or `soft` item starts at its anchor (it cuts or waits,
// ADR 0003) and resets the drift, a `not_before` item starts at the later of its anchor and the
// chained time. While the item on air plays past its planned end, the drift grows with it:
// nothing after it can start before now.

const ms = (iso: string) => Date.parse(iso);

export interface AiringItem {
  /** The as-run's log item: a top-level item or a segment part. Null off the log. */
  logItemId: string | null;
  segmentId: string | null;
  /** On the engine's clock, ms. */
  startedAt: number;
}

export interface Estimate {
  next: OnAirNextItem[];
  /** The first `hard`/`soft` start or marker after what is on air (segment parts included). */
  hardEvent: OnAirHardEvent | null;
}

type Unit = Pick<
  LogSegmentPart,
  'id' | 'kind' | 'timing' | 'title' | 'asset' | 'plannedStart' | 'plannedDurationMs' | 'anchorAt'
>;

/**
 * What comes after the item on air, in play order, and the planned span of the item on air.
 * When it is a segment part (an island chain: A's body, the island, B's body), the parts after
 * it come first, then the items after the segment.
 */
function locate(items: readonly LogItem[], airing: AiringItem) {
  for (const [index, item] of items.entries()) {
    const after = items.slice(index + 1);
    if (item.id === airing.logItemId) return { onAir: item as Unit, upcoming: after as Unit[] };
    const partIndex = item.parts.findIndex((p) => p.id === airing.logItemId);
    const part = item.parts[partIndex];
    if (part) {
      return { onAir: part, upcoming: [...item.parts.slice(partIndex + 1), ...after] as Unit[] };
    }
    // The engine reported the whole segment as one item.
    if (airing.segmentId && item.id === airing.segmentId) {
      return { onAir: item as Unit, upcoming: after as Unit[] };
    }
  }
  return null;
}

export function estimateNext(
  items: readonly LogItem[],
  airing: AiringItem | null,
  now: number,
  count: number,
): Estimate {
  const found = airing ? locate(items, airing) : null;
  let upcoming: readonly Unit[];
  let drift = 0;
  if (found && airing) {
    upcoming = found.upcoming;
    const plannedStart = ms(found.onAir.plannedStart);
    const plannedEnd = plannedStart + found.onAir.plannedDurationMs;
    drift = Math.max(airing.startedAt - plannedStart, now - plannedEnd);
  } else {
    // Off the log (live, safety): the plan from now on.
    upcoming = items.filter((item) => ms(item.plannedStart) >= now);
  }

  const next: OnAirNextItem[] = [];
  let hardEvent: OnAirHardEvent | null = null;
  for (const item of upcoming) {
    const planned = ms(item.plannedStart);
    const anchor = item.anchorAt ? ms(item.anchorAt) : planned;
    let start: number;
    if (item.timing === 'hard' || item.timing === 'soft') start = anchor;
    else if (item.timing === 'not_before') start = Math.max(anchor, planned + drift);
    else start = planned + drift;
    drift = start - planned;

    if (next.length < count) {
      next.push({
        logItemId: item.id,
        kind: item.kind,
        timing: item.timing,
        title: item.title ?? item.asset?.title ?? null,
        artists: item.asset?.artists ?? [],
        plannedStart: item.plannedStart,
        estimatedStart: new Date(start).toISOString(),
        durationMs: item.plannedDurationMs,
      });
    }
    if (
      !hardEvent &&
      (item.timing === 'hard' || item.timing === 'soft' || item.kind === 'marker')
    ) {
      hardEvent = {
        kind:
          item.kind === 'marker' ? 'marker' : item.timing === 'soft' ? 'soft_start' : 'hard_start',
        at: new Date(start).toISOString(),
        title: item.title ?? item.asset?.title ?? null,
        logItemId: item.id,
        showId: null,
      };
    }
    if (next.length >= count && hardEvent) break;
  }
  return { next, hardEvent };
}
