import {
  FINAL_UPLOAD_STATUSES,
  presignedUploadPartsSchema,
  type Upload,
  uploadSchema,
} from '@ondes/shared';
import { ApiError, request } from '../../app/api/client.ts';

// A take's upload (#59): the library's browser upload (#18, S3 multipart through presigned
// part URLs) as a `vt` asset, then the ingest it starts (master, playout copy, then loudness
// and peaks), which the recorder waits for. Presenters may upload `vt` files with
// `voice_track:write_own` (the upload routes' guard).

const uploads = (stationId: string) => `/stations/${encodeURIComponent(stationId)}/uploads`;

/** How long the recorder waits for ingest before saying it's still processing. */
const PROCESSING_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 3000;

export type TakeUploadPhase = { phase: 'uploading'; pct: number } | { phase: 'processing' };

export interface TakeUploadOptions {
  signal?: AbortSignal;
  /** Resolves after `ms`, or sooner when the upload changed (an `upload.updated` event). */
  waitForChange?: (uploadId: string, ms: number, signal?: AbortSignal) => Promise<void>;
  processingTimeoutMs?: number;
  pollMs?: number;
}

/** A take's file name, from which ingest takes the asset's title. */
export function takeFilename(title: string): string {
  const clean = title.replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ').trim() || 'VT';
  return `${clean.slice(0, 200)}.wav`;
}

/**
 * Uploads a take as a `vt` asset and waits for ingest. Resolves with the asset id (the
 * existing one when the station already has this exact file).
 */
export async function uploadTake(
  stationId: string,
  file: File,
  onProgress: (p: TakeUploadPhase) => void,
  options: TakeUploadOptions = {},
): Promise<string> {
  const { signal } = options;
  const base = uploads(stationId);
  const upload = await request(base, {
    body: {
      filename: file.name,
      sizeBytes: file.size,
      contentType: 'audio/wav',
      assetType: 'vt',
    },
    schema: uploadSchema,
    signal,
  });
  try {
    onProgress({ phase: 'uploading', pct: 0 });
    const numbers = Array.from({ length: upload.partCount }, (_, i) => i + 1);
    const { parts } = await request(`${base}/${upload.id}/parts`, {
      body: { partNumbers: numbers },
      schema: presignedUploadPartsSchema,
      signal,
    });
    let sent = 0;
    for (const part of parts) {
      const start = (part.partNumber - 1) * upload.partSize;
      // No content type: the presigned URL signs none.
      const blob = file.slice(start, Math.min(start + upload.partSize, file.size), '');
      let res: Response;
      try {
        res = await fetch(part.url, { method: 'PUT', body: blob, signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new ApiError(0, 'network', error instanceof Error ? error.message : 'upload failed');
      }
      if (!res.ok) throw new ApiError(res.status, 'upload_failed', `part ${part.partNumber}`);
      sent += blob.size;
      onProgress({ phase: 'uploading', pct: Math.floor((sent / Math.max(file.size, 1)) * 100) });
    }
    await request(`${base}/${upload.id}/complete`, {
      method: 'POST',
      schema: uploadSchema,
      signal,
    });
  } catch (error) {
    // Left unfinished: free the multipart upload (best effort).
    void request(`${base}/${upload.id}/abort`, { method: 'POST' }).catch(() => {});
    throw error;
  }
  onProgress({ phase: 'processing' });

  const deadline = Date.now() + (options.processingTimeoutMs ?? PROCESSING_TIMEOUT_MS);
  const wait =
    options.waitForChange ?? ((_id: string, ms: number, s?: AbortSignal) => sleep(ms, s));
  for (;;) {
    const current: Upload = await request(`${base}/${upload.id}`, { schema: uploadSchema, signal });
    if ((FINAL_UPLOAD_STATUSES as readonly string[]).includes(current.status)) {
      const assetId = current.assetId ?? current.duplicateOfAssetId;
      if (assetId) return assetId;
      throw new ApiError(
        422,
        current.errorCode ?? 'upload_failed',
        current.error ?? current.status,
      );
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new ApiError(0, 'still_processing', `upload ${upload.id} is still processing`);
    }
    await wait(upload.id, Math.min(options.pollMs ?? POLL_MS, left), signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
