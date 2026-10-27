import type { AsRunEntry, LogItem, LogPlacement, MarkerTiming } from '@ondes/shared';
import { startMs } from './model.ts';
import type { HourSlot } from './time.ts';

// Fixed-time markers on the timeline (#52, ADR 0036). Pure. A marker times the item right
// after it: the feeder hands it the marker's timing (`resolveMarkers` in @ondes/scheduling),
// so the timeline shows that item as the marker's, and how close to the marker it aired.

/** Kinds a marker times (the kinds the feeder pushes). */
const TIMED_KINDS: readonly string[] = [
  'song',
  'vt',
  'jingle',
  'bed',
  'episode',
  'fill',
  'segment',
];

/**
 * The item marker `items[index]` times: the next one the feeder pushes, unless another marker,
 * a live slot or an item with its own anchor comes first (the marker is then a plain timing
 * point). Mirrors `resolveMarkers`, without the feeder's view of what can't play.
 */
export function markerTarget(items: readonly LogItem[], index: number): LogItem | null {
  const marker = items[index];
  if (marker?.kind !== 'marker' || marker.timing === 'flow') return null;
  for (let j = index + 1; j < items.length; j++) {
    const item = items[j] as LogItem;
    if (item.kind === 'marker' || item.kind === 'live_slot') return null;
    if (!TIMED_KINDS.includes(item.kind)) continue;
    return item.timing === 'flow' ? item : null;
  }
  return null;
}

/** Tolerance before a marker's item counts as early or late: a second, as the as-run rounds. */
export const MARKER_TOLERANCE_MS = 1_000;

/**
 * How the marker's item aired: `deltaMs` after the marker's time, and whether that is what the
 * marker allows (hard: on time; soft: not early, at most its cap late; not before: not early).
 */
export function markerOutcome(
  marker: Pick<LogItem, 'timing' | 'anchorAt' | 'capMs'>,
  aired: Pick<AsRunEntry, 'startedAt'> | undefined,
): { deltaMs: number; met: boolean } | null {
  if (!aired || !marker.anchorAt) return null;
  const deltaMs = Date.parse(aired.startedAt) - Date.parse(marker.anchorAt);
  const early = deltaMs < -MARKER_TOLERANCE_MS;
  const late = deltaMs > MARKER_TOLERANCE_MS;
  const met =
    marker.timing === 'hard'
      ? !early && !late
      : marker.timing === 'soft'
        ? !early && deltaMs <= (marker.capMs ?? 0) + MARKER_TOLERANCE_MS
        : !early;
  return { deltaMs, met };
}

/**
 * Where a marker at `anchorMs` goes in the day's list: before the first item starting at or
 * after it (that item is then the one it times), else at the end. `self` is the marker being
 * edited: it doesn't count, and `null` means it is already in place.
 */
export function markerPlacement(
  items: readonly LogItem[],
  anchorMs: number,
  date: string,
  self?: LogItem,
): LogPlacement | null {
  const others = items.filter((i) => i.id !== self?.id);
  const next = others.find((i) => startMs(i) >= anchorMs);
  if (self) {
    const at = items.findIndex((i) => i.id === self.id);
    const after = items.slice(at + 1).find((i) => i.id !== self.id);
    if (after?.id === next?.id) return null;
  }
  if (next) return { before: next.id };
  const last = others.at(-1);
  return last ? { after: last.id } : { localDate: date };
}

/** `mm:ss` (or `mm`) into ms, or null when it isn't a time within the hour. */
export function parseMinSec(value: string): number | null {
  const m = /^\s*(\d{1,2})(?::(\d{1,2}))?\s*$/.exec(value);
  if (!m) return null;
  const minutes = Number(m[1]);
  const seconds = Number(m[2] ?? 0);
  if (minutes > 59 || seconds > 59) return null;
  return (minutes * 60 + seconds) * 1000;
}

/** `05:09` from ms within an hour. */
export function formatMinSec(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** The marker's time from one of the day's real hours (DST-safe: 02:00 twice) and `mm:ss`. */
export function markerAnchor(hour: HourSlot | undefined, minSec: string): number | null {
  const offset = parseMinSec(minSec);
  if (!hour || offset === null) return null;
  const at = hour.start + offset;
  return at < hour.end ? at : null;
}

/** The marker's input for the log api. */
export function markerInput(value: {
  anchorMs: number;
  timing: MarkerTiming;
  capMs: number | null;
  label: string;
}) {
  return {
    kind: 'marker' as const,
    plannedDurationMs: 0,
    title: value.label.trim() || null,
    timing: value.timing,
    anchorAt: new Date(value.anchorMs).toISOString(),
    capMs: value.timing === 'soft' ? value.capMs : null,
  };
}
