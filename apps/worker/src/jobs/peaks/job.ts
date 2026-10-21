import { jobType } from '@ondes/queue';
import { PEAKS_JOB, peaksIdempotencyKey, peaksJobPayloadSchema } from '@ondes/shared';

/** The `peaks` job type, for publishers (the trigger, the backfill). */
export const peaksJob = jobType(PEAKS_JOB, peaksJobPayloadSchema, {
  lane: 'bulk',
  idempotencyKey: peaksIdempotencyKey,
});
