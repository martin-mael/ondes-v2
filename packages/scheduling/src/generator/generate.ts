import {
  addDays,
  CLOCK_TOLERANCE_MS,
  type ClockSlot,
  estimateClock,
  LOG_TRANSITION_MS,
  type LocalDate,
  type LogItemKind,
  localDayBounds,
  logKindForSlot,
  type SlotReference,
  slotPoolId,
  zonedParts,
} from '@ondes/shared';
import { expandGrid } from '../grid/index.ts';
import { retime } from '../log/index.ts';
import {
  type PickSnapshot,
  type PlayedItem,
  pickForSlot,
  playedFrom,
  removeFromHistory,
} from '../rules/index.ts';
import {
  type AnchorTools,
  GENERATOR_VERSION,
  type GeneratedDay,
  type GeneratedItem,
  type GenerateOptions,
  type GeneratorAsset,
  type GeneratorClock,
  type GeneratorExtensions,
  type GeneratorIssue,
  type GeneratorOccurrence,
  type GeneratorSnapshot,
  type KeptItem,
  type PlannedItem,
} from './types.ts';

// The log generator (#50, ADR 0026): one station-local day of log items from a snapshot.
//
// Build order:
// 1. Fixed blocks: kept items (locked, segue ends, fallback marks), then show occurrences
//    (pre-recorded and rerun episodes, live slots), each anchored `hard` at its start.
//    Colliding occurrences are settled here (`settleOccurrences`).
// 2. Structure: the music windows between the blocks are laid out as clock instances from the
//    weekly grid (`expandGrid`, DST-aware: 23 or 25 real hours), with their markers.
// 3. Music: each instance's slots are filled in air order, the picks joining the rules' history
//    as they are made, so every later pick sees them.
// Then the day is retimed exactly like the log (`retime`), so what is written is what the log
// would compute itself.
//
// Never fails on a station's data: hours without a clock, empty categories and missing
// episodes become `issues`, and the first item after a hole waits for its time (`not_before`)
// instead of sliding into it.

const HOUR_MS = 3_600_000;
/** Length assumed for an asset whose length is unknown and whose slot has none. */
const UNKNOWN_LENGTH_MS = 180_000;

/** How long an asset occupies the log: what it plays, minus its overlap, plus one frame. */
export function itemLengthMs(asset: GeneratorAsset, fallbackMs: number | null = null): number {
  const play = asset.playMs ?? asset.durationMs ?? fallbackMs ?? UNKNOWN_LENGTH_MS;
  return Math.max(0, play - Math.min(asset.overlapMs, play)) + LOG_TRANSITION_MS;
}

/** One local day. */
export function generateDay(
  snapshot: GeneratorSnapshot,
  localDate: LocalDate,
  options: GenerateOptions = {},
): GeneratedDay {
  const [day] = generateDays(snapshot, [localDate], options);
  return day as GeneratedDay;
}

/**
 * Music from one clock for `[startsAt, startsAt + durationMs)`, whatever the grid says: the
 * missing-episode fallback's "clock music" (ADR 0022, `ClockMusicSource`). The clock starts at
 * `startsAt` and again at every hour after it; items are planned like a day's, against the
 * snapshot's history (the day around it, as planned). Without the clock, nothing.
 */
export function planClockMusic(
  snapshot: GeneratorSnapshot,
  request: { clockId: string; startsAt: Date; durationMs: number },
  options: GenerateOptions = {},
): { items: PlannedItem[]; issues: GeneratorIssue[] } {
  if (!snapshot.clocks.has(request.clockId) || request.durationMs <= 0) {
    return { items: [], issues: [] };
  }
  const local = zonedParts(request.startsAt, snapshot.timeZone).date;
  const builder = new DayBuilder(
    { ...snapshot, grid: { defaultClockId: request.clockId, cells: [], overrides: [] } },
    local,
    [...snapshot.history],
    { seed: options.seed ?? `${snapshot.stationId}:${request.startsAt.toISOString()}`, ...options },
  );
  return builder.fillRange(
    request.startsAt.getTime(),
    request.startsAt.getTime() + request.durationMs,
  );
}

/**
 * Consecutive local days, in order: each day's picks join the history of the next, and each
 * day's first item is timed against the previous day's end.
 */
export function generateDays(
  snapshot: GeneratorSnapshot,
  dates: readonly LocalDate[],
  options: GenerateOptions = {},
): GeneratedDay[] {
  const history: PlayedItem[] = [...snapshot.history];
  for (const kept of snapshot.kept?.values() ?? []) {
    for (const item of kept) if (item.played) history.push(item.played);
  }
  let previousEnd = snapshot.previousDayEnd ?? null;
  let previousDate: LocalDate | null = null;
  return dates.map((localDate) => {
    if (previousDate !== null && addDays(previousDate, 1) !== localDate) previousEnd = null;
    const day = new DayBuilder(snapshot, localDate, history, options).build(previousEnd);
    previousEnd = endOf(day) ?? previousEnd;
    previousDate = localDate;
    return day;
  });
}

function endOf(day: GeneratedDay): Date | null {
  for (let i = day.items.length - 1; i >= 0; i--) {
    const item = day.items[i] as GeneratedItem;
    if (item.segmentId === null) {
      return new Date(item.plannedStart.getTime() + item.plannedDurationMs);
    }
  }
  return null;
}

// --- Fixed blocks ----------------------------------------------------------------------------

interface Block {
  start: number;
  end: number;
  items: PlannedItem[];
}

/** Lower first: a one-off or moved occurrence, then the shorter, then by slot id. */
function priority(a: GeneratorOccurrence, b: GeneratorOccurrence): number {
  if (a.special !== b.special) return a.special ? -1 : 1;
  if (a.durationMs !== b.durationMs) return a.durationMs - b.durationMs;
  return a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0;
}

const endMs = (o: GeneratorOccurrence) => o.startsAt.getTime() + o.durationMs;

/**
 * Occurrences that start together, or one inside the other, can't both air: the one with
 * priority stays, the other is dropped. A partial overlap keeps both: the later one starts at
 * its time (hard) and retiming reports the overrun (ADR 0014: conflicts are data).
 */
export function settleOccurrences(occurrences: readonly GeneratorOccurrence[]): {
  kept: GeneratorOccurrence[];
  dropped: GeneratorOccurrence[];
  overlaps: GeneratorOccurrence[];
} {
  const sorted = [...occurrences].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime() || priority(a, b),
  );
  const dropped = new Set<GeneratorOccurrence>();
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i] as GeneratorOccurrence;
    if (dropped.has(a)) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j] as GeneratorOccurrence;
      if (b.startsAt.getTime() >= endMs(a)) break;
      if (dropped.has(b)) continue;
      const together = b.startsAt.getTime() === a.startsAt.getTime() || endMs(b) <= endMs(a);
      if (!together) continue;
      const loser = priority(a, b) <= 0 ? b : a;
      dropped.add(loser);
      if (loser === a) break;
    }
  }
  const kept = sorted.filter((o) => !dropped.has(o));
  const overlaps = kept.filter(
    (o, i) => i > 0 && o.startsAt.getTime() < endMs(kept[i - 1] as GeneratorOccurrence),
  );
  return { kept, dropped: sorted.filter((o) => dropped.has(o)), overlaps };
}

/** Kept items grouped into runs that play back to back; parts follow their segment. */
function keptBlocks(kept: readonly KeptItem[]): Block[] {
  const blocks: Block[] = [];
  for (const item of kept) {
    const planned = keptPlanned(item);
    const last = blocks.at(-1);
    if (item.segmentId !== null) {
      last?.items.push(planned);
      continue;
    }
    const start = item.plannedStart.getTime();
    const end = start + item.plannedDurationMs;
    if (last && start === last.end) {
      last.items.push(planned);
      last.end = end;
    } else {
      blocks.push({ start, end, items: [planned] });
    }
  }
  return blocks;
}

function keptPlanned(item: KeptItem): PlannedItem {
  return {
    keptId: item.id,
    kind: item.kind,
    plannedDurationMs: item.plannedDurationMs,
    assetId: item.played?.assetId ?? null,
    episodeId: null,
    liveSlotId: null,
    title: null,
    timing: item.timing,
    anchorAt: item.anchorAt,
    capMs: null,
    origin: { type: 'manual' },
    relaxedRules: [],
    segmentId: item.segmentId,
    crossOutMs: item.crossOutMs,
    start: item.plannedStart,
  };
}

// --- One day ---------------------------------------------------------------------------------

class DayBuilder {
  private readonly items: PlannedItem[] = [];
  private readonly issues: GeneratorIssue[] = [];
  /** Index in `items` where the run since the last anchor starts. */
  private runStart = 0;
  /** Where the last planned item ends, as planned. */
  private cursor: number;
  /**
   * Set when the cursor jumped over a hole (an hour without a clock, a show from the night
   * before): the next planned item waits for that time instead of sliding into the hole.
   */
  private waitUntil: number | null = null;
  private readonly seed: string;
  private readonly extensions: GeneratorExtensions;
  private readonly startsAt: Date;
  private readonly endsAt: Date;
  private readonly estimates = new Map<string, number[]>();

  private readonly snapshot: GeneratorSnapshot;
  private readonly localDate: LocalDate;
  /** Shared across days: picks are appended as they are made. */
  private readonly history: PlayedItem[];

  constructor(
    snapshot: GeneratorSnapshot,
    localDate: LocalDate,
    history: PlayedItem[],
    options: GenerateOptions,
  ) {
    this.snapshot = snapshot;
    this.localDate = localDate;
    this.history = history;
    const bounds = localDayBounds(localDate, snapshot.timeZone);
    this.startsAt = bounds.startsAt;
    this.endsAt = bounds.endsAt;
    this.cursor = this.startsAt.getTime();
    this.seed = options.seed ?? `${snapshot.stationId}:${localDate}`;
    this.extensions = options.extensions ?? {};
  }

  /** Music only, for `[from, to)`: the items as planned (not retimed), and the issues. */
  fillRange(from: number, to: number): { items: PlannedItem[]; issues: GeneratorIssue[] } {
    this.cursor = from;
    this.fillWindow(from, to);
    return { items: this.items, issues: this.issues };
  }

  build(previousEnd: Date | null): GeneratedDay {
    const dayStart = this.startsAt.getTime();
    const dayEndMs = this.endsAt.getTime();
    const blocks = this.fixedBlocks();
    for (const block of blocks) {
      // Music up to the block, then the block. A block that starts before the cursor (a
      // previous block overran into it) is placed anyway: retiming reports the overrun.
      if (block.start > this.cursor) this.fillWindow(this.cursor, block.start);
      for (const item of block.items) this.place(item);
      // A block without items (a show from the night before) is a hole in this day's items.
      if (block.items.length === 0) this.skipTo(block.end);
      this.cursor = Math.max(this.cursor, block.end);
    }
    if (this.cursor < dayEndMs) this.fillWindow(this.cursor, dayEndMs);

    const timed = retime(
      this.items.map((item, i) => ({
        id: item.keptId ?? `new:${i}`,
        kind: item.kind,
        plannedDurationMs: item.plannedDurationMs,
        timing: item.timing,
        anchorAt: item.anchorAt,
        segmentId: item.segmentId,
        crossOutMs: item.crossOutMs,
      })),
      new Date(dayStart),
      previousEnd,
    );
    const items: GeneratedItem[] = this.items.map((item, position) => {
      const t = timed[position] as (typeof timed)[number];
      return { ...item, ...t, position };
    });
    return {
      localDate: this.localDate,
      startsAt: this.startsAt,
      endsAt: this.endsAt,
      seed: this.seed,
      generatorVersion: GENERATOR_VERSION,
      items,
      issues: this.issues,
    };
  }

  // --- Blocks --------------------------------------------------------------------------------

  private fixedBlocks(): Block[] {
    const dayStart = this.startsAt.getTime();
    const dayEndMs = this.endsAt.getTime();
    const kept = this.snapshot.kept?.get(this.localDate) ?? [];
    const blocks = keptBlocks(kept);
    const keptSlots = new Set(kept.map((k) => k.showSlotId).filter((s) => s !== null));

    const relevant = this.snapshot.occurrences.filter(
      (o) => o.startsAt.getTime() < dayEndMs && endMs(o) > dayStart,
    );
    const { kept: occurrences, dropped, overlaps } = settleOccurrences(relevant);
    for (const o of dropped) {
      if (o.startsAt.getTime() < dayStart) continue;
      this.issue('occurrence_dropped', o.startsAt, {
        showSlotId: o.slotId,
        detail: `${o.showName}: another occurrence airs at the same time`,
      });
    }
    for (const o of overlaps) {
      if (o.startsAt.getTime() < dayStart) continue;
      this.issue('occurrence_overlap', o.startsAt, {
        showSlotId: o.slotId,
        detail: `${o.showName} starts before the occurrence before it ends`,
      });
    }

    for (const o of occurrences) {
      const start = o.startsAt.getTime();
      if (start < dayStart) {
        // It airs from the day before: its time is taken, its item is that day's.
        blocks.push({ start: dayStart, end: endMs(o), items: [] });
        continue;
      }
      const clash = blocks.find(
        (b) => b.items.some((i) => i.keptId) && b.start < endMs(o) && b.end > start,
      );
      if (clash) {
        // A kept item stands for it (a fallback in its place), or holds its time (locked).
        if (!keptSlots.has(o.slotId)) {
          this.issue('occurrence_dropped', o.startsAt, {
            showSlotId: o.slotId,
            detail: `${o.showName}: a kept item holds its time`,
          });
        }
        continue;
      }
      const item = this.occurrenceItem(o);
      blocks.push({ start, end: start + item.plannedDurationMs, items: [item] });
    }
    return blocks.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  private occurrenceItem(o: GeneratorOccurrence): PlannedItem {
    const soft = o.startPolicy?.mode === 'soft';
    const base = {
      keptId: null,
      timing: soft ? ('soft' as const) : ('hard' as const),
      anchorAt: o.startsAt,
      capMs: soft ? (o.startPolicy?.capMs ?? null) : null,
      origin: { type: 'show' as const, showSlotId: o.slotId },
      relaxedRules: [],
      segmentId: null,
      crossOutMs: null,
      liveSlotId: null,
      start: o.startsAt,
    };
    if (o.type === 'live') {
      return {
        ...base,
        kind: 'live_slot',
        plannedDurationMs: o.durationMs,
        assetId: null,
        episodeId: null,
        title: o.showName,
      };
    }
    const asset = o.episode?.asset ?? null;
    if (!asset) {
      this.issue('episode_missing', o.startsAt, {
        showSlotId: o.slotId,
        detail: o.episode
          ? `${o.showName}: the episode has no audio yet`
          : `${o.showName}: no episode planned`,
      });
    }
    return {
      ...base,
      kind: 'episode',
      // The episode's own length when known: a shorter one leaves room for music before the
      // next item, a longer one shows as an overrun. Without audio, the slot's length.
      plannedDurationMs: asset ? itemLengthMs(asset, o.durationMs) : o.durationMs,
      assetId: asset?.id ?? null,
      episodeId: o.episode?.id ?? null,
      title: o.episode?.title ?? o.showName,
    };
  }

  // --- Placing -------------------------------------------------------------------------------

  /** Moves the cursor over a hole to `at`: the next item will wait for that time. */
  private skipTo(at: number) {
    if (at <= this.cursor) return;
    this.cursor = at;
    this.waitUntil = at;
  }

  /**
   * Appends an item. A new `flow` item after a hole, or one meant to start after the cursor,
   * waits for its time (`not_before`) instead of sliding into the hole.
   */
  private place(item: PlannedItem) {
    let placed = item;
    if (placed.timing === 'flow' && placed.keptId === null && placed.segmentId === null) {
      const wait = Math.max(this.waitUntil ?? 0, placed.start.getTime());
      if (this.waitUntil !== null || wait > this.cursor) {
        const at = new Date(Math.max(wait, this.cursor));
        placed = { ...placed, timing: 'not_before', anchorAt: at, start: at };
      }
    }
    if (placed.segmentId === null) this.waitUntil = null;
    if (placed.timing !== 'flow' && placed.segmentId === null) {
      const before = this.extensions.beforeAnchor;
      if (before) {
        const run = this.items.slice(this.runStart);
        const last = run.at(-1);
        const replaced = before({
          anchor: placed,
          run,
          runEndsAt: new Date(last ? last.start.getTime() + last.plannedDurationMs : this.cursor),
          tools: this.tools,
        });
        this.items.splice(this.runStart, run.length, ...replaced);
      }
      this.items.push(placed);
      this.runStart = this.items.length;
    } else {
      this.items.push(placed);
    }
    const start =
      placed.timing === 'flow'
        ? this.cursor
        : placed.timing === 'not_before'
          ? Math.max(this.cursor, placed.start.getTime())
          : placed.start.getTime();
    if (placed.segmentId === null) this.cursor = start + placed.plannedDurationMs;
  }

  /** `beforeAnchor`'s picks: the same picker and history as the clock slots'. */
  private readonly tools: AnchorTools = {
    pick: ({ categoryId, at, accept }) => {
      const category = this.snapshot.categories.get(categoryId);
      if (!category) return null;
      const result = pickForSlot(
        {
          timeZone: this.snapshot.timeZone,
          rules: this.snapshot.rules,
          history: this.history,
          ...(this.snapshot.lastPlayedAt ? { lastPlayedAt: this.snapshot.lastPlayedAt } : {}),
          seed: this.seed,
          explain: false,
        },
        { at, category, candidates: category.members.filter(accept) },
      );
      if (!result.asset) return null;
      this.history.push(playedFrom(result.asset, at));
      return { asset: result.asset, relaxedRules: result.relaxed };
    },
    release: (item) => {
      if (item.keptId !== null || item.assetId === null) return;
      const at = item.start.getTime();
      let found = false;
      // The one play this item stands for: its asset at its start.
      removeFromHistory(this.history, (played) => {
        if (found || played.assetId !== item.assetId || played.at.getTime() !== at) return false;
        found = true;
        return true;
      });
    },
  };

  // --- Music windows -------------------------------------------------------------------------

  /** Fills `[from, to)` from the grid's clocks. */
  private fillWindow(from: number, to: number) {
    const hours = expandGrid(
      this.snapshot.grid,
      { from: new Date(from), to: new Date(to) },
      this.snapshot.timeZone,
    );
    type Instance = { clock: GeneratorClock | null; start: number; end: number };
    const instances: Instance[] = [];
    let current = null as Instance | null;
    for (const hour of hours) {
      const hourStart = hour.startsAt.getTime();
      const hourEnd = hour.endsAt.getTime();
      const clock = hour.clockId ? this.snapshot.clocks.get(hour.clockId) : undefined;
      if (!clock) {
        if (hour.clockId) {
          this.issue('unknown_clock', hour.startsAt, { clockId: hour.clockId, until: hour.endsAt });
        } else {
          this.issue('no_clock', new Date(Math.max(hourStart, from)), {
            until: new Date(Math.min(hourEnd, to)),
          });
        }
        current = null;
        continue;
      }
      // A clock longer than an hour runs on through the next hours of the same clock; an hour
      // clock, or a partial one repeated within the hour, starts again at every hour.
      const continues =
        current?.clock === clock && clock.targetDurationMs > HOUR_MS && current.end > hourStart;
      if (!continues) {
        current = { clock, start: hourStart, end: hourStart + clock.targetDurationMs };
        instances.push(current);
      }
      while (current && current.end < hourEnd) {
        current = { clock, start: current.end, end: current.end + clock.targetDurationMs };
        instances.push(current);
      }
      // An instance ends where the next one starts, or at the end of its last hour.
      const last = instances.at(-1);
      if (last && last.end > hourEnd && !(clock.targetDurationMs > HOUR_MS)) last.end = hourEnd;
    }
    for (let i = 0; i < instances.length; i++) {
      const instance = instances[i] as Instance;
      const next = instances[i + 1];
      const end = Math.min(instance.end, next ? next.start : instance.end, to);
      if (end <= from || instance.start >= to) continue;
      this.fillInstance(instance.clock as GeneratorClock, instance.start, end, from);
    }
  }

  /** Nominal start offsets of a clock's slots (`estimateClock`, category averages). */
  private offsets(clock: GeneratorClock): number[] {
    let offsets = this.estimates.get(clock.id);
    if (!offsets) {
      const estimate = estimateClock(clock, (slot) => this.reference(slot));
      offsets = estimate.slots.map((s) => s.startMs + s.durationMs);
      this.estimates.set(clock.id, offsets);
    }
    return offsets;
  }

  private reference(slot: ClockSlot): SlotReference | undefined {
    if (slot.kind === 'asset') {
      const asset = slot.assetId ? this.snapshot.assets.get(slot.assetId) : undefined;
      return {
        exists: !!asset,
        durationMs: asset ? itemLengthMs(asset) : null,
        assetType: asset?.type ?? null,
      };
    }
    const categoryId = 'categoryId' in slot ? slot.categoryId : null;
    if (!categoryId) return undefined;
    const category = this.snapshot.categories.get(categoryId);
    if (!category) return { exists: false, durationMs: null, assetType: null };
    const lengths = category.members.map((m) => itemLengthMs(m));
    return {
      exists: true,
      durationMs: lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : null,
      assetType: category.assetType,
    };
  }

  /**
   * One clock instance `[start, end)`, from `from` on (a window may start inside it: slots that
   * nominally end before then are skipped).
   */
  private fillInstance(clock: GeneratorClock, start: number, end: number, from: number) {
    const { slots } = clock;
    const ends = this.offsets(clock);
    const skipBefore = Math.max(0, from - start);
    // An hour without a clock before this one left the cursor behind: jump the hole.
    this.skipTo(Math.max(start, from));
    const anchorOf = (slot: ClockSlot) => (slot.kind === 'marker' ? start + slot.offsetMs : null);
    /** The next marker anchor after slot `i` inside the instance, or its end. */
    const nextAnchor = (i: number) => {
      for (let j = i + 1; j < slots.length; j++) {
        const a = anchorOf(slots[j] as ClockSlot);
        if (a !== null && a >= start && a < end) return a;
      }
      return end;
    };

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i] as ClockSlot;
      if (slot.kind === 'marker') {
        const at = start + slot.offsetMs;
        if (at < Math.max(start, from) || at >= end) continue;
        this.place({
          ...this.blank(clock, i, new Date(at)),
          kind: 'marker',
          plannedDurationMs: 0,
          title: slot.label,
          timing: slot.timing,
          anchorAt: new Date(at),
          capMs: slot.timing === 'soft' ? slot.capMs : null,
        });
        continue;
      }
      if (skipBefore > 0 && start + (ends[i] ?? 0) <= from) continue;
      const limit = nextAnchor(i);
      if (this.cursor >= limit) {
        if (limit >= end) break;
        continue;
      }
      this.fillSlot(clock, i, slot, limit);
    }

    // Slots ran out before the end: repeat the clock's music slots, in order, until it's full.
    const music = slots.flatMap((s, i) => (isMusic(s) ? [i] : []));
    if (end - this.cursor > CLOCK_TOLERANCE_MS) {
      const at = new Date(this.cursor);
      let progress = true;
      while (this.cursor < end && music.length > 0 && progress) {
        progress = false;
        for (const i of music) {
          if (this.cursor >= end) break;
          if (this.fillSlot(clock, i, slots[i] as ClockSlot, end)) progress = true;
        }
      }
      this.issue('underfilled_clock', at, { clockId: clock.id, until: new Date(end) });
    }
  }

  /** Plans one slot at the cursor. Returns whether it placed something. */
  private fillSlot(clock: GeneratorClock, index: number, slot: ClockSlot, limit: number): boolean {
    const at = new Date(this.cursor);
    switch (slot.kind) {
      case 'marker':
        return false;
      case 'category':
      case 'jingle':
      case 'vt':
      case 'fill': {
        // A placeholder, or a promo slot with a VT pool (#60): the hook's to place.
        const poolId = slotPoolId(slot);
        if (slot.kind === 'vt' && (slot.mode === 'placeholder' || poolId !== null)) {
          const placed = this.extensions.placeVoiceTrack?.({
            clockId: clock.id,
            slotIndex: index,
            mode: slot.mode,
            poolId,
            at,
            previous: this.items.at(-1) ?? null,
          });
          if (!placed) {
            this.issue('vt_placeholder', at, { clockId: clock.id, slotIndex: index });
            return false;
          }
          for (const item of placed) this.place(item);
          return placed.length > 0;
        }
        let stretch: number | null = null;
        if (slot.kind === 'fill' && slot.durationMs === null) {
          // Elastic: what's left before the next anchor. Sizing it exactly is back-timing (#46).
          stretch = limit - this.cursor;
          if (stretch <= LOG_TRANSITION_MS) return false;
        }
        const asset = this.pick(clock, index, slot.categoryId, at);
        if (!asset) return false;
        const kind: LogItemKind | null =
          slot.kind === 'category' ? logKindForSlot('category', asset.asset.type) : slot.kind;
        if (!kind) {
          this.issue('unfilled_slot', at, {
            clockId: clock.id,
            slotIndex: index,
            detail: `asset type ${asset.asset.type} has no log item kind`,
          });
          return false;
        }
        const length = itemLengthMs(asset.asset, slot.durationMs);
        if (stretch === null && !this.fits(length, limit)) return false;
        this.history.push(playedFrom(asset.asset, at));
        this.place({
          ...this.blank(clock, index, at),
          kind,
          plannedDurationMs: stretch === null ? length : Math.min(length, stretch),
          assetId: asset.asset.id,
          relaxedRules: asset.relaxed,
        });
        return true;
      }
      case 'asset': {
        const asset = slot.assetId ? this.snapshot.assets.get(slot.assetId) : undefined;
        const kind = asset ? logKindForSlot('asset', asset.type) : null;
        if (!asset || !kind) {
          this.issue('unfilled_slot', at, {
            clockId: clock.id,
            slotIndex: index,
            detail: asset ? `asset type ${asset.type} has no log item kind` : 'asset not found',
          });
          return false;
        }
        const length = itemLengthMs(asset, slot.durationMs);
        if (!this.fits(length, limit)) return false;
        this.history.push(playedFrom(asset, at));
        this.place({
          ...this.blank(clock, index, at),
          kind,
          plannedDurationMs: length,
          assetId: asset.id,
        });
        return true;
      }
      case 'live': {
        const duration = slot.durationMs ?? Math.max(0, limit - this.cursor);
        if (duration <= 0) return false;
        this.place({
          ...this.blank(clock, index, at),
          kind: 'live_slot',
          plannedDurationMs: duration,
          title: slot.label,
        });
        return true;
      }
    }
  }

  /**
   * Whether an item of `length` at the cursor goes before `limit` (the next anchor or the
   * clock's end): yes when it ends by then, or overruns it by less than the gap it would leave
   * out. The residual, at most half an item, is back-timing's to absorb (#46).
   */
  private fits(length: number, limit: number): boolean {
    const over = this.cursor + length - limit;
    return over <= 0 || over < limit - this.cursor;
  }

  private pick(clock: GeneratorClock, index: number, categoryId: string | null, at: Date) {
    const category = categoryId ? this.snapshot.categories.get(categoryId) : undefined;
    if (!category) {
      this.issue('unfilled_slot', at, {
        clockId: clock.id,
        slotIndex: index,
        detail: categoryId ? 'category not found' : 'no category chosen',
      });
      return null;
    }
    const snapshot: PickSnapshot = {
      timeZone: this.snapshot.timeZone,
      rules: this.snapshot.rules,
      history: this.history,
      ...(this.snapshot.lastPlayedAt ? { lastPlayedAt: this.snapshot.lastPlayedAt } : {}),
      seed: this.seed,
      explain: false,
    };
    const result = pickForSlot(snapshot, { at, category, candidates: category.members });
    if (!result.asset) {
      const blocked = result.unfilled?.blockedBy.map((b) => b.kind).join(', ');
      this.issue('unfilled_slot', at, {
        clockId: clock.id,
        slotIndex: index,
        detail:
          result.unfilled?.reason === 'unbreakable_rules'
            ? `every candidate breaks an unbreakable rule (${blocked})`
            : 'no schedulable member',
      });
      return null;
    }
    return { asset: result.asset, relaxed: result.relaxed };
  }

  private blank(clock: GeneratorClock, slotIndex: number, at: Date): PlannedItem {
    return {
      keptId: null,
      kind: 'song',
      plannedDurationMs: 0,
      assetId: null,
      episodeId: null,
      liveSlotId: null,
      title: null,
      timing: 'flow',
      anchorAt: null,
      capMs: null,
      origin: { type: 'clock', clockId: clock.id, slotIndex },
      relaxedRules: [],
      segmentId: null,
      crossOutMs: null,
      start: at,
    };
  }

  private issue(
    code: GeneratorIssue['code'],
    at: Date,
    extra: Omit<GeneratorIssue, 'code' | 'at'> = {},
  ) {
    this.issues.push({ code, at, ...extra });
  }
}

/** Slots that pick music (repeated to top up an underfilled clock). */
function isMusic(slot: ClockSlot): boolean {
  return slot.kind === 'category';
}
