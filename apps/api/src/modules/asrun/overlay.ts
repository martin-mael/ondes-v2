import {
  AS_RUN_TOLERANCE_MS,
  type AsRunEntry,
  type AsRunOverlayPlan,
  type AsRunOverlayRow,
  type AsRunOverlayStatus,
  type LogItem,
  type LogSegmentPart,
} from '@ondes/shared';

// Log vs as-run (#53, ADR 0029): the day's plan with what aired laid over it. Pure: the log
// (top-level items with their parts) and the as-run entries in, rows out.
//
// Matching, in this order:
// 1. by log item id: the recorder keeps an entry's `logItemId` only when it was this station's
//    item, so an id match is exact. An island part matches its part (or its segment, when the
//    engine reports the segment as one item);
// 2. a `live` entry with no log item takes the live slot it overlaps;
// 3. everything else is off-plan (safety, emergency, live outside a slot, unplanned pushes).
// A plan item nothing aired for is `pending` while its slot isn't over, `replaced` when
// off-plan audio held its slot, else `missed`.

const ms = (iso: string) => Date.parse(iso);

type Unit = {
  plan: AsRunOverlayPlan;
  /** The top-level item (the segment, for a part). */
  topId: string;
  start: number;
  end: number;
};

function planOf(item: LogItem | LogSegmentPart): AsRunOverlayPlan {
  return {
    logItemId: item.id,
    segmentId: item.segmentId,
    kind: item.kind,
    plannedStart: item.plannedStart,
    plannedDurationMs: item.plannedDurationMs,
    timing: item.timing,
    assetId: item.assetId,
    title: item.title ?? item.asset?.title ?? null,
    artists: item.asset?.artists ?? [],
  };
}

const unitOf = (item: LogItem | LogSegmentPart, topId: string): Unit => ({
  plan: planOf(item),
  topId,
  start: ms(item.plannedStart),
  end: ms(item.plannedStart) + item.plannedDurationMs,
});

const OFF_PLAN: Record<AsRunEntry['source'], AsRunOverlayStatus> = {
  log: 'unplanned',
  unknown: 'unplanned',
  safety: 'safety',
  emergency: 'emergency',
  live: 'live',
};

const overlapMs = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  Math.min(a.end, b.end) - Math.max(a.start, b.start);

export interface OverlayInput {
  /** Top-level log items (segments with their parts); those starting outside the day are ignored. */
  items: readonly LogItem[];
  /** As-run entries around the day (a little wider, so late items still find theirs). */
  entries: readonly AsRunEntry[];
  /** The day, UTC ms, `[from, to)`. */
  from: number;
  to: number;
  now: number;
}

export function buildOverlay({ items, entries, from, to, now }: OverlayInput): AsRunOverlayRow[] {
  // Markers never air: they only anchor the plan.
  const tops = items.filter((i) => {
    const at = ms(i.plannedStart);
    return at >= from && at < to && i.kind !== 'marker';
  });
  const units = new Map<string, Unit>();
  for (const top of tops) {
    units.set(top.id, unitOf(top, top.id));
    for (const part of top.parts) units.set(part.id, unitOf(part, top.id));
  }
  const liveSlots = tops.filter((t) => t.kind === 'live_slot').map((t) => units.get(t.id) as Unit);

  const sorted = [...entries].sort(
    (a, b) => ms(a.startedAt) - ms(b.startedAt) || a.id.localeCompare(b.id),
  );
  const rows: AsRunOverlayRow[] = [];
  const airedTops = new Set<string>();
  const seenItems = new Set<string>();
  const offPlan: { entry: AsRunEntry; start: number; end: number }[] = [];

  for (const entry of sorted) {
    const start = ms(entry.startedAt);
    const span = { start, end: entry.endedAt ? ms(entry.endedAt) : Math.max(start, now) };
    let unit =
      (entry.logItemId ? units.get(entry.logItemId) : undefined) ??
      (entry.segmentId ? units.get(entry.segmentId) : undefined);
    if (!unit && entry.source === 'live' && !entry.logItemId) {
      unit = liveSlots.find((slot) => overlapMs(slot, span) > 0);
    }
    if (!unit) {
      // Off-plan audio of a neighbouring day belongs to that day.
      if (start < from || start >= to) continue;
      offPlan.push({ entry, ...span });
      rows.push({
        status: OFF_PLAN[entry.source],
        at: entry.startedAt,
        plan: null,
        entry,
        replacedBy: [],
        repeat: false,
      });
      continue;
    }
    airedTops.add(unit.topId);
    const key = unit.plan.logItemId;
    const repeat = unit.plan.kind !== 'live_slot' && seenItems.has(key);
    seenItems.add(key);
    rows.push({
      status: matchedStatus(unit.plan, entry),
      at: entry.startedAt,
      plan: unit.plan,
      entry,
      replacedBy: [],
      repeat,
    });
  }

  for (const top of tops) {
    if (airedTops.has(top.id)) continue;
    const unit = units.get(top.id) as Unit;
    const base = { at: top.plannedStart, plan: unit.plan, entry: null, repeat: false };
    if (unit.end > now) {
      rows.push({ ...base, status: 'pending', replacedBy: [] });
      continue;
    }
    const held = offPlan.filter((o) => overlapMs(unit, o) > AS_RUN_TOLERANCE_MS);
    rows.push({
      ...base,
      status: held.length > 0 ? 'replaced' : 'missed',
      replacedBy: held.map((o) => o.entry.id),
    });
  }

  // Air order; at the same instant, what aired before what didn't.
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => ms(a.row.at) - ms(b.row.at) || a.i - b.i)
    .map(({ row }) => row);
}

function matchedStatus(plan: AsRunOverlayPlan, entry: AsRunEntry): AsRunOverlayStatus {
  if (entry.fallback) return 'fallback';
  if (plan.kind === 'live_slot' || entry.source === 'live') return 'live';
  if (plan.assetId && entry.assetId && plan.assetId !== entry.assetId) return 'replaced';
  return 'aired';
}
