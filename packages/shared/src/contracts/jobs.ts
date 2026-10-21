import { z } from 'zod';

/**
 * Base job envelope and job-run status (#8). Each job's own payload schema lives next to
 * its domain contracts and is checked by `defineJob` in `@ondes/queue`; this file only
 * holds what every job shares.
 */

/**
 * Work lanes, each backed by its own queue so bulk work never delays urgent work.
 * - `high`: engine-related work and renders a listener can hear (island render, cache sync).
 * - `bulk`: background analysis and imports (loudness, autocue, peaks, dedupe).
 * - `notify`: notifications sent by the api itself (alert emails, later webhooks). Consumed
 *   by the api, never by the worker, which only consumes its own jobs' lanes.
 */
export const jobLaneSchema = z.enum(['high', 'bulk', 'notify']);
export type JobLane = z.infer<typeof jobLaneSchema>;

/**
 * How long an idempotency key blocks other jobs with the same key.
 * - `in_flight`: only while a run is `running` or `retrying`. Default, used with the derived
 *   payload-hash key: the same work enqueued twice at once runs once, but enqueuing it again
 *   later (a log to regenerate, a cache to resync) runs again.
 * - `once`: also after a run `succeeded`. Set automatically when the key is explicit
 *   (`entity:version`), because such a key names one unit of work that must never run twice.
 */
export const idempotencyModeSchema = z.enum(['in_flight', 'once']);
export type IdempotencyMode = z.infer<typeof idempotencyModeSchema>;

/** Message body on the wire. `payload` is validated by the job's own schema on consume. */
export const jobEnvelopeSchema = z.object({
  /** Unique per enqueue; stays the same across retries of that enqueue. */
  id: z.uuid(),
  /** Job name, as given to `defineJob`, e.g. `ingest` or `log-generate`. */
  name: z.string().min(1).max(100),
  /** Content hash or `entity:version`; defaults to a hash of name + payload. */
  idempotencyKey: z.string().min(1).max(512),
  /** See {@link idempotencyModeSchema}. Absent on messages from older publishers. */
  idempotency: idempotencyModeSchema.default('in_flight'),
  /** 1 for the first delivery, incremented by each retry. */
  attempt: z.int().min(1),
  enqueuedAt: z.iso.datetime(),
  /** Tenant scope, when the job belongs to a station (shown in the station's job list). */
  orgId: z.uuid().optional(),
  stationId: z.uuid().optional(),
  payload: z.unknown(),
});
export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;

/**
 * - `running`: an attempt is in progress.
 * - `retrying`: an attempt failed and the job waits in a retry tier.
 * - `succeeded`: done.
 * - `dead`: out of attempts, or not retryable; the message sits in the dead-letter queue.
 */
export const jobRunStatusSchema = z.enum(['running', 'retrying', 'succeeded', 'dead']);
export type JobRunStatus = z.infer<typeof jobRunStatusSchema>;

/** One enqueued job as shown in the admin job list. */
export const jobRunSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  lane: jobLaneSchema,
  idempotencyKey: z.string(),
  status: jobRunStatusSchema,
  attempt: z.int().min(1),
  orgId: z.uuid().nullable(),
  stationId: z.uuid().nullable(),
  lastError: z.string().nullable(),
  enqueuedAt: z.iso.datetime(),
  startedAt: z.iso.datetime(),
  /** When the next attempt is due, while `retrying`. */
  nextAttemptAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type JobRun = z.infer<typeof jobRunSchema>;
