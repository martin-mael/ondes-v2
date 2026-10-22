import type { StationScope } from '@ondes/db';
import { type JobPublisher, jobType } from '@ondes/queue';
import { ISLAND_RENDER_JOB, islandRenderJobPayloadSchema } from '@ondes/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { SyncResult } from './sync.ts';

// Re-render on change (#56): every committed sync (a segue write, or the consumer reacting to a
// log, library or station change) enqueues an `island-render` job for each hash it left
// `pending`. The worker renders it (apps/worker/src/jobs/island-render). A lost enqueue is
// caught by the worker's sweep, so a failure here is only logged.

export const islandRenderJob = jobType(ISLAND_RENDER_JOB, islandRenderJobPayloadSchema, {
  lane: 'high',
});

export async function requestRenders(
  jobs: JobPublisher | undefined,
  scope: StationScope,
  sync: SyncResult,
  log: FastifyBaseLogger,
) {
  if (!jobs) return;
  const hashes = new Set(sync.islands.filter((i) => i.status === 'pending').map((i) => i.hash));
  for (const hash of hashes) {
    try {
      await jobs.enqueue(
        islandRenderJob,
        { orgId: scope.orgId, stationId: scope.stationId, hash },
        { orgId: scope.orgId, stationId: scope.stationId },
      );
    } catch (error) {
      log.error({ err: error, hash }, 'island render enqueue failed');
    }
  }
}
