import type { JobPublisher } from '@ondes/queue';
import { type PeaksJobPayload, peaksIdempotencyKey, type RealtimeEvent } from '@ondes/shared';
import type { JobTrigger } from '../../registry.ts';
import { peaksJob } from './job.ts';

/** `asset.ingested` → peaks of the new playout copy. */
export const peaksTrigger: JobTrigger = {
  queue: 'worker.peaks',
  async onEvent(event: RealtimeEvent, jobs: JobPublisher) {
    if (event.type !== 'asset.ingested') return;
    await enqueuePeaks(jobs, {
      orgId: event.data.orgId,
      stationId: event.stationId,
      assetId: event.data.assetId,
      playoutSha256: event.data.playout.sha256,
    });
  },
};

/**
 * Explicit key `peaks:<assetId>:<playoutSha256>:v<format>`: a redelivered event or a backfill
 * of an asset that already has its peaks runs nothing.
 */
export async function enqueuePeaks(jobs: JobPublisher, payload: PeaksJobPayload): Promise<void> {
  await jobs.enqueue(peaksJob, payload, {
    idempotencyKey: peaksIdempotencyKey(payload),
    orgId: payload.orgId,
    stationId: payload.stationId,
  });
}
