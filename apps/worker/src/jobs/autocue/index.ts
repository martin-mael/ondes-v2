import { defineJob } from '@ondes/queue';
import { AUTOCUE_JOB, autocueIdempotencyKey, autocueJobPayloadSchema } from '@ondes/shared';
import { autocue } from './autocue.ts';
import { autocueDeps } from './env.ts';
import { createAutocueTrigger } from './trigger.ts';

// `autocue` job (#20): cue points for an asset's playout copy (autocue.ts), started by
// `asset.ingested` (trigger.ts) and by the backfill (backfill.ts).

export const triggers = [createAutocueTrigger(async () => (await autocueDeps()).db)];

export default defineJob(
  AUTOCUE_JOB,
  autocueJobPayloadSchema,
  async (payload, ctx) => {
    await autocue(await autocueDeps(), payload, { signal: ctx.signal });
  },
  { lane: 'bulk', idempotencyKey: autocueIdempotencyKey },
);
