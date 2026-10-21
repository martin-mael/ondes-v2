import type { JobPublisher } from '@ondes/queue';
import { loudnessIdempotencyKey, type RealtimeEvent } from '@ondes/shared';
import type { JobTrigger } from '../../registry.ts';
import { loudnessJob } from './job.ts';

/** `asset.ingested` → measure the new playout copy. */
export const loudnessTrigger: JobTrigger = {
  queue: 'worker.loudness',
  async onEvent(event: RealtimeEvent, jobs: JobPublisher) {
    if (event.type !== 'asset.ingested') return;
    await enqueueLoudness(jobs, {
      orgId: event.data.orgId,
      stationId: event.stationId,
      assetId: event.data.assetId,
      playoutSha256: event.data.playout.sha256,
    });
  },
};

/** Explicit key: a redelivered event or a backfill of a measured asset runs nothing. */
export async function enqueueLoudness(
  jobs: JobPublisher,
  payload: { orgId: string; stationId: string; assetId: string; playoutSha256: string },
): Promise<void> {
  await jobs.enqueue(loudnessJob, payload, {
    idempotencyKey: loudnessIdempotencyKey(payload),
    orgId: payload.orgId,
    stationId: payload.stationId,
  });
}
