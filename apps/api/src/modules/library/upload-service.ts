import { randomUUID } from 'node:crypto';
import {
  createPostgresQuotaStore,
  createUpload,
  type Db,
  deleteUpload,
  getUpload,
  LibraryConflictError,
  reservedUploadBytes,
  retryUpload as retryUploadRow,
  type StationContext,
  toUpload,
  transitionUpload,
  type UploadRecord,
  uploadError,
} from '@ondes/db';
import { jobType } from '@ondes/queue';
import {
  createUploadSchema,
  FINAL_UPLOAD_STATUSES,
  INGEST_JOB,
  type IngestJobPayload,
  ingestIdempotencyKey,
  ingestJobPayloadSchema,
  type PresignedUploadParts,
  presignUploadPartsSchema,
  type Upload,
  type UploadedParts,
  uploadPartCount,
  uploadPartSize,
} from '@ondes/shared';
import { assertQuota, orgPrefix, type Storage, type UploadedPart } from '@ondes/storage';

// Upload API (#18): resumable browser uploads straight to S3, then the ingest job.
//
// 1. `create`: quota check, S3 multipart upload on a staging key, `upload` row (`uploading`).
// 2. `presignParts`: URLs for the parts the browser sends (quota checked again).
// 3. `listParts`: the parts S3 already has, so an interrupted upload resumes with the rest.
// 4. `complete`: every part present → S3 complete → size check → `queued` → ingest job.
// `abort` cancels an open upload; `remove` deletes a finished one and its staging object;
// `retry` queues a failed one again.
//
// Quota checks count the org's usage plus the declared size of its unfinished uploads, and
// each part URL is signed for that part's exact size: a client can't store more than it
// declared. The worker aborts uploads left open for a day (see jobs/ingest/sweep.ts).

export const ingestJob = jobType(INGEST_JOB, ingestJobPayloadSchema, {
  idempotencyKey: ingestIdempotencyKey,
});

export interface UploadDeps {
  db: Db;
  storage: Storage;
  enqueueIngest(payload: IngestJobPayload): Promise<void>;
  /** Seconds presigned part URLs stay valid. Default 1 hour. */
  presignExpiresIn?: number;
}

const DEFAULT_PRESIGN_EXPIRES_IN = 60 * 60;

export async function createUploadSession(
  deps: UploadDeps,
  ctx: StationContext,
  body: unknown,
): Promise<Upload> {
  const input = createUploadSchema.parse(body);
  const orgId = ctx.scope.orgId;
  await assertUploadQuota(deps.db, orgId, input.sizeBytes);
  const partSize = uploadPartSize(input.sizeBytes);
  const stagingKey = `${orgPrefix(orgId)}uploads/${randomUUID()}`;
  const { uploadId } = await deps.storage.createMultipartUpload(stagingKey, {
    contentType: input.contentType,
  });
  try {
    const row = await createUpload(deps.db, ctx, {
      filename: input.filename,
      sizeBytes: input.sizeBytes,
      contentType: input.contentType ?? null,
      assetType: input.assetType,
      stagingKey,
      s3UploadId: uploadId,
      partSize,
      partCount: uploadPartCount(input.sizeBytes, partSize),
    });
    return toUpload(row);
  } catch (error) {
    await deps.storage.abortMultipartUpload(stagingKey, uploadId).catch(() => {});
    throw error;
  }
}

/** Usage + unfinished uploads (other than `excludeUploadId`) + `incomingBytes` ≤ limit. */
async function assertUploadQuota(
  db: Db,
  orgId: string,
  incomingBytes: number,
  excludeUploadId?: string,
): Promise<void> {
  const reserved = await reservedUploadBytes(db, orgId, excludeUploadId);
  await assertQuota(createPostgresQuotaStore(db), orgId, incomingBytes + reserved);
}

/** Exact size of part `n` (1-based): `partSize`, except the last one. */
export function partLength(
  row: Pick<UploadRecord, 'sizeBytes' | 'partSize' | 'partCount'>,
  n: number,
) {
  return n < row.partCount ? row.partSize : row.sizeBytes - (row.partCount - 1) * row.partSize;
}

function openUpload(row: UploadRecord): UploadRecord & { s3UploadId: string } {
  if (row.status !== 'uploading' || !row.s3UploadId) {
    throw new LibraryConflictError(`upload ${row.id} is ${row.status}, not uploading`);
  }
  return row as UploadRecord & { s3UploadId: string };
}

export async function presignParts(
  deps: UploadDeps,
  ctx: StationContext,
  id: string,
  body: unknown,
): Promise<PresignedUploadParts> {
  const { partNumbers } = presignUploadPartsSchema.parse(body);
  const row = openUpload(await getUpload(deps.db, ctx.scope, id));
  const beyond = partNumbers.filter((n) => n > row.partCount);
  if (beyond.length) {
    throw new LibraryConflictError(`upload ${id} has ${row.partCount} parts, not ${beyond[0]}`);
  }
  await assertUploadQuota(deps.db, ctx.scope.orgId, row.sizeBytes, row.id);
  const expiresIn = deps.presignExpiresIn ?? DEFAULT_PRESIGN_EXPIRES_IN;
  const unique = [...new Set(partNumbers)].sort((a, b) => a - b);
  const parts = await deps.storage.presignUploadParts(row.stagingKey, row.s3UploadId, unique, {
    expiresIn,
    contentLengths: Object.fromEntries(unique.map((n) => [n, partLength(row, n)])),
  });
  return { parts, expiresIn };
}

export async function listUploadedParts(
  deps: UploadDeps,
  ctx: StationContext,
  id: string,
): Promise<UploadedParts> {
  const row = openUpload(await getUpload(deps.db, ctx.scope, id));
  return { parts: await deps.storage.listParts(row.stagingKey, row.s3UploadId) };
}

/**
 * Completes the multipart upload and enqueues ingest. Safe to call again: an upload that is
 * already `queued` is enqueued again (the job key makes it run once), and one that went
 * further is returned as it is.
 */
export async function completeUpload(
  deps: UploadDeps,
  ctx: StationContext,
  id: string,
): Promise<Upload> {
  let row = await getUpload(deps.db, ctx.scope, id);
  if (row.status === 'aborted') throw new LibraryConflictError(`upload ${id} is aborted`);
  if (row.status === 'uploading') {
    const open = openUpload(row);
    await completeMultipart(deps, open);
    const stored = await deps.storage.head(row.stagingKey);
    if (!stored || stored.size !== row.sizeBytes) {
      await deps.storage.delete(row.stagingKey);
      await transitionUpload(
        deps.db,
        ctx,
        id,
        ['uploading'],
        {
          status: 'aborted',
          s3UploadId: null,
          ...uploadError(
            'size_mismatch',
            `declared ${row.sizeBytes} bytes, uploaded ${stored?.size ?? 0}`,
          ),
        },
        'upload.complete',
      );
      throw new LibraryConflictError(
        `upload ${id}: declared ${row.sizeBytes} bytes, uploaded ${stored?.size ?? 0}`,
      );
    }
    row = await transitionUpload(
      deps.db,
      ctx,
      id,
      ['uploading'],
      { status: 'queued', s3UploadId: null },
      'upload.complete',
    );
  }
  if (row.status === 'queued') await enqueueUpload(deps, row);
  return toUpload(row);
}

export async function enqueueUpload(deps: Pick<UploadDeps, 'enqueueIngest'>, row: UploadRecord) {
  await deps.enqueueIngest({
    uploadId: row.id,
    orgId: row.orgId,
    stationId: row.stationId,
    generation: row.generation,
  });
}

/** Queues a `failed` upload again (new generation, so a new ingest job). */
export async function retryUpload(
  deps: UploadDeps,
  ctx: StationContext,
  id: string,
): Promise<Upload> {
  const row = await retryUploadRow(deps.db, ctx, id);
  await enqueueUpload(deps, row);
  return toUpload(row);
}

/**
 * Completes the S3 upload from the parts S3 itself lists, once all of 1..partCount are there.
 * If S3 no longer knows the upload id but the object exists, an earlier call completed it.
 */
async function completeMultipart(
  deps: UploadDeps,
  row: UploadRecord & { s3UploadId: string },
): Promise<void> {
  let parts: UploadedPart[];
  try {
    parts = await deps.storage.listParts(row.stagingKey, row.s3UploadId);
  } catch (error) {
    if (await deps.storage.head(row.stagingKey)) return;
    throw error;
  }
  const have = new Set(parts.map((p) => p.partNumber));
  const missing: number[] = [];
  for (let n = 1; n <= row.partCount; n++) if (!have.has(n)) missing.push(n);
  if (missing.length) {
    throw new LibraryConflictError(
      `upload ${row.id} is missing parts ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''}`,
    );
  }
  const extra = parts.filter((p) => p.partNumber > row.partCount);
  if (extra.length) {
    throw new LibraryConflictError(`upload ${row.id} has unexpected part ${extra[0]?.partNumber}`);
  }
  await deps.storage.completeMultipartUpload(row.stagingKey, row.s3UploadId, parts);
}

/** Cancels an open upload: S3 drops the parts, the row stays as `aborted`. */
export async function abortUpload(
  deps: UploadDeps,
  ctx: StationContext,
  id: string,
): Promise<Upload> {
  const row = openUpload(await getUpload(deps.db, ctx.scope, id));
  await deps.storage.abortMultipartUpload(row.stagingKey, row.s3UploadId);
  const after = await transitionUpload(
    deps.db,
    ctx,
    id,
    ['uploading'],
    { status: 'aborted', s3UploadId: null },
    'upload.abort',
  );
  return toUpload(after);
}

/**
 * Deletes an upload that is open or finished (never one queued or being ingested), with its
 * staging object. The asset an ingested upload created is not touched.
 */
export async function removeUpload(deps: UploadDeps, ctx: StationContext, id: string) {
  const row = await getUpload(deps.db, ctx.scope, id);
  if (row.status === 'uploading') {
    await abortUpload(deps, ctx, id);
  } else if (!(FINAL_UPLOAD_STATUSES as readonly string[]).includes(row.status)) {
    throw new LibraryConflictError(`upload ${id} is ${row.status}`);
  }
  // A staging key, not a content key: it is never shared, so it's deleted directly.
  await deps.storage.delete(row.stagingKey);
  await deleteUpload(deps.db, ctx, id);
}
