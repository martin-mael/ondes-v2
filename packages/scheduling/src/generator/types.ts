import type {
  ClockSlot,
  LocalDate,
  LogItemKind,
  LogItemOrigin,
  LogItemTiming,
  LogTimingConflict,
  RelaxedRule,
  RotationRule,
  SlotType,
  VtSlotMode,
} from '@ondes/shared';
import type { ClockGrid } from '../grid/index.ts';
import type { PickCandidate, PickCategory, PlayedItem } from '../rules/index.ts';

// The log generator's input and output (#50, ADR 0026). The input is a snapshot of everything
// a station's days depend on, loaded once (`@ondes/db` `loadGeneratorSnapshot`); the output is
// the day's items in play order, with their planned times, plus what the generator could not
// do. No I/O: the same snapshot and seed always give the same day.

/** Bumped when the same snapshot and seed would give a different day. Stored on `log_day`. */
export const GENERATOR_VERSION = '2';

/** A library asset as the generator sees it: what the rules read, and how long it plays. */
export interface GeneratorAsset extends PickCandidate {
  /** What it plays (cue-out − cue-in), in ms; falls back to `durationMs` when null. */
  playMs: number | null;
  /** Its natural overlap into the next item (cue-out − cross-start-next), in ms. */
  overlapMs: number;
}

/** A category with its members resolved at generation time (`resolveCategory`). */
export interface GeneratorCategory extends PickCategory {
  /** In library order; members not schedulable at a slot's time are skipped by the picker. */
  members: readonly GeneratorAsset[];
}

export interface GeneratorClock {
  id: string;
  targetDurationMs: number;
  slots: readonly ClockSlot[];
}

/** The episode an occurrence airs: the premiere, or the episode a rerun plays again. */
export interface GeneratorEpisode {
  id: string;
  title: string | null;
  /** Null when its audio isn't there yet. */
  asset: GeneratorAsset | null;
}

/** One show occurrence (`expandSlots`), with what it airs. */
export interface GeneratorOccurrence {
  slotId: string;
  showId: string;
  showName: string;
  type: SlotType;
  /** The occurrence's original local date (its identity, ADR 0014). */
  date: LocalDate;
  startsAt: Date;
  durationMs: number;
  /** A one-off slot or a moved occurrence: it wins over a recurring one it collides with. */
  special: boolean;
  /**
   * `prerecorded`: the premiere planned for the occurrence; `rerun`: the episode it plays again
   * (#48); null when there is none. Always null for `live`.
   */
  episode: GeneratorEpisode | null;
  /**
   * How it takes the air (#46): `hard` at its start (the default), or `soft`, at most `capMs`
   * late. Absent = hard.
   */
  startPolicy?: { mode: 'hard' | 'soft'; capMs: number | null };
}

/** Why an existing item survives a regeneration with its id. */
export type KeptReason = 'locked' | 'segue' | 'fallback';

/**
 * An item of the day being regenerated that is kept as it is, with its id: locked items,
 * both ends of a segue (ADR 0017: new ids would detach it), and items carrying a missing-episode
 * fallback mark (ADR 0022). Only its position and planned start can change. Segment parts
 * follow their segment.
 */
export interface KeptItem {
  id: string;
  kind: LogItemKind;
  plannedStart: Date;
  plannedDurationMs: number;
  timing: LogItemTiming;
  anchorAt: Date | null;
  segmentId: string | null;
  /** `segment` only: its outgoing overlap (`cueOverrides.crossOutMs`). */
  crossOutMs: number | null;
  /** The show slot it stands for: its `origin_show_slot_id`, or its fallback mark's slot. */
  showSlotId: string | null;
  reasons: readonly KeptReason[];
  /** What it plays, for the rules; null for items without an asset. */
  played: PlayedItem | null;
}

export interface GeneratorSnapshot {
  stationId: string;
  timeZone: string;
  grid: ClockGrid;
  clocks: ReadonlyMap<string, GeneratorClock>;
  categories: ReadonlyMap<string, GeneratorCategory>;
  /** Assets that `asset` clock slots name. */
  assets: ReadonlyMap<string, GeneratorAsset>;
  rules: readonly RotationRule[];
  /** As-run and planned items around the days to generate, outside them. Any order. */
  history: readonly PlayedItem[];
  /** Last airing per asset older than `history`. */
  lastPlayedAt?: ReadonlyMap<string, Date>;
  /** Every occurrence overlapping the days to generate. */
  occurrences: readonly GeneratorOccurrence[];
  /** Kept items per local date, in play order. */
  kept?: ReadonlyMap<LocalDate, readonly KeptItem[]>;
  /** Where the day before the first generated one ends (its last item), if it has a log. */
  previousDayEnd?: Date | null;
}

/** A planned item, before retiming. `start` is where the generator meant it to go. */
export interface PlannedItem {
  /** Set for a kept item: it is written back with this id, untouched but for its timing. */
  keptId: string | null;
  kind: LogItemKind;
  plannedDurationMs: number;
  assetId: string | null;
  episodeId: string | null;
  liveSlotId: string | null;
  title: string | null;
  timing: LogItemTiming;
  anchorAt: Date | null;
  capMs: number | null;
  origin: LogItemOrigin;
  relaxedRules: RelaxedRule[];
  /** Kept segment parts only. */
  segmentId: string | null;
  /** Kept segments only. */
  crossOutMs: number | null;
  /** The intended start, used to place the item and to report gaps. */
  start: Date;
}

/** An item of the generated day, retimed like the log does (ADR 0003, `retime`). */
export interface GeneratedItem extends PlannedItem {
  position: number;
  plannedStart: Date;
  conflict: LogTimingConflict | null;
}

/**
 * Something the generator couldn't do. None stops it: a day is always generated, and the
 * caller reports these (job log, alert).
 * - `no_clock`: an hour the grid leaves without a clock (`source: 'none'`, ADR 0020).
 * - `unknown_clock`: the grid names a clock that isn't in the snapshot.
 * - `unfilled_slot`: the picker found nothing (empty category, unbreakable rules, missing
 *   reference); `detail` says why.
 * - `underfilled_clock`: a clock's slots ran out before its end; its music slots were repeated.
 * - `episode_missing`: a pre-recorded or rerun occurrence planned without audio (an empty
 *   `episode` item, which the missing-episode check fills, ADR 0022).
 * - `occurrence_dropped`: an occurrence lost to another one at the same time (or to a kept item).
 * - `occurrence_overlap`: two occurrences overlap in part; both are planned, and retiming
 *   reports the overrun on the later one.
 * - `vt_placeholder`: a voice-track placeholder slot nothing placed (#60's extension point).
 */
export type GeneratorIssueCode =
  | 'no_clock'
  | 'unknown_clock'
  | 'unfilled_slot'
  | 'underfilled_clock'
  | 'episode_missing'
  | 'occurrence_dropped'
  | 'occurrence_overlap'
  | 'vt_placeholder';

export interface GeneratorIssue {
  code: GeneratorIssueCode;
  at: Date;
  /** End of the range concerned (`no_clock`, `underfilled_clock`). */
  until?: Date;
  clockId?: string;
  slotIndex?: number;
  showSlotId?: string;
  detail?: string;
}

export interface GeneratedDay {
  localDate: LocalDate;
  startsAt: Date;
  endsAt: Date;
  seed: string;
  generatorVersion: string;
  items: GeneratedItem[];
  issues: GeneratorIssue[];
}

// --- Extension points ----------------------------------------------------------------------

/** What the generator knows when it reaches an anchored item. */
export interface AnchorContext {
  /** The anchored item: a show occurrence or a clock marker. */
  anchor: PlannedItem;
  /** The items planned since the previous anchor (or the window start), in order. */
  run: readonly PlannedItem[];
  /** Where the run ends as planned (the last item's start plus its duration). */
  runEndsAt: Date;
  /** Picks under the rotation rules, for a hook that re-plans the run (#46). */
  tools: AnchorTools;
}

/**
 * What `beforeAnchor` may use to change the run with the rules still applying (#46).
 * - `pick`: an asset of `categoryId` for a slot at `at`, among the members `accept` lets
 *   through, picked like any slot (rotation order, rules, relaxation). The pick joins the
 *   rules' history, so later picks see it. Null when nothing is accepted.
 * - `release`: takes a run item's pick (its asset at its `start`) out of the history, for an
 *   item the hook drops or replaces, so the rules don't count a play that won't happen.
 */
export interface AnchorTools {
  pick(request: {
    categoryId: string;
    at: Date;
    accept: (asset: GeneratorAsset) => boolean;
  }): { asset: GeneratorAsset; relaxedRules: RelaxedRule[] } | null;
  release(item: PlannedItem): void;
}

/** A `vt` placeholder slot of a clock (`mode: 'placeholder'`). */
export interface VtPlacementContext {
  clockId: string;
  slotIndex: number;
  mode: VtSlotMode;
  /** Where the slot falls. */
  at: Date;
  /** The item before it in the run, if any. */
  previous: PlannedItem | null;
}

/**
 * Hooks for the work split out of #50. Each defaults to doing nothing.
 * - `beforeAnchor` (#46, hard-start fill and back-timing): returns the run to plan before an
 *   anchored item instead of `run`, e.g. a flexible last song (`cueOverrides`) and a sized bed.
 * - `placeVoiceTrack` (#60, VT placement): items to plan for a voice-track placeholder slot.
 *   Voice tracks are segue lanes (ADR 0017), so a placement may return nothing and add segues
 *   after the day is written; an unhandled placeholder is reported as `vt_placeholder`.
 */
export interface GeneratorExtensions {
  beforeAnchor?(context: AnchorContext): PlannedItem[];
  placeVoiceTrack?(context: VtPlacementContext): PlannedItem[] | null;
}

export interface GenerateOptions {
  /** Default `<stationId>:<localDate>`. */
  seed?: string;
  extensions?: GeneratorExtensions;
}
