import {
  type ListUploadsQuery,
  listUploadsQuerySchema,
  type Upload,
  type UploadErrorCode,
  type UploadPage,
  type UploadStatus,
} from '@ondes/shared';
import { and, asc, desc, eq, inArray, isNull, lt, lte, ne, type SQL, sql } from 'drizzle-orm';
import { auditDiff, withAudit } from '../audit.ts';
import type { Db, Executor, Tx } from '../client.ts';
import { NotFoundError } from '../errors.ts';
import { assetFile } from '../schema/library.ts';
import { storageObject } from '../schema/storage.ts';
import { upload } from '../schema/upload.ts';
import { type StationScope, whereStation } from '../tenant.ts';
import { LibraryConflictError } from './library.ts';
import type { StationContext } from './tenancy.ts';

// Uploads (#18): the per-file record of the upload API and the ingest job. Every status
// change goes through `withAudit`. Storage calls (multipart, staging objects) are the
// callers' business; these functions only keep the row.

type UploadRow = typeof upload.$inferSelect;

/** Row as stored, with the internal storage fields the api and worker need. */
export type UploadRecord = UploadRow;

/** Public view: drops the storage internals. */
export function toUpload(row: UploadRow): Upload {
  const {
    stagingKey: _key,
    s3UploadId: _s3,
    createdBy: _by,
    generation: _generation,
    waitingOnUploadId: _waiting,
    ...rest
  } = row;
  return { ...rest, errorCode: rest.errorCode ?? null };
}

export interface NewUpload {
  filename: string;
  sizeBytes: number;
  contentType: string | null;
  assetType: UploadRow['assetType'];
  stagingKey: string;
  s3UploadId: string;
  partSize: number;
  partCount: number;
}

export async function createUpload(
  db: Db,
  ctx: StationContext,
  input: NewUpload,
): Promise<UploadRecord> {
  return withAudit(db, ctx, async (tx, audit) => {
    const [row] = await tx
      .insert(upload)
      .values({
        ...input,
        status: 'uploading',
        orgId: ctx.scope.orgId,
        stationId: ctx.scope.stationId,
        createdBy: ctx.actor.type === 'user' ? ctx.actor.userId : null,
      })
      .returning();
    if (!row) throw new Error('insert returned no row');
    await audit({
      action: 'upload.create',
      entity: { type: 'upload', id: row.id },
      diff: auditDiff(null, toUpload(row), ['orgId', 'stationId']),
    });
    return row;
  });
}

export async function getUpload(
  db: Executor,
  scope: StationScope,
  id: string,
): Promise<UploadRecord> {
  const [row] = await db
    .select()
    .from(upload)
    .where(and(eq(upload.id, id), whereStation(upload, scope)));
  if (!row) throw new NotFoundError('upload', id);
  return row;
}

/** Newest first, keyset-paginated on the (time-ordered) id. */
export async function listUploads(
  db: Executor,
  scope: StationScope,
  query: ListUploadsQuery = {},
): Promise<UploadPage> {
  const q = listUploadsQuerySchema.parse(query);
  const conditions: SQL[] = [whereStation(upload, scope)];
  if (q.status) conditions.push(eq(upload.status, q.status));
  if (q.cursor) conditions.push(lt(upload.id, q.cursor));
  const rows = await db
    .select()
    .from(upload)
    .where(and(...conditions))
    .orderBy(desc(upload.id))
    .limit(q.limit + 1);
  const items = rows.slice(0, q.limit).map(toUpload);
  const nextCursor = rows.length > q.limit ? (items.at(-1)?.id ?? null) : null;
  return { items, nextCursor };
}

export type UploadPatch = Partial<
  Pick<
    UploadRow,
    'status' | 's3UploadId' | 'sha256' | 'assetId' | 'duplicateOfAssetId' | 'errorCode' | 'error'
  >
>;

/**
 * Changes an upload if its current status is one of `from`, under a row lock. Throws
 * `LibraryConflictError` otherwise (a concurrent complete, abort or ingest got there first).
 */
export async function transitionUpload(
  db: Db,
  ctx: StationContext,
  id: string,
  from: readonly UploadStatus[],
  patch: UploadPatch,
  action = 'upload.update',
): Promise<UploadRecord> {
  return withAudit(db, ctx, async (tx, audit) => {
    const [before] = await tx
      .select()
      .from(upload)
      .where(and(eq(upload.id, id), whereStation(upload, ctx.scope)))
      .for('update');
    if (!before) throw new NotFoundError('upload', id);
    if (!from.includes(before.status)) {
      throw new LibraryConflictError(`upload ${id} is ${before.status}`);
    }
    const [row] = await tx
      .update(upload)
      .set(patch)
      .where(and(eq(upload.id, id), whereStation(upload, ctx.scope)))
      .returning();
    if (!row) throw new NotFoundError('upload', id);
    await audit({
      action,
      entity: { type: 'upload', id },
      diff: auditDiff(toUpload(before), toUpload(row)),
    });
    return row;
  });
}

/** Deletes the row (after the caller removed its staging object). */
export async function deleteUpload(db: Db, ctx: StationContext, id: string): Promise<void> {
  await withAudit(db, ctx, async (tx, audit) => {
    const [row] = await tx
      .delete(upload)
      .where(and(eq(upload.id, id), whereStation(upload, ctx.scope)))
      .returning();
    if (!row) throw new NotFoundError('upload', id);
    await audit({
      action: 'upload.delete',
      entity: { type: 'upload', id },
      diff: auditDiff(toUpload(row), null, ['orgId', 'stationId']),
    });
  });
}

export type ContentClaim =
  /** The upload now owns this content in the station: go on and create the asset. */
  | { kind: 'claimed' }
  /** The station already has an asset whose master is this exact file. */
  | { kind: 'duplicate'; assetId: string }
  /**
   * Another upload of the same file is being ingested right now. This one now waits on it
   * (`waiting_on_upload_id`) and is settled by {@link finishUpload} when that one ends.
   */
  | { kind: 'waiting'; uploadId: string };

/** Lock serializing dedupe and settlement of one file in one station (transaction-scoped). */
async function lockContent(tx: Tx, stationId: string, sha256: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`upload:${stationId}:${sha256}`}, 0))`,
  );
}

/**
 * Dedupe step of ingest. Under the content lock, so two concurrent uploads of one file can't
 * both pass:
 * - an asset of the station with this master SHA-256 (other than the upload's own asset,
 *   from an earlier attempt) makes it a `duplicate`;
 * - another upload of the station ingesting this SHA-256 (the holder) makes it `waiting`;
 * - otherwise the upload records the SHA-256 (its claim) and gets `claimed`.
 */
export async function claimUploadContent(
  db: Db,
  ctx: StationContext,
  id: string,
  sha256: string,
): Promise<ContentClaim> {
  return withAudit(db, ctx, async (tx, audit) => {
    await lockContent(tx, ctx.scope.stationId, sha256);
    const [own] = await tx
      .select()
      .from(upload)
      .where(and(eq(upload.id, id), whereStation(upload, ctx.scope)))
      .for('update');
    if (!own) throw new NotFoundError('upload', id);

    const masters = await tx
      .select({ assetId: assetFile.assetId })
      .from(assetFile)
      .where(
        and(
          whereStation(assetFile, ctx.scope),
          eq(assetFile.orgId, ctx.scope.orgId),
          eq(assetFile.sha256, sha256),
          eq(assetFile.role, 'master'),
          own.assetId ? ne(assetFile.assetId, own.assetId) : undefined,
        ),
      )
      .limit(1);
    const existing = masters[0];
    if (existing) {
      await audit({
        action: 'upload.dedupe',
        entity: { type: 'upload', id },
        diff: { duplicateOfAssetId: { from: null, to: existing.assetId } },
      });
      return { kind: 'duplicate', assetId: existing.assetId };
    }

    const [holder] = await tx
      .select({ id: upload.id })
      .from(upload)
      .where(
        and(
          whereStation(upload, ctx.scope),
          eq(upload.sha256, sha256),
          ne(upload.id, id),
          eq(upload.status, 'processing'),
          isNull(upload.waitingOnUploadId),
        ),
      )
      .limit(1);
    if (holder) {
      await tx
        .update(upload)
        .set({ sha256, waitingOnUploadId: holder.id })
        .where(eq(upload.id, id));
      await audit({
        action: 'upload.wait',
        entity: { type: 'upload', id },
        diff: { waitingOnUploadId: { from: own.waitingOnUploadId, to: holder.id } },
      });
      return { kind: 'waiting', uploadId: holder.id };
    }

    await tx.update(upload).set({ sha256, waitingOnUploadId: null }).where(eq(upload.id, id));
    await audit({
      action: 'upload.claim',
      entity: { type: 'upload', id },
      diff: { sha256: { from: own.sha256, to: sha256 } },
    });
    return { kind: 'claimed' };
  });
}

export type FinalUploadStatus = 'ingested' | 'duplicate' | 'quarantined' | 'failed';

/**
 * Ends ingest of a `processing` upload with `patch` (a final status) and, under the content
 * lock, settles the uploads waiting on it: duplicates of its asset when it was ingested, or
 * quarantined/failed like it. Returns the upload and the settled waiters.
 */
export async function finishUpload(
  db: Db,
  ctx: StationContext,
  id: string,
  patch: UploadPatch & { status: FinalUploadStatus },
): Promise<{ upload: UploadRecord; waiters: UploadRecord[] }> {
  return withAudit(db, ctx, async (tx, audit) => {
    const [current] = await tx
      .select({ sha256: upload.sha256 })
      .from(upload)
      .where(and(eq(upload.id, id), whereStation(upload, ctx.scope)));
    if (!current) throw new NotFoundError('upload', id);
    const sha256 = patch.sha256 ?? current.sha256;
    if (sha256) await lockContent(tx, ctx.scope.stationId, sha256);

    const [before] = await tx
      .select()
      .from(upload)
      .where(and(eq(upload.id, id), whereStation(upload, ctx.scope)))
      .for('update');
    if (!before) throw new NotFoundError('upload', id);
    if (before.status !== 'processing') {
      throw new LibraryConflictError(`upload ${id} is ${before.status}`);
    }
    const [row] = await tx
      .update(upload)
      .set({ ...patch, waitingOnUploadId: null })
      .where(eq(upload.id, id))
      .returning();
    if (!row) throw new NotFoundError('upload', id);
    await audit({
      action: `upload.${patch.status}`,
      entity: { type: 'upload', id },
      diff: auditDiff(toUpload(before), toUpload(row)),
    });

    const settle: UploadPatch =
      row.status === 'ingested' && row.assetId
        ? {
            status: 'duplicate',
            duplicateOfAssetId: row.assetId,
            errorCode: null,
            error: `same file as asset ${row.assetId}`,
          }
        : {
            status: row.status === 'quarantined' ? 'quarantined' : 'failed',
            errorCode: row.errorCode ?? 'internal',
            error: `same file as upload ${id}: ${row.error ?? row.status}`.slice(0, 4000),
          };
    const waiters = await tx
      .update(upload)
      .set({ ...settle, waitingOnUploadId: null })
      .where(
        and(
          whereStation(upload, ctx.scope),
          eq(upload.waitingOnUploadId, id),
          eq(upload.status, 'processing'),
        ),
      )
      .returning();
    for (const waiter of waiters) {
      await audit({
        action: `upload.${waiter.status}`,
        entity: { type: 'upload', id: waiter.id },
        diff: {
          status: { from: 'processing', to: waiter.status },
          settledBy: { from: null, to: id },
        },
      });
    }
    return { upload: row, waiters };
  });
}

/**
 * Queues a `failed` upload again under a new generation (a new ingest job key). Its staging
 * object is still there: failures keep it.
 */
export async function retryUpload(db: Db, ctx: StationContext, id: string): Promise<UploadRecord> {
  return withAudit(db, ctx, async (tx, audit) => {
    const [before] = await tx
      .select()
      .from(upload)
      .where(and(eq(upload.id, id), whereStation(upload, ctx.scope)))
      .for('update');
    if (!before) throw new NotFoundError('upload', id);
    if (before.status !== 'failed') {
      throw new LibraryConflictError(`upload ${id} is ${before.status}, not failed`);
    }
    const [row] = await tx
      .update(upload)
      .set({
        status: 'queued',
        generation: before.generation + 1,
        errorCode: null,
        error: null,
        waitingOnUploadId: null,
      })
      .where(eq(upload.id, id))
      .returning();
    if (!row) throw new NotFoundError('upload', id);
    await audit({
      action: 'upload.retry',
      entity: { type: 'upload', id },
      diff: auditDiff(toUpload(before), toUpload(row)),
    });
    return row;
  });
}

/**
 * Bytes the org's unfinished uploads (`uploading`, `queued`, `processing`) may still add:
 * counted on top of its usage by quota checks, so many open uploads can't overshoot it.
 */
export async function reservedUploadBytes(
  db: Executor,
  orgId: string,
  excludeUploadId?: string,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<string | null>`sum(${upload.sizeBytes})` })
    .from(upload)
    .where(
      and(
        eq(upload.orgId, orgId),
        inArray(upload.status, ['uploading', 'queued', 'processing']),
        excludeUploadId ? ne(upload.id, excludeUploadId) : undefined,
      ),
    );
  return Number(row?.total ?? 0);
}

/**
 * Uploads of every tenant in `status` not updated for `olderThanMs`, oldest first: for the
 * worker's sweeps (expired multipart uploads, `queued` uploads whose job got lost). The
 * caller resolves each row's station scope before changing it.
 */
export async function listStaleUploads(
  db: Executor,
  status: 'uploading' | 'queued',
  olderThanMs: number,
  limit = 100,
): Promise<UploadRecord[]> {
  return db
    .select()
    .from(upload)
    .where(
      and(
        eq(upload.status, status),
        lte(upload.updatedAt, sql`now() - ${`${olderThanMs} milliseconds`}::interval`),
      ),
    )
    .orderBy(asc(upload.updatedAt))
    .limit(limit);
}

/** Sets the final error of an upload (quarantine or failure). */
export function uploadError(
  code: UploadErrorCode,
  message: string,
): Pick<UploadPatch, 'errorCode' | 'error'> {
  return { errorCode: code, error: message.slice(0, 4000) };
}

/**
 * Records the asset ingest created for an upload. Call it in the transaction that creates the
 * asset, so a retried ingest finds the asset again instead of creating a second one.
 */
export async function setUploadAsset(
  db: Executor,
  scope: StationScope,
  id: string,
  assetId: string,
): Promise<void> {
  await db
    .update(upload)
    .set({ assetId })
    .where(and(eq(upload.id, id), whereStation(upload, scope)));
}

/** Keys of `keys` the org doesn't reference yet: what storing them would add to its usage. */
export async function unreferencedKeys(
  db: Executor,
  orgId: string,
  keys: readonly string[],
): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await db
    .select({ key: storageObject.key })
    .from(storageObject)
    .where(
      and(
        eq(storageObject.orgId, orgId),
        inArray(storageObject.key, [...keys]),
        sql`${storageObject.refCount} > 0`,
      ),
    );
  const referenced = new Set(rows.map((r) => r.key));
  return keys.filter((k) => !referenced.has(k));
}
