import { jobType } from '@ondes/queue';
import { LOUDNESS_JOB, loudnessIdempotencyKey, loudnessJobPayloadSchema } from '@ondes/shared';

/** The `loudness` job type, for publishers (the trigger, the backfill). */
export const loudnessJob = jobType(LOUDNESS_JOB, loudnessJobPayloadSchema, {
  lane: 'bulk',
  idempotencyKey: loudnessIdempotencyKey,
});
