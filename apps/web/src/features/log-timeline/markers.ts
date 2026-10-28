import {
  type AsRunEntry,
  type LogItem,
  type LogPlacement,
  type MarkerTarget,
  type MarkerTiming,
  markerTargetOf,
} from '@ondes/shared';
import { isAssetKind, startMs } from './model.ts';
import type { HourSlot } from './time.ts';
import type { PassedOver } from './use-live.ts';

// Fixed-time markers on the timeline (#52, ADR 0036). Pure. A marker times the item right
// after it: the feeder hands it the marker's timing (`resolveMarkers` in @ondes/scheduling,
// through `markerTargetOf` in @ondes/shared, the rule used here too), so the timeline shows
// that item as the marker's, and how close to the marker it aired.

/** Why a marker times nothing (`markerTargetOf`). */
export type MarkerNone = Extract<MarkerTarget, { none: unknown }>['none'];

/**
 * Whether the feeder won't push `item`, as far as the timeline knows: no playout file (no
 * asset), or the feeder reported passing it over for a reason that keeps it off air.
 */
export function wontPush(item: LogItem, passedOver?: PassedOver): boolean {
  if (passedOver && passedOver.reason !== 'dropped') return true;
  if (item.kind === 'segment') return item.parts.length < 2 || item.parts.some((p) => !p.asset);
  return isAssetKind(item.kind) && !item.asset;
}

/**
 * The item marker `items[index]` times, or why it times none: the feeder's own rule
 * (`markerTargetOf`, as `resolveMarkers` applies it), with the timeline's view of what it won't
 * push (`wontPush`). Null for an item that isn't an anchored marker.
 */
export function markerTarget(
  items: readonly LogItem[],
  index: number,
  passedOver: (id: string) => PassedOver | undefined = () => undefined,
): { item: LogItem } | { none: MarkerNone } | null {
  const marker = items[index];
  if (marker?.kind !== 'marker' || marker.timing === 'flow') return null;
  const found = markerTargetOf(items, index, (item) => wontPush(item, passedOver(item.id)));
  return 'index' in found ? { item: items[found.index] as LogItem } : found;
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

/**
 * Why a marker at `anchorMs`, placed as `markerPlacement` would, would time nothing because
 * another marker or a live slot comes first (a calm warning, saving stays possible); else null.
 */
export function markerBlocked(
  items: readonly LogItem[],
  anchorMs: number,
  self?: LogItem,
  passedOver: (id: string) => PassedOver | undefined = () => undefined,
): 'marker' | 'live_slot' | null {
  const others = items.filter((i) => i.id !== self?.id);
  const at = others.findIndex((i) => startMs(i) >= anchorMs);
  // The marker would sit just before `others[at]`: what follows it is scanned from there.
  const found = markerTargetOf(others, (at < 0 ? others.length : at) - 1, (item) =>
    wontPush(item, passedOver(item.id)),
  );
  return 'none' in found && (found.none === 'marker' || found.none === 'live_slot')
    ? found.none
    : null;
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
