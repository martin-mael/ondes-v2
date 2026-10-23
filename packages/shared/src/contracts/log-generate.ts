import { z } from 'zod';
import { type LocalDate, localDateSchema } from './log.ts';
import { uuidSchema } from './tenancy.ts';

// Log generation (#50, ADR 0026). The worker's `log-generate` job generates station-local days
// with @ondes/scheduling's generator and writes them (`log_day.generate`), then publishes
// `log.updated` with cause `generate`. Regeneration with dry-run and diff, and the api routes
// that enqueue it, are #101's.

/** At most two weeks per job: a job is one transaction per day, run in order. */
export const LOG_GENERATE_MAX_DAYS = 14;

const consecutive = (dates: readonly LocalDate[]) =>
  dates.every((d, i) => {
    if (i === 0) return true;
    const next = new Date(`${dates[i - 1]}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString().slice(0, 10) === d;
  });

/** `log-generate`: generate these days of a station (worker, `bulk` lane: days are generated ahead of air). */
export const LOG_GENERATE_JOB = 'log-generate';
export const logGenerateJobPayloadSchema = z.object({
  orgId: uuidSchema,
  stationId: uuidSchema,
  /** Consecutive station-local dates, in order. */
  localDates: z
    .array(localDateSchema)
    .min(1)
    .max(LOG_GENERATE_MAX_DAYS)
    .refine(consecutive, 'dates must be consecutive and in order'),
  /** Same seed, same snapshot: same day. Default `<stationId>:<localDate>` per day. */
  seed: z.string().min(1).max(100).optional(),
  /** Status of days the job creates (existing days keep theirs). */
  status: z.enum(['draft', 'published']).default('draft'),
});
export type LogGenerateJobPayload = z.infer<typeof logGenerateJobPayloadSchema>;
export type LogGenerateJobInput = z.input<typeof logGenerateJobPayloadSchema>;
