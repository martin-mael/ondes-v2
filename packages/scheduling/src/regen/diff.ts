import type {
  CueOverrides,
  LogItemKind,
  LogItemOrigin,
  LogItemTiming,
  LogTimingConflict,
  RelaxedRule,
} from '@ondes/shared';
import type { GeneratedDay, GeneratedItem, KeptReason } from '../generator/index.ts';

// Comparing a generated day with the day as it is (#101, ADR 0030): `sameDay` decides whether
// writing it would change anything (an unchanged day is not written, so regenerating with the
// same seed and inputs is a no-op), `diffDay` says what would change, for the dry-run.

/** A current item of the day (top-level or segment part), as stored. */
export interface CurrentItem {
  id: string;
  position: number;
  kind: LogItemKind;
  plannedStart: Date;
  plannedDurationMs: number;
  assetId: string | null;
  episodeId: string | null;
  liveSlotId: string | null;
  title: string | null;
  cueOverrides: CueOverrides | null;
  timing: LogItemTiming;
  anchorAt: Date | null;
  capMs: number | null;
  origin: LogItemOrigin;
  locked: boolean;
  relaxedRules: readonly RelaxedRule[];
  segmentId: string | null;
  conflict: LogTimingConflict | null;
}

/** The current day: its items in position order, and how it was last generated. */
export interface CurrentDay {
  seed: string | null;
  generatorVersion: string | null;
  items: readonly CurrentItem[];
}

const time = (d: Date | null) => d?.getTime() ?? null;

const sameConflict = (a: LogTimingConflict | null, b: LogTimingConflict | null) =>
  a === b || (!!a && !!b && a.kind === b.kind && a.ms === b.ms);

export function sameOrigin(a: LogItemOrigin, b: LogItemOrigin): boolean {
  if (a.type === 'clock' && b.type === 'clock') {
    return a.clockId === b.clockId && a.slotIndex === b.slotIndex;
  }
  if (a.type === 'show' && b.type === 'show') return a.showSlotId === b.showSlotId;
  return a.type === b.type;
}

const sameRules = (a: readonly RelaxedRule[], b: readonly RelaxedRule[]) =>
  a.length === b.length &&
  a.every((r, i) => r.rule === b[i]?.rule && (r.reason ?? null) === (b[i]?.reason ?? null));

/** Timing as the writer sets it on every item, kept ones included. */
function sameTiming(c: CurrentItem, g: GeneratedItem) {
  return (
    c.position === g.position &&
    c.plannedStart.getTime() === g.plannedStart.getTime() &&
    c.plannedDurationMs === g.plannedDurationMs &&
    sameConflict(c.conflict, g.conflict)
  );
}

/** What a new item would be written with, compared with a current one. */
function sameContent(c: CurrentItem, g: GeneratedItem) {
  return (
    !c.locked &&
    c.segmentId === null &&
    c.cueOverrides === null &&
    c.kind === g.kind &&
    c.assetId === g.assetId &&
    c.episodeId === g.episodeId &&
    c.liveSlotId === g.liveSlotId &&
    c.title === g.title &&
    c.timing === g.timing &&
    time(c.anchorAt) === time(g.anchorAt) &&
    c.capMs === g.capMs &&
    sameOrigin(c.origin, g.origin) &&
    sameRules(c.relaxedRules, g.relaxedRules)
  );
}

/**
 * Whether writing `generated` over `current` would leave the day as it is: the same items in the
 * same order and times, kept items with their ids, the same seed and generator version. Item
 * ids aside (new items get new ids), that's what the writer would produce.
 */
export function sameDay(current: CurrentDay, generated: GeneratedDay): boolean {
  if (current.seed !== generated.seed) return false;
  if (current.generatorVersion !== generated.generatorVersion) return false;
  if (current.items.length !== generated.items.length) return false;
  return generated.items.every((g, i) => {
    const c = current.items[i] as CurrentItem;
    if (!sameTiming(c, g)) return false;
    return g.keptId !== null ? c.id === g.keptId : sameContent(c, g);
  });
}

// --- Diff ----------------------------------------------------------------------------------

/** The common shape of a current or generated top-level item in a diff. */
export interface DiffItem {
  /** The current item's id; null for a generated item that would be new. */
  id: string | null;
  kind: LogItemKind;
  plannedStart: Date;
  plannedDurationMs: number;
  assetId: string | null;
  episodeId: string | null;
  liveSlotId: string | null;
  title: string | null;
  timing: LogItemTiming;
  origin: LogItemOrigin;
  relaxedRules: readonly RelaxedRule[];
  conflict: LogTimingConflict | null;
}

export interface DayDiff {
  change: 'new' | 'changed' | 'unchanged';
  added: DiffItem[];
  removed: DiffItem[];
  moved: { item: DiffItem; fromStart: Date; shiftMs: number }[];
  relaxed: { item: DiffItem; new: boolean }[];
  kept: Partial<Record<KeptReason, number>>;
  unchangedCount: number;
  /** The generated day's top-level items. */
  items: DiffItem[];
}

function originKey(o: LogItemOrigin) {
  if (o.type === 'clock') return `clock:${o.clockId}:${o.slotIndex}`;
  if (o.type === 'show') return `show:${o.showSlotId}`;
  return 'manual';
}

/**
 * Identity across a regeneration: what an item plays (its asset, episode or live slot), else
 * where it comes from (markers, empty episodes, placeholders). A song planned at another time
 * is the same item, moved.
 */
function identity(i: DiffItem) {
  const what = i.assetId ?? i.episodeId ?? i.liveSlotId;
  return what ? `${i.kind}|${what}` : `${i.kind}|${originKey(i.origin)}|${i.title ?? ''}`;
}

const fromCurrent = (c: CurrentItem): DiffItem => ({
  id: c.id,
  kind: c.kind,
  plannedStart: c.plannedStart,
  plannedDurationMs: c.plannedDurationMs,
  assetId: c.assetId,
  episodeId: c.episodeId,
  liveSlotId: c.liveSlotId,
  title: c.title,
  timing: c.timing,
  origin: c.origin,
  relaxedRules: c.relaxedRules,
  conflict: c.conflict,
});

/**
 * What regenerating the day would change. `current` is null for a day without a log;
 * `keptReasons` gives the reasons of the current items the regeneration keeps.
 *
 * Kept items are matched by id (counted, or moved when retiming shifts them). The others are
 * paired by identity in time order: same start = unchanged, else moved; what's left over is
 * added or removed.
 */
export function diffDay(
  current: CurrentDay | null,
  generated: GeneratedDay,
  keptReasons: ReadonlyMap<string, readonly KeptReason[]> = new Map(),
): DayDiff {
  const top = generated.items.filter((i) => i.segmentId === null);
  const currentTop = (current?.items ?? []).filter((i) => i.segmentId === null);
  const byId = new Map(currentTop.map((c) => [c.id, c]));
  const items: DiffItem[] = top.map((g) => {
    const kept = g.keptId ? byId.get(g.keptId) : undefined;
    if (kept) {
      return {
        ...fromCurrent(kept),
        plannedStart: g.plannedStart,
        plannedDurationMs: g.plannedDurationMs,
        conflict: g.conflict,
      };
    }
    return {
      id: null,
      kind: g.kind,
      plannedStart: g.plannedStart,
      plannedDurationMs: g.plannedDurationMs,
      assetId: g.assetId,
      episodeId: g.episodeId,
      liveSlotId: g.liveSlotId,
      title: g.title,
      timing: g.timing,
      origin: g.origin,
      relaxedRules: g.relaxedRules,
      conflict: g.conflict,
    };
  });

  const out: DayDiff = {
    change: current === null ? 'new' : sameDay(current, generated) ? 'unchanged' : 'changed',
    added: [],
    removed: [],
    moved: [],
    relaxed: [],
    kept: {},
    unchangedCount: 0,
    items,
  };

  const keptIds = new Set<string>();
  const pending = new Map<string, DiffItem[]>();
  for (const item of items) {
    if (item.id !== null) {
      keptIds.add(item.id);
      const reason = keptReasons.get(item.id)?.[0] ?? 'locked';
      out.kept[reason] = (out.kept[reason] ?? 0) + 1;
      const before = byId.get(item.id) as CurrentItem;
      const shift = item.plannedStart.getTime() - before.plannedStart.getTime();
      if (shift !== 0) out.moved.push({ item, fromStart: before.plannedStart, shiftMs: shift });
      continue;
    }
    const key = identity(item);
    pending.set(key, [...(pending.get(key) ?? []), item]);
  }

  const matched = new Map<DiffItem, DiffItem>();
  const remaining = currentTop.filter((c) => !keptIds.has(c.id)).map(fromCurrent);
  const unmatched: DiffItem[] = [];
  for (const before of remaining) {
    const queue = pending.get(identity(before));
    const after = queue?.shift();
    if (!after) {
      unmatched.push(before);
      continue;
    }
    matched.set(after, before);
    const shift = after.plannedStart.getTime() - before.plannedStart.getTime();
    if (shift === 0) out.unchangedCount++;
    else out.moved.push({ item: after, fromStart: before.plannedStart, shiftMs: shift });
  }
  out.removed = unmatched;
  out.added = items.filter((i) => i.id === null && !matched.has(i));
  for (const item of items) {
    if (item.id !== null || item.relaxedRules.length === 0) continue;
    const before = matched.get(item);
    out.relaxed.push({ item, new: !before || before.relaxedRules.length === 0 });
  }
  return out;
}
