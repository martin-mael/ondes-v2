import type { Readable } from 'node:stream';
import { type Db, listAssetFiles, type StationScope } from '@ondes/db';
import { jobType } from '@ondes/queue';
import {
  type AssetFile,
  PEAKS_JOB,
  PEAKS_MIME_TYPE,
  type PeaksJobPayload,
  peaksIdempotencyKey,
  peaksJobPayloadSchema,
  peaksStorageKey,
  sha256HexSchema,
} from '@ondes/shared';
import { ObjectNotFoundError, type Storage } from '@ondes/storage';
import { z } from 'zod';

// Waveform peaks (#22): `GET …/assets/:assetId/peaks` serves the asset's peaks file, as the
// worker stored it (format: packages/shared/src/contracts/peaks.ts), through the api so the
// station's read permission applies.
//
// Caching: the ETag is the file's SHA-256 (`asset.files[role=peaks].sha256`).
// - `…/peaks`: `Cache-Control: private, no-cache`; the browser revalidates (304 when unchanged).
// - `…/peaks?v=<sha256>`: when `v` is the current file's hash, the response never changes:
//   `private, max-age=31536000, immutable`. Another `v` is a 404 (that version is gone).
// No peaks yet (job pending), or only those of a replaced playout copy: 404. A recorded peaks
// file missing from the bucket is a 404 too, and enqueues a `peaks` job that restores it
// (`enqueueRepair`, at most one per asset and hour).

export const peaksQuerySchema = z.object({ v: sha256HexSchema.optional() });

export const PEAKS_IMMUTABLE = 'private, max-age=31536000, immutable';
export const PEAKS_REVALIDATE = 'private, no-cache';

/** The `peaks` job type (the worker's `jobs/peaks`), for repairs. */
export const peaksJob = jobType(PEAKS_JOB, peaksJobPayloadSchema, {
  lane: 'bulk',
  idempotencyKey: peaksIdempotencyKey,
});

export interface PeaksDeps {
  db: Db;
  storage: Storage;
  /** Enqueues a `peaks` job for a recorded file missing from the bucket. */
  enqueueRepair?: (payload: PeaksJobPayload) => Promise<void>;
}

export type PeaksResult =
  | { status: 404; body: { error: 'not_found'; message: string } }
  | { status: 304; headers: Record<string, string> }
  | { status: 200; headers: Record<string, string>; body: Readable };

/** The asset's peaks file and playout copy, if the peaks come from that copy. */
export function currentPeaksFile(
  files: readonly AssetFile[],
  orgId: string,
): { peaks: AssetFile; playout: AssetFile } | undefined {
  const playout = files.find((file) => file.role === 'playout');
  const peaks = files.find((file) => file.role === 'peaks');
  if (!playout || !peaks) return undefined;
  return peaks.storageKey === peaksStorageKey(orgId, playout.sha256)
    ? { peaks, playout }
    : undefined;
}

/** True when an `If-None-Match` header names `etag` (or is `*`). */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === etag || tag === '*');
}

const notFound = (message: string): PeaksResult => ({
  status: 404,
  body: { error: 'not_found', message },
});

export async function getAssetPeaks(
  deps: PeaksDeps,
  scope: StationScope,
  assetId: string,
  request: { query: unknown; ifNoneMatch?: string },
): Promise<PeaksResult> {
  const { v } = peaksQuerySchema.parse(request.query ?? {});
  // Throws NotFoundError for an asset outside the station, like the other library routes.
  const files = await listAssetFiles(deps.db, scope, assetId);
  const current = currentPeaksFile(files, scope.orgId);
  if (!current) return notFound(`asset ${assetId} has no peaks yet`);
  const { peaks, playout } = current;
  if (v && v !== peaks.sha256) return notFound(`asset ${assetId}: peaks ${v} are not current`);
  const etag = `"${peaks.sha256}"`;
  const headers = { etag, 'cache-control': v ? PEAKS_IMMUTABLE : PEAKS_REVALIDATE };
  if (etagMatches(request.ifNoneMatch, etag)) return { status: 304, headers };
  try {
    const object = await deps.storage.get(peaks.storageKey);
    return {
      status: 200,
      headers: {
        ...headers,
        'content-type': PEAKS_MIME_TYPE,
        'content-length': String(object.contentLength),
      },
      body: object.body,
    };
  } catch (error) {
    if (!(error instanceof ObjectNotFoundError)) throw error;
    // Recorded but missing from the bucket (the backfill only looks at records): have the
    // worker restore it. Meanwhile the editor draws without a waveform, as for pending peaks.
    await deps.enqueueRepair?.({
      orgId: scope.orgId,
      stationId: scope.stationId,
      assetId,
      playoutSha256: playout.sha256,
    });
    return notFound(`asset ${assetId}: peaks missing, recomputing`);
  }
}
