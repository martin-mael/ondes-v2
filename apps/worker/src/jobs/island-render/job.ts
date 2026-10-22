import { jobType } from '@ondes/queue';
import { ISLAND_RENDER_JOB, islandRenderJobPayloadSchema } from '@ondes/shared';

/** The `island-render` job type, for publishers (the sweep; the api declares its own). */
export const islandRenderJob = jobType(ISLAND_RENDER_JOB, islandRenderJobPayloadSchema, {
  lane: 'high',
});
