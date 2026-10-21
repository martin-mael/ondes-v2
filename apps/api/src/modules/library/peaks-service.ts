import type { Readable } from 'node:stream';
import { type Db, listAssetFiles, type StationScope } from '@ondes/db';
import { type AssetFile, PEAKS_MIME_TYPE, peaksStorageKey, sha256HexSchema } from '@ondes/shared';
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
// No peaks yet (job pending), or only those of a replaced playout copy: 404.

export const peaksQuerySchema = z.object({ v: sha256HexSchema.optional() });

export const PEAKS_IMMUTABLE = 'private, max-age=31536000, immutable';
export const PEAKS_REVALIDATE = 'private, no-cache';

export type PeaksResult =
  | { status: 404; body: { error: 'not_found'; message: string } }
  | { status: 304; headers: Record<string, string> }
  | { status: 200; headers: Record<string, string>; body: Readable };

/** The asset's peaks file, if it was computed from its current playout copy. */
export function currentPeaksFile(
  files: readonly AssetFile[],
  orgId: string,
): AssetFile | undefined {
  const playout = files.find((file) => file.role === 'playout');
  const peaks = files.find((file) => file.role === 'peaks');
  if (!playout || !peaks) return undefined;
  return peaks.storageKey === peaksStorageKey(orgId, playout.sha256) ? peaks : undefined;
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
  deps: { db: Db; storage: Storage },
  scope: StationScope,
  assetId: string,
  request: { query: unknown; ifNoneMatch?: string },
): Promise<PeaksResult> {
  const { v } = peaksQuerySchema.parse(request.query ?? {});
  // Throws NotFoundError for an asset outside the station, like the other library routes.
  const files = await listAssetFiles(deps.db, scope, assetId);
  const peaks = currentPeaksFile(files, scope.orgId);
  if (!peaks) return notFound(`asset ${assetId} has no peaks yet`);
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
    // Recorded but missing from the bucket: the backfill can't see it, but a 404 tells the
    // editor to draw without a waveform rather than fail.
    if (error instanceof ObjectNotFoundError) return notFound(`asset ${assetId}: peaks missing`);
    throw error;
  }
}
