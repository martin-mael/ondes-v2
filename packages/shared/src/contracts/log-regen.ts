import { z } from 'zod';
import {
  type LocalDate,
  localDateSchema,
  logAssetSummarySchema,
  logDayStatusSchema,
  logItemKindSchema,
  logItemOriginSchema,
  logItemTimingSchema,
  logTimingConflictSchema,
  relaxedRuleSchema,
} from './log.ts';
import { uuidSchema } from './tenancy.ts';

// Log regeneration (#101, ADR 0030): a rolling horizon of generated days, regenerating a range
// around what must stay (aired and imminent items, locked items, manual edits), a dry-run with
// a diff against the current log, and debounced regeneration when the schedule changes. The
// generator itself is #50's (`contracts/log-generate.ts`, ADR 0026).

const isoTime = z.iso.datetime({ offset: true });

/** Days of log kept generated ahead, today included. */
export const LOG_HORIZON_DEFAULT_DAYS = 14;
export const LOG_HORIZON_MAX_DAYS = 56;
/** A dry-run is computed by the api while the request waits: one week at most. */
export const LOG_REGEN_PREVIEW_MAX_DAYS = 7;
/** Applying regenerates at most this many days per request (in jobs of 14). */
export const LOG_REGEN_MAX_DAYS = LOG_HORIZON_MAX_DAYS;

// --- Settings ------------------------------------------------------------------------------

/** `GET/PUT …/log/regen/settings`: a station's horizon. */
export const logRegenSettingsSchema = z.object({
  /** How many days, from today, are kept generated. A nightly pass adds the next one. */
  horizonDays: z.int().min(1).max(LOG_HORIZON_MAX_DAYS),
  /** Status of the days the horizon creates. Existing days keep theirs. */
  newDayStatus: logDayStatusSchema,
});
export type LogRegenSettings = z.infer<typeof logRegenSettingsSchema>;

export const LOG_REGEN_DEFAULT_SETTINGS: LogRegenSettings = {
  horizonDays: LOG_HORIZON_DEFAULT_DAYS,
  newDayStatus: 'draft',
};

// --- Requests ------------------------------------------------------------------------------

const dayCount = (from: LocalDate, to: LocalDate) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

const rangeShape = {
  /** First station-local date to regenerate. Days before today are refused. */
  from: localDateSchema,
  /** Last date, included. */
  to: localDateSchema,
  /** Default per day: `<stationId>:<localDate>` (the job's default). */
  seed: z.string().min(1).max(100).optional(),
};

const checkRange =
  (max: number) =>
  (r: { from: LocalDate; to: LocalDate }, ctx: z.RefinementCtx): void => {
    if (r.to < r.from) {
      ctx.addIssue({ code: 'custom', message: 'to must not be before from', path: ['to'] });
    } else if (dayCount(r.from, r.to) > max) {
      ctx.addIssue({ code: 'custom', message: `at most ${max} days`, path: ['to'] });
    }
  };

/** `POST …/log/regen/preview`: the dry-run. Nothing is written. */
export const logRegenPreviewRequestSchema = z
  .object(rangeShape)
  .superRefine(checkRange(LOG_REGEN_PREVIEW_MAX_DAYS));
export type LogRegenPreviewRequest = z.infer<typeof logRegenPreviewRequestSchema>;

/**
 * `POST …/log/regen`: regenerate the range (worker jobs; `log.updated` cause `generate` when
 * they're written). `expectedVersions` (from a preview) refuses with 409 when a day changed
 * since: its value is the day's version, or null for a day that didn't exist.
 */
export const logRegenRequestSchema = z
  .object({
    ...rangeShape,
    expectedVersions: z.record(localDateSchema, z.int().min(1).nullable()).optional(),
  })
  .superRefine(checkRange(LOG_REGEN_MAX_DAYS));
export type LogRegenRequest = z.infer<typeof logRegenRequestSchema>;

export const logRegenResponseSchema = z.object({
  /** The dates queued for regeneration (today's items before the freeze point stay). */
  localDates: z.array(localDateSchema),
  jobs: z.int().min(0),
});
export type LogRegenResponse = z.infer<typeof logRegenResponseSchema>;

// --- Dry-run and diff ----------------------------------------------------------------------

/** What the generator couldn't do (`@ondes/scheduling` `GeneratorIssueCode`). */
export const generatorIssueCodeSchema = z.enum([
  'no_clock',
  'unknown_clock',
  'unfilled_slot',
  'underfilled_clock',
  'episode_missing',
  'occurrence_dropped',
  'occurrence_overlap',
  'vt_placeholder',
]);
export type GeneratorIssueCode = z.infer<typeof generatorIssueCodeSchema>;

export const generatorIssueSchema = z.object({
  code: generatorIssueCodeSchema,
  at: isoTime,
  until: isoTime.optional(),
  clockId: uuidSchema.optional(),
  slotIndex: z.int().min(0).optional(),
  showSlotId: uuidSchema.optional(),
  detail: z.string().max(500).optional(),
});
export type GeneratorIssueDto = z.infer<typeof generatorIssueSchema>;

/** One item of a hypothetical or current log, as the diff shows it. */
export const logDiffItemSchema = z.object({
  /** The current item's id; null for an item the regeneration would create. */
  id: uuidSchema.nullable(),
  kind: logItemKindSchema,
  plannedStart: isoTime,
  plannedDurationMs: z.int().min(0),
  assetId: uuidSchema.nullable(),
  asset: logAssetSummarySchema.nullable(),
  episodeId: uuidSchema.nullable(),
  liveSlotId: uuidSchema.nullable(),
  title: z.string().nullable(),
  timing: logItemTimingSchema,
  origin: logItemOriginSchema,
  relaxedRules: z.array(relaxedRuleSchema),
  conflict: logTimingConflictSchema.nullable(),
});
export type LogDiffItem = z.infer<typeof logDiffItemSchema>;

/**
 * Why a current item stays through a regeneration:
 * - `past`: it starts before the freeze point (aired, on air, or already with the feeder);
 * - `manual`: a manual edit (`origin: manual`);
 * - `locked`, `segue` (an end of a segue, ADR 0017), `fallback` (a missing-episode mark, ADR 0022).
 */
export const keptReasonSchema = z.enum(['past', 'manual', 'locked', 'segue', 'fallback']);
export type KeptReasonDto = z.infer<typeof keptReasonSchema>;

export const logDiffDaySchema = z.object({
  localDate: localDateSchema,
  /** The current day, null when it doesn't exist yet. */
  logDayId: uuidSchema.nullable(),
  version: z.int().min(1).nullable(),
  /** `unchanged`: regenerating would write nothing (no new version). */
  change: z.enum(['new', 'changed', 'unchanged']),
  /** Items in the regenerated day that aren't in the current one. */
  added: z.array(logDiffItemSchema),
  /** Current items the regeneration drops. */
  removed: z.array(logDiffItemSchema),
  /** The same item (same kind, what it plays, where it comes from) at another time. */
  moved: z.array(
    z.object({ item: logDiffItemSchema, fromStart: isoTime, shiftMs: z.int() }),
  ),
  /** Regenerated items that broke rotation rules; `new` when the current item didn't. */
  relaxed: z.array(z.object({ item: logDiffItemSchema, new: z.boolean() })),
  /** Current items that stay as they are, per reason (an item counts once, first reason). */
  kept: z.partialRecord(keptReasonSchema, z.int().min(0)),
  unchangedCount: z.int().min(0),
  /** The hypothetical day, in play order (top-level items). */
  items: z.array(logDiffItemSchema),
  issues: z.array(generatorIssueSchema),
});
export type LogDiffDay = z.infer<typeof logDiffDaySchema>;

export const logRegenPreviewResponseSchema = z.object({
  /** Items starting before this time stay as they are. */
  frozenUntil: isoTime,
  days: z.array(logDiffDaySchema),
  totals: z.object({
    added: z.int().min(0),
    removed: z.int().min(0),
    moved: z.int().min(0),
    relaxed: z.int().min(0),
    issues: z.int().min(0),
  }),
});
export type LogRegenPreviewResponse = z.infer<typeof logRegenPreviewResponseSchema>;

// --- Events and jobs -----------------------------------------------------------------------

/** What changed in a station's schedule (`schedule.changed`). */
export const scheduleAreaSchema = z.enum([
  'clocks',
  'grid',
  'categories',
  'rules',
  'shows',
  'horizon',
]);
export type ScheduleArea = z.infer<typeof scheduleAreaSchema>;

export const scheduleChangedDataSchema = z.object({
  orgId: uuidSchema,
  areas: z.array(scheduleAreaSchema).min(1),
  /** First local date the change can affect; null: from today. */
  from: localDateSchema.nullable(),
});

/** At most this many issues per day ride on `log.generated`; `issueCounts` has them all. */
export const LOG_GENERATED_MAX_ISSUES = 50;

export const logGeneratedDataSchema = z.object({
  orgId: uuidSchema,
  days: z.array(
    z.object({
      logDayId: uuidSchema,
      localDate: localDateSchema,
      version: z.int().min(1),
      /** False when the day was regenerated to the same items (nothing written). */
      changed: z.boolean(),
      issueCounts: z.partialRecord(generatorIssueCodeSchema, z.int().min(1)),
      issues: z.array(generatorIssueSchema).max(LOG_GENERATED_MAX_ISSUES),
    }),
  ),
});
export type LogGeneratedData = z.infer<typeof logGeneratedDataSchema>;

/**
 * `log-horizon` (worker, `bulk` lane): brings a station's generated horizon up to date. With
 * `change`, it first records a schedule change (debounced, ADR 0030). Then it generates the
 * horizon's missing days and, once a recorded change is due, regenerates from its first date.
 */
export const LOG_HORIZON_JOB = 'log-horizon';
export const logHorizonJobPayloadSchema = z.object({
  orgId: uuidSchema,
  stationId: uuidSchema,
  change: z
    .object({
      eventId: z.uuid(),
      at: isoTime,
      areas: z.array(scheduleAreaSchema).min(1),
      from: localDateSchema.nullable(),
    })
    .optional(),
});
export type LogHorizonJobPayload = z.infer<typeof logHorizonJobPayloadSchema>;
