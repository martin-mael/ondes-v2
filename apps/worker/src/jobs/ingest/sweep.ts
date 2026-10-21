import {
  type Db,
  LibraryConflictError,
  listStaleUploads,
  resolveStationScope,
  transitionUpload,
  uploadError,
} from '@ondes/db';
import { type JobPublisher, jobType } from '@ondes/queue';
import { INGEST_JOB, ingestIdempotencyKey, ingestJobPayloadSchema } from '@ondes/shared';
import type { Storage } from '@ondes/storage';
import { INGEST_ACTOR } from './ingest.ts';

// Upload sweeps (#18), run by the worker on a timer next to the storage sweep:
// - `uploading` uploads untouched for a day: the browser gave up. Abort the multipart upload
//   (S3 drops the parts, which a bucket lifecycle rule would only do much later) and mark
//   them `aborted`/`expired`, which also frees their quota reservation.
// - `queued` uploads untouched for 10 minutes: the api crashed between `queued` and the
//   enqueue, or the message was lost. Enqueue their ingest job again; its key makes a
//   duplicate harmless.
// Safe to run from every worker replica: each change is a guarded status transition.

const ingestJob = jobType(INGEST_JOB, ingestJobPayloadSchema, {
  idempotencyKey: ingestIdempotencyKey,
});

export interface UploadSweepDeps {
  db: Db;
  storage: Storage;
  jobs: JobPublisher;
}

export interface UploadSweepOptions {
  /** Default 24 hours. */
  expireUploadingAfterMs?: number;
  /** Default 10 minutes. */
  requeueQueuedAfterMs?: number;
}

export interface UploadSweepResult {
  expired: string[];
  requeued: string[];
}

export async function sweepUploads(
  deps: UploadSweepDeps,
  options: UploadSweepOptions = {},
): Promise<UploadSweepResult> {
  const result: UploadSweepResult = { expired: [], requeued: [] };

  const open = await listStaleUploads(
    deps.db,
    'uploading',
    options.expireUploadingAfterMs ?? 24 * 60 * 60 * 1000,
  );
  for (const row of open) {
    const scope = await resolveStationScope(deps.db, row.orgId, row.stationId);
    if (row.s3UploadId) {
      // Already gone (completed or aborted at S3) is fine: the row is what's stale.
      await deps.storage.abortMultipartUpload(row.stagingKey, row.s3UploadId).catch(() => {});
    }
    try {
      await transitionUpload(
        deps.db,
        { actor: INGEST_ACTOR, scope },
        row.id,
        ['uploading'],
        { status: 'aborted', s3UploadId: null, ...uploadError('expired', 'never completed') },
        'upload.expire',
      );
      result.expired.push(row.id);
    } catch (error) {
      // Completed or aborted meanwhile.
      if (!(error instanceof LibraryConflictError)) throw error;
    }
  }

  const queued = await listStaleUploads(
    deps.db,
    'queued',
    options.requeueQueuedAfterMs ?? 10 * 60 * 1000,
  );
  for (const row of queued) {
    const scope = await resolveStationScope(deps.db, row.orgId, row.stationId);
    try {
      // Touch the row first, so the next sweep waits another full period.
      await transitionUpload(
        deps.db,
        { actor: INGEST_ACTOR, scope },
        row.id,
        ['queued'],
        { errorCode: null, error: null },
        'upload.requeue',
      );
    } catch (error) {
      if (!(error instanceof LibraryConflictError)) throw error;
      continue;
    }
    await deps.jobs.enqueue(
      ingestJob,
      { uploadId: row.id, orgId: row.orgId, stationId: row.stationId, generation: row.generation },
      { orgId: row.orgId, stationId: row.stationId },
    );
    result.requeued.push(row.id);
  }
  return result;
}
