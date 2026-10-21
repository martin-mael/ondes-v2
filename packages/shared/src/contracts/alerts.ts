import { z } from 'zod';
import { uuidSchema } from './tenancy.ts';

// Alerts (#33): a generic, station-scoped alert model that other modules reuse. Mirrors
// packages/db/src/schema/alerts.ts. Modules add alert *types* (open strings, see
// `alertTypeSchema`); they don't reshape the alert.
//
// Lifecycle: raised -> (escalated) -> resolved, and reopened when the same problem comes back
// within the reopen window (flapping). Acknowledging is orthogonal: a user says "I'm on it"
// while the alert stays open; escalation still raises the severity, but sends no email for
// an acknowledged alert. At most one open alert per (station, dedupe key): raising it again
// counts an occurrence instead of opening a second one.

export const alertSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type AlertSeverity = z.infer<typeof alertSeveritySchema>;

/** Severity order, for escalation: a raise or an escalation only ever goes up. */
export const alertSeverityRank: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export const alertStatusSchema = z.enum(['open', 'resolved']);
export type AlertStatus = z.infer<typeof alertStatusSchema>;

/**
 * `<domain>.<what>`, lower case: `engine.silence`, `engine.down`, `icecast.mount_down`.
 * Open on purpose: a module adds a type without a contract change. Known ones are listed in
 * `alertTypes`.
 */
export const alertTypeSchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, 'expected <domain>.<what>');
export type AlertType = z.infer<typeof alertTypeSchema>;

/** Alert types raised by the app. Add yours here (additive). */
export const alertTypes = {
  /** Silence on the program output for longer than the station's threshold (#33). */
  silence: 'engine.silence',
  /** The engine stopped answering its health probe (#33, from #28's monitor). */
  engineDown: 'engine.down',
  /** The lifecycle stopped restarting a crash-looping engine (#35): it stays down. */
  engineRestartStorm: 'engine.restart_storm',
  /** An Icecast mount has no source: listeners hear the fallback (#32). `details.mount`. */
  streamSourceMissing: 'stream.source_missing',
  /** A station's outputs fail validation; Icecast keeps the last good mounts (#32). */
  streamConfigInvalid: 'stream.config_invalid',
  /** Icecast's stats endpoint failed several polls in a row (#32). */
  streamIcecastUnreachable: 'stream.icecast_unreachable',
  /** A log item starting within the hour isn't in the playout cache (#31). One per item. */
  cacheItemMissing: 'cache.item_missing',
  /** Something in the next 6 h isn't cached; `details.pctAirTime`, `firstMissingAt` (#31). */
  cacheHorizonDegraded: 'cache.horizon_degraded',
  /** The horizon doesn't fit the station's cache budget: some files wait (#31). */
  cacheBudgetExceeded: 'cache.budget_exceeded',
  /** A file the horizon needs isn't in storage (#31). One per file. */
  cacheSourceMissing: 'cache.source_missing',
  /** A stored file doesn't match its hash (#31). One per file. */
  cacheChecksumMismatch: 'cache.checksum_mismatch',
  /** The cache disk is under its free-space reserve: fetching paused (#31). */
  cacheDiskLow: 'cache.disk_low',
  /** The station's last cache-sync pass failed (`details.error`): nothing is being fetched (#31). */
  cacheSyncFailing: 'cache.sync_failing',
  /**
   * The feeder passes over log items it can't play (not in the playout cache, or refused by the
   * engine) in its window; `details.items` (#29). One per station, resolved once none is left.
   */
  feederItemsSkipped: 'feeder.items_skipped',
  /** Nothing from the log is queued or coming: the safety playlist plays (#29). */
  feederLogEmpty: 'feeder.log_empty',
} as const;

/**
 * An automatic action attached to an alert (e.g. `engine.skip` on silence). Recorded in the
 * database before it runs, then claimed and run once by an api replica that can run it.
 * - `pending`: to run. `running`: claimed. `done` / `failed`: outcome of the last attempt.
 * A `failed` action is retried once when the alert escalates; a `done` one isn't repeated.
 */
export const alertActionStateSchema = z.enum(['pending', 'running', 'done', 'failed']);
export const alertActionSchema = z.object({
  name: z.string().min(1).max(100),
  state: alertActionStateSchema,
  attempts: z.int().nonnegative(),
  error: z.string().nullable(),
  updatedAt: z.date(),
});
export type AlertAction = z.infer<typeof alertActionSchema>;

/** Free-form context for the dashboard and emails (counts, ids, boot ids). */
export const alertDetailsSchema = z.record(z.string(), z.unknown());
export type AlertDetails = z.infer<typeof alertDetailsSchema>;

export const alertSchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  stationId: uuidSchema,
  type: alertTypeSchema,
  severity: alertSeveritySchema,
  status: alertStatusSchema,
  /** Same key, same problem: e.g. `engine.silence`, or `icecast.mount:main.mp3`. */
  dedupeKey: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  message: z.string().max(2000).nullable(),
  details: alertDetailsSchema,
  /** How many times it was raised while open (1 = once). */
  occurrences: z.int().positive(),
  raisedAt: z.date(),
  lastSeenAt: z.date(),
  escalatedAt: z.date().nullable(),
  /** Pending time-based escalation, if any. */
  escalateAt: z.date().nullable(),
  escalateTo: alertSeveritySchema.nullable(),
  acknowledgedAt: z.date().nullable(),
  acknowledgedBy: uuidSchema.nullable(),
  resolvedAt: z.date().nullable(),
  /** Why it closed: `recovered`, `engine_restarted`, ... */
  resolution: z.string().max(200).nullable(),
  action: alertActionSchema.nullable(),
});
export type Alert = z.infer<typeof alertSchema>;

/** What a module passes to `raiseAlert`. */
export const raiseAlertSchema = z.object({
  type: alertTypeSchema,
  severity: alertSeveritySchema,
  dedupeKey: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  message: z.string().max(2000).optional(),
  details: alertDetailsSchema.optional(),
  /** Escalate to `to` if still open (acknowledged or not) after `afterSeconds`. */
  escalate: z
    .object({ afterSeconds: z.int().min(1).max(86_400), to: alertSeveritySchema })
    .optional(),
  /**
   * Automatic action to run once when the alert opens (or reopens), by name; the module that
   * raises it registers the runner (see the api's alert service).
   */
  action: z.string().min(1).max(100).optional(),
});
export type RaiseAlert = z.input<typeof raiseAlertSchema>;

// --- API ---------------------------------------------------------------------------------

export const listAlertsQuerySchema = z.object({
  /** Default `open`. */
  status: z.enum(['open', 'resolved', 'all']).default('open'),
  type: alertTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Cursor: alerts raised strictly before this alert (its id, from the previous page). */
  before: uuidSchema.optional(),
});
export type ListAlertsQuery = z.input<typeof listAlertsQuerySchema>;

export const alertListSchema = z.object({
  items: z.array(alertSchema),
  /** Pass as `before` for the next page; null on the last one. */
  nextCursor: uuidSchema.nullable(),
});
export type AlertList = z.infer<typeof alertListSchema>;

// --- Silence settings --------------------------------------------------------------------

/**
 * What the app does when the output goes silent:
 * - `skip`: skip the item on air (a silent file in the log),
 * - `safety`: drop the queue and skip, so the engine falls back to the safety playlist,
 * - `none`: alert only.
 */
export const silenceActionSchema = z.enum(['skip', 'safety', 'none']);
export type SilenceAction = z.infer<typeof silenceActionSchema>;

/** The fields, without defaults: the patch schema must not fill omitted ones. */
const silenceSettingsFields = {
  /** Seconds of silence before `blank.detected`. */
  maxSeconds: z.number().min(1).max(300),
  /** Below this level (dBFS) counts as silence. */
  thresholdDb: z.number().min(-90).max(0),
  action: silenceActionSchema,
  /**
   * After an action, the alert is a warning; still silent this long after, it escalates to
   * critical. With `action: none` it is critical at once.
   */
  escalateAfterSeconds: z.int().min(5).max(3600),
};

export const SILENCE_DEFAULTS = {
  maxSeconds: 10,
  thresholdDb: -40,
  action: 'skip',
  escalateAfterSeconds: 60,
} as const satisfies {
  [K in keyof typeof silenceSettingsFields]: z.input<(typeof silenceSettingsFields)[K]>;
};

/**
 * Per-station silence detection. `maxSeconds` and `thresholdDb` are the engine template's
 * `blank.detect`: stored in `station.engine_settings.blank` (same ranges and defaults as the
 * template's settings), which the engine is rendered from. The rest is the app's own.
 */
export const silenceSettingsSchema = z.object({
  maxSeconds: silenceSettingsFields.maxSeconds.default(SILENCE_DEFAULTS.maxSeconds),
  thresholdDb: silenceSettingsFields.thresholdDb.default(SILENCE_DEFAULTS.thresholdDb),
  action: silenceSettingsFields.action.default(SILENCE_DEFAULTS.action),
  escalateAfterSeconds: silenceSettingsFields.escalateAfterSeconds.default(
    SILENCE_DEFAULTS.escalateAfterSeconds,
  ),
});
export type SilenceSettings = z.infer<typeof silenceSettingsSchema>;

/** A partial update: omitted fields keep their value (no defaults here), `{}` is refused. */
export const updateSilenceSettingsSchema = z
  .strictObject(silenceSettingsFields)
  .partial()
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), 'empty update');
export type UpdateSilenceSettings = z.infer<typeof updateSilenceSettingsSchema>;
