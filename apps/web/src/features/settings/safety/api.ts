import {
  type AddSafetyAssets,
  assetPageSchema,
  FINAL_UPLOAD_STATUSES,
  type ListAssetsQuery,
  presignedUploadPartsSchema,
  type SetEmergencyAsset,
  type SetSafetyAssets,
  safetyStatusSchema,
  type Upload,
  uploadSchema,
} from '@ondes/shared';
import { queryOptions } from '@tanstack/react-query';
import { ApiError, request } from '../../../app/api/client.ts';

// The safety api (#34) and the two library calls the page needs: asset search and upload.

const station = (stationId: string) => `/stations/${encodeURIComponent(stationId)}`;

export const safetyApi = {
  status: (stationId: string) =>
    request(`${station(stationId)}/safety`, { schema: safetyStatusSchema }),
  setAssets: (stationId: string, body: SetSafetyAssets) =>
    request(`${station(stationId)}/safety/assets`, {
      method: 'PUT',
      body,
      schema: safetyStatusSchema,
    }),
  addAssets: (stationId: string, body: AddSafetyAssets) =>
    request(`${station(stationId)}/safety/assets`, { body, schema: safetyStatusSchema }),
  removeAsset: (stationId: string, assetId: string) =>
    request(`${station(stationId)}/safety/assets/${encodeURIComponent(assetId)}`, {
      method: 'DELETE',
    }),
  setEmergency: (stationId: string, body: SetEmergencyAsset) =>
    request(`${station(stationId)}/safety/emergency`, {
      method: 'PUT',
      body,
      schema: safetyStatusSchema,
    }),
  searchAssets: (stationId: string, query: ListAssetsQuery, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    return request(`${station(stationId)}/assets?${params}`, { schema: assetPageSchema, signal });
  },
};

export const safetyQuery = (stationId: string) =>
  queryOptions({
    queryKey: ['stations', stationId, 'safety'],
    queryFn: () => safetyApi.status(stationId),
  });

export type UploadProgress = { phase: 'uploading'; pct: number } | { phase: 'processing' };

/**
 * Uploads a file to the library (#18: S3 multipart through presigned part URLs) and waits for
 * ingest. Resolves with the asset id, or the existing one when the file is a duplicate.
 */
export async function uploadToLibrary(
  stationId: string,
  file: File,
  onProgress: (p: UploadProgress) => void,
  options: { pollMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const base = `${station(stationId)}/uploads`;
  const upload = await request(base, {
    body: {
      filename: file.name,
      sizeBytes: file.size,
      contentType: file.type || undefined,
      assetType: 'other',
    },
    schema: uploadSchema,
  });
  const numbers = Array.from({ length: upload.partCount }, (_, i) => i + 1);
  let sent = 0;
  for (let i = 0; i < numbers.length; i += 1000) {
    const { parts } = await request(`${base}/${upload.id}/parts`, {
      body: { partNumbers: numbers.slice(i, i + 1000) },
      schema: presignedUploadPartsSchema,
    });
    for (const part of parts) {
      const start = (part.partNumber - 1) * upload.partSize;
      const blob = file.slice(start, Math.min(start + upload.partSize, file.size));
      const res = await fetch(part.url, { method: 'PUT', body: blob, signal: options.signal });
      if (!res.ok) throw new ApiError(res.status, 'upload_failed', `part ${part.partNumber}`);
      sent += blob.size;
      onProgress({ phase: 'uploading', pct: Math.floor((sent / Math.max(file.size, 1)) * 100) });
    }
  }
  await request(`${base}/${upload.id}/complete`, { method: 'POST', schema: uploadSchema });
  onProgress({ phase: 'processing' });

  for (;;) {
    const current: Upload = await request(`${base}/${upload.id}`, {
      schema: uploadSchema,
      signal: options.signal,
    });
    if ((FINAL_UPLOAD_STATUSES as readonly string[]).includes(current.status)) {
      const assetId = current.assetId ?? current.duplicateOfAssetId;
      if (assetId) return assetId;
      throw new ApiError(
        422,
        current.errorCode ?? 'upload_failed',
        current.error ?? current.status,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 2000));
  }
}
