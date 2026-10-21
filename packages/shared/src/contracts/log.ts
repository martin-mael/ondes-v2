import { z } from 'zod';
import { assetTypeSchema } from './library.ts';
import { uuidSchema } from './tenancy.ts';

// The log (#100): every second of a station's day, planned ahead. One `log_day` per station
// and station-local date; its items are ordered by `position` and carry their planned start
// (UTC) and duration. The generator (#50) writes it, the feeder (#29) plays it, as-run (#30)
// reports against it, the timeline (#51) edits it.
//
// Timing is in integer milliseconds everywhere (planned start, duration, anchors, caps): the
// engine works on 20 ms frames (ADR 0003), so milliseconds are exact enough to plan a hard
// start to the frame. Cue overrides are sample positions at `sampleRate`, like the library's
// cues, so island splices stay sample-exact (spike #12).
//
// Play order is `(day.startsAt, position)`, everywhere: the range read, `/now`, the feeder.
// `plannedStart` follows from it (retiming after every write) but can disagree with it when
// an anchored item lands before the previous item ends; the item then carries a `conflict`.
//
// Days chain at local midnight: the first item of a day is implicitly anchored there, like a
// `soft` item (the previous day's last item plays out, then the new day starts). An overrun
// or a gap across midnight shows as a `conflict` on the new day's first item. The feeder plays
// days back to back in play order; it only plays `published` days (a `draft` is a plan being
// edited, and the feeder treats a missing or draft day as no log: safety playlist).

/** The engine's frame, added once per transition between top-level items (ADR 0003). */
export const LOG_TRANSITION_MS = 20;

/** Station-local calendar date, `YYYY-MM-DD`. */
export const localDateSchema = z.iso.date();
export type LocalDate = z.infer<typeof localDateSchema>;

const isoTime = z.iso.datetime({ offset: true });

/**
 * What an item is.
 * - `song`, `vt`, `jingle`, `bed`: an asset of that type.
 * - `episode`: a pre-recorded show episode (asset, plus `episodeId` once shows exist).
 * - `live_slot`: a slot handed to a live presenter (`liveSlotId`); no asset.
 * - `marker`: a zero-duration timing point (top of hour, "news at 12:00"); no media.
 * - `fill`: a filler sized by back-timing (a bed, an instrumental) before a hard start.
 * - `segment`: an island chain played as one engine segment (`POST /v1/segment`, ADR 0002):
 *   its `parts` (2–16 song/vt/jingle/bed/fill items) splice sample-exactly into each other and
 *   the station crossfade only applies into and out of the whole segment.
 */
export const logItemKindSchema = z.enum([
  'song',
  'vt',
  'jingle',
  'bed',
  'episode',
  'live_slot',
  'marker',
  'fill',
  'segment',
]);
export type LogItemKind = z.infer<typeof logItemKindSchema>;

/** Kinds that play an asset. */
export const ASSET_KINDS = ['song', 'vt', 'jingle', 'bed', 'episode', 'fill'] as const;
/** Kinds allowed as parts of a segment. */
export const SEGMENT_PART_KINDS = ['song', 'vt', 'jingle', 'bed', 'fill'] as const;
export const segmentPartKindSchema = z.enum(SEGMENT_PART_KINDS);
export const SEGMENT_MAX_PARTS = 16;

/**
 * How an item's start is decided (ADR 0003).
 * - `flow`: right after the item before it. The default.
 * - `hard`: starts exactly at `anchorAt`; the engine-timed cut fades out whatever is on air.
 * - `soft`: at `anchorAt` the feeder drops the queued items in between; the item starts when
 *   the one on air ends, or at `anchorAt + capMs` at the latest.
 * - `not_before`: never before `anchorAt`; the feeder fills before it, no cut.
 */
export const logItemTimingSchema = z.enum(['flow', 'hard', 'soft', 'not_before']);
export type LogItemTiming = z.infer<typeof logItemTimingSchema>;

/** Where an item comes from. `clock`/`show` items are the generator's; `manual` ones are edits. */
export const logItemOriginSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('clock'),
    /** Nullable until clocks (#47) exist; the fixture uses null. */
    clockId: uuidSchema.nullable(),
    slotIndex: z.int().min(0),
  }),
  z.object({ type: z.literal('show'), showSlotId: uuidSchema.nullable() }),
  z.object({ type: z.literal('manual') }),
]);
export type LogItemOrigin = z.infer<typeof logItemOriginSchema>;

/** A scheduling rule the generator relaxed to fill this item, and why. */
export const relaxedRuleSchema = z.object({
  rule: z.string().min(1).max(100),
  reason: z.string().max(500).optional(),
});
export type RelaxedRule = z.infer<typeof relaxedRuleSchema>;

const samples = z.int().min(0);

/**
 * Per-item overrides of the asset's cues and transitions. Positions and fades are samples at
 * `sampleRate`, which must be the asset's playout copy's rate (`PLAYOUT_SAMPLE_RATE`; the api
 * refuses another rate once the playout file exists). Crossfade overlaps are milliseconds, gain
 * is dB. Unset fields fall back to the asset's cues and the station defaults. On a `segment`,
 * only `crossInMs`/`crossOutMs` apply: the transitions into and out of the whole segment.
 */
export const cueOverridesSchema = z
  .object({
    sampleRate: z.int().positive().optional(),
    cueIn: samples.optional(),
    cueOut: samples.optional(),
    fadeIn: samples.optional(),
    fadeOut: samples.optional(),
    crossInMs: z.int().min(0).max(60_000).optional(),
    crossOutMs: z.int().min(0).max(60_000).optional(),
    gainDb: z.number().min(-60).max(24).optional(),
  })
  .refine(
    (c) =>
      c.sampleRate !== undefined ||
      [c.cueIn, c.cueOut, c.fadeIn, c.fadeOut].every((v) => v === undefined),
    { message: 'sampleRate is required with sample positions', path: ['sampleRate'] },
  )
  .refine((c) => c.cueIn === undefined || c.cueOut === undefined || c.cueOut > c.cueIn, {
    message: 'cueOut must be after cueIn',
    path: ['cueOut'],
  });
export type CueOverrides = z.infer<typeof cueOverridesSchema>;

export const logDayStatusSchema = z.enum(['draft', 'published']);
export type LogDayStatus = z.infer<typeof logDayStatusSchema>;

/**
 * A timing problem retiming found at an anchored item (or a day's first item, anchored at
 * midnight): `overrun` = the items before it end `ms` after its anchor (they get cut or
 * overlap it); `gap` = they end `ms` before it (back-timing, #46, should fill it).
 */
export const logTimingConflictSchema = z.object({
  kind: z.enum(['overrun', 'gap']),
  ms: z.int().positive(),
});
export type LogTimingConflict = z.infer<typeof logTimingConflictSchema>;

// --- Read DTOs ---------------------------------------------------------------------------

export const logDaySchema = z.object({
  id: uuidSchema,
  stationId: uuidSchema,
  localDate: localDateSchema,
  /** The local day as a UTC range: 23, 24 or 25 hours long. */
  startsAt: isoTime,
  endsAt: isoTime,
  /** The feeder plays `published` days only. */
  status: logDayStatusSchema,
  /** Bumped on every change to the day or its items. Cache sync keys on `logDayId:version`. */
  version: z.int().min(1),
  generatedAt: isoTime.nullable(),
  seed: z.string().nullable(),
  generatorVersion: z.string().nullable(),
});
export type LogDay = z.infer<typeof logDaySchema>;

/** The asset an item plays, enough to render a row and feed the engine's ICY metadata. */
export const logAssetSummarySchema = z.object({
  id: uuidSchema,
  type: assetTypeSchema,
  title: z.string(),
  artists: z.array(z.string()),
  durationMs: z.int().nullable(),
});
export type LogAssetSummary = z.infer<typeof logAssetSummarySchema>;

const logItemFields = {
  id: uuidSchema,
  logDayId: uuidSchema,
  /** Order in the day, from 0. Segment parts are numbered right after their segment. */
  position: z.int().min(0),
  kind: logItemKindSchema,
  /** Planned start, UTC with millisecond precision. */
  plannedStart: isoTime,
  /**
   * How long the item occupies the log, in ms. For a top-level item: the ADR 0003 slot, what it
   * plays minus its overlap with the next item plus `LOG_TRANSITION_MS`; the next `flow` item
   * starts at `plannedStart + plannedDurationMs`. For a `segment`: computed, the sum of its
   * parts minus its `crossOutMs` plus `LOG_TRANSITION_MS` (one transition, out of the segment).
   * For a segment part: its raw length (cue-out minus cue-in), with no transition: island
   * joins are sample-exact splices, not crossfades.
   */
  plannedDurationMs: z.int().min(0),
  assetId: uuidSchema.nullable(),
  /** Null when the item has no asset, or its asset was deleted (show it as missing). */
  asset: logAssetSummarySchema.nullable(),
  episodeId: uuidSchema.nullable(),
  liveSlotId: uuidSchema.nullable(),
  title: z.string().nullable(),
  cueOverrides: cueOverridesSchema.nullable(),
  timing: logItemTimingSchema,
  /** The time a non-`flow` item is anchored to. */
  anchorAt: isoTime.nullable(),
  /** `soft` only: how late after `anchorAt` the item may start. */
  capMs: z.int().min(0).nullable(),
  origin: logItemOriginSchema,
  /** Locked items are kept by the generator and refused by manual edits until unlocked. */
  locked: z.boolean(),
  relaxedRules: z.array(relaxedRuleSchema),
  /** The segment this item is a part of. */
  segmentId: uuidSchema.nullable(),
  /** Set by retiming on anchored items and on a day's first item; null on parts. */
  conflict: logTimingConflictSchema.nullable(),
};

export const logSegmentPartSchema = z.object(logItemFields);
export type LogSegmentPart = z.infer<typeof logSegmentPartSchema>;

export const logItemSchema = z.object({
  ...logItemFields,
  /** `segment` only: its parts in play order. Empty for every other kind. */
  parts: z.array(logSegmentPartSchema),
});
export type LogItem = z.infer<typeof logItemSchema>;

export const LOG_RANGE_MAX_MS = 8 * 24 * 3600 * 1000;

/** `GET …/log?from&to`: query. A range of at most 8 days. */
export const logRangeQuerySchema = z
  .object({ from: isoTime, to: isoTime })
  .refine((q) => Date.parse(q.to) > Date.parse(q.from), {
    message: 'to must be after from',
    path: ['to'],
  })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= LOG_RANGE_MAX_MS, {
    message: 'range is longer than 8 days',
    path: ['to'],
  });
export type LogRangeQuery = z.infer<typeof logRangeQuerySchema>;

/**
 * `GET …/log?from&to`: the days the range touches, and every top-level item that overlaps it
 * (`plannedStart < to` and `plannedStart + plannedDurationMs > from`, or a marker at `from`),
 * in play order.
 */
export const logRangeResponseSchema = z.object({
  from: isoTime,
  to: isoTime,
  days: z.array(logDaySchema),
  items: z.array(logItemSchema),
});
export type LogRangeResponse = z.infer<typeof logRangeResponseSchema>;

/** `GET …/log/now`: query. `at` defaults to the server's clock (handy against the fixture). */
export const logNowQuerySchema = z.object({
  at: isoTime.optional(),
  next: z.coerce.number().int().min(0).max(50).default(5),
});
export type LogNowQuery = z.input<typeof logNowQuerySchema>;

export const logNowResponseSchema = z.object({
  at: isoTime,
  /**
   * The planned item at `at`: the last item in play order whose planned range contains `at`
   * (with an overrun, the later item wins, as the plan has it start there). Null in a gap or
   * outside any log. It is the plan, not the as-run (#30).
   */
  current: logItemSchema.nullable(),
  /**
   * The items after `current` in play order. Without a current item: from the first item in
   * play order planned at or after `at` (a marker exactly at `at` included).
   */
  next: z.array(logItemSchema),
});
export type LogNowResponse = z.infer<typeof logNowResponseSchema>;

// --- Edit DTOs ---------------------------------------------------------------------------

const timingInput = {
  timing: logItemTimingSchema.default('flow'),
  anchorAt: isoTime.nullish(),
  capMs: z.int().min(0).max(3_600_000).nullish(),
};

const refineTiming = <T extends { timing: LogItemTiming; anchorAt?: string | null }>(v: T) =>
  v.timing === 'flow' ? !v.anchorAt : !!v.anchorAt;

const partInputSchema = z.object({
  kind: segmentPartKindSchema,
  assetId: uuidSchema,
  /** Raw length in ms (cue-out minus cue-in): no transition time inside a segment. */
  plannedDurationMs: z.int().min(0),
  title: z.string().max(300).nullish(),
  cueOverrides: cueOverridesSchema.nullish(),
});
export type LogSegmentPartInput = z.input<typeof partInputSchema>;

/**
 * An item to insert or a replacement. Rules per kind:
 * - asset kinds need `assetId`; `marker` has duration 0; `segment` has 2–16 `parts` and
 *   its duration is computed from them (see `plannedDurationMs`; the input value is ignored);
 * - `timing` other than `flow` needs `anchorAt`, `flow` must not have one; `capMs` is `soft` only.
 *   The anchor must fall inside the item's local day (`startsAt <= anchorAt < endsAt`), or 422.
 * Manual items get `origin: manual`; `relaxedRules` are the generator's.
 */
export const logItemInputSchema = z
  .object({
    kind: logItemKindSchema,
    plannedDurationMs: z
      .int()
      .min(0)
      .max(24 * 3600 * 1000)
      .default(0),
    assetId: uuidSchema.nullish(),
    episodeId: uuidSchema.nullish(),
    liveSlotId: uuidSchema.nullish(),
    title: z.string().max(300).nullish(),
    cueOverrides: cueOverridesSchema.nullish(),
    ...timingInput,
    locked: z.boolean().default(false),
    parts: z.array(partInputSchema).max(SEGMENT_MAX_PARTS).optional(),
  })
  .refine(refineTiming, {
    message: 'anchorAt is required for hard, soft and not_before timing, and only for them',
    path: ['anchorAt'],
  })
  .refine((v) => v.capMs == null || v.timing === 'soft', {
    message: 'capMs only applies to soft timing',
    path: ['capMs'],
  })
  .refine((v) => !(ASSET_KINDS as readonly string[]).includes(v.kind) || !!v.assetId, {
    message: 'this kind needs an assetId',
    path: ['assetId'],
  })
  .refine((v) => v.kind !== 'marker' || v.plannedDurationMs === 0, {
    message: 'a marker has no duration',
    path: ['plannedDurationMs'],
  })
  .refine((v) => (v.kind === 'segment' ? (v.parts?.length ?? 0) >= 2 : v.parts === undefined), {
    message: 'a segment has 2 to 16 parts; other kinds have none',
    path: ['parts'],
  });
export type LogItemInput = z.input<typeof logItemInputSchema>;
export type ParsedLogItemInput = z.output<typeof logItemInputSchema>;

/** Where an inserted or moved item goes: next to an item, or at the end of a local day. */
export const logPlacementSchema = z.union([
  z.object({ after: uuidSchema }),
  z.object({ before: uuidSchema }),
  z.object({ localDate: localDateSchema }),
]);
export type LogPlacement = z.infer<typeof logPlacementSchema>;

/** `POST …/log/items`. Inserting into a day that has no log yet creates it as a draft. */
export const insertLogItemSchema = z.object({
  placement: logPlacementSchema,
  item: logItemInputSchema,
});
export type InsertLogItem = z.input<typeof insertLogItemSchema>;

/** `PUT …/log/items/:itemId`: replaces the item's content, keeping its place. */
export const replaceLogItemSchema = logItemInputSchema;
export type ReplaceLogItem = z.input<typeof replaceLogItemSchema>;

/** `POST …/log/items/:itemId/move`. */
export const moveLogItemSchema = z.object({ placement: logPlacementSchema });
export type MoveLogItem = z.input<typeof moveLogItemSchema>;

/** `PUT …/log/items/:itemId/lock`. */
export const lockLogItemSchema = z.object({ locked: z.boolean() });
export type LockLogItem = z.input<typeof lockLogItemSchema>;

/** Response of every edit: the item as it is now (null once deleted) and the days it touched. */
export const logEditResultSchema = z.object({
  item: logItemSchema.nullable(),
  days: z.array(logDaySchema),
});
export type LogEditResult = z.infer<typeof logEditResultSchema>;

export const logItemChangeSchema = z.enum([
  'inserted',
  'replaced',
  'moved',
  'deleted',
  'locked',
  'unlocked',
]);
export type LogItemChange = z.infer<typeof logItemChangeSchema>;

/** Why a log changed, in `log.updated`. */
export const logUpdateCauseSchema = z.enum(['edit', 'status', 'generate', 'fixture']);
export type LogUpdateCause = z.infer<typeof logUpdateCauseSchema>;

/** `PUT …/log/days/:localDate/status`: publish a day (the feeder plays it) or take it back. */
export const setLogDayStatusSchema = z.object({ status: logDayStatusSchema });
export type SetLogDayStatus = z.input<typeof setLogDayStatusSchema>;

export const logDayResponseSchema = z.object({ day: logDaySchema });
