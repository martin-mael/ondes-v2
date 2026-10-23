import type { AsRunOverlayRow, AsRunOverlayStatus } from '@ondes/shared';
import type { HourSlot } from '../time.ts';

// What the log vs as-run view (#53) derives from the overlay rows. Pure, tested without
// rendering.

/** A drift past this is shown as a problem (same threshold as the timeline's rows). */
export const DRIFT_WARN_MS = 30_000;

/** Statuses where what aired is what was planned. */
const ON_PLAN: ReadonlySet<AsRunOverlayStatus> = new Set([
  'aired',
  'pending',
  'live',
  'transition',
]);

export const isOffPlan = (row: AsRunOverlayRow) =>
  !ON_PLAN.has(row.status) ||
  (row.entry?.outcome != null && row.entry.outcome !== 'complete') ||
  // Live outside any live slot of the plan.
  (row.status === 'live' && row.plan === null);

export interface HistoryHour extends HourSlot {
  rows: AsRunOverlayRow[];
  /** Rows that aired (have an entry). */
  aired: number;
  /** Rows where air and plan disagree (see `isOffPlan`). */
  offPlan: number;
  /** The largest drift in the hour, signed (positive is late); null when nothing drifted. */
  driftMs: number | null;
}

/**
 * The rows in the hours they aired (or were planned) in. A row before the first hour or after
 * the last one (an item of the day that aired just across midnight) goes to that edge hour.
 */
export function groupByHour(
  rows: readonly AsRunOverlayRow[],
  hours: readonly HourSlot[],
): HistoryHour[] {
  const groups: HistoryHour[] = hours.map((h) => ({
    ...h,
    rows: [],
    aired: 0,
    offPlan: 0,
    driftMs: null,
  }));
  if (groups.length === 0) return groups;
  for (const row of rows) {
    const at = Date.parse(row.at);
    const group =
      groups.find((g) => at >= g.start && at < g.end) ??
      (at < (groups[0]?.start ?? 0) ? groups[0] : groups.at(-1));
    if (!group) continue;
    group.rows.push(row);
    if (row.entry) group.aired++;
    if (isOffPlan(row)) group.offPlan++;
    const drift = row.entry?.driftMs;
    if (drift != null && Math.abs(drift) >= 1000) {
      if (group.driftMs === null || Math.abs(drift) > Math.abs(group.driftMs)) {
        group.driftMs = drift;
      }
    }
  }
  return groups;
}

/** The accent colour of a row's status strip. */
export function statusTone(row: AsRunOverlayRow): string {
  switch (row.status) {
    case 'aired':
      return row.entry?.outcome && row.entry.outcome !== 'complete'
        ? 'bg-amber-500'
        : 'bg-emerald-500';
    case 'live':
    case 'transition':
      return 'bg-sky-500';
    case 'pending':
      return 'bg-muted-foreground/30';
    case 'missed':
    case 'emergency':
      return 'bg-destructive';
    default:
      // replaced, fallback, safety, unplanned
      return 'bg-amber-500';
  }
}
