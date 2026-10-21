import {
  assetPageSchema,
  type CreateEpisode,
  type CreateShow,
  type CreateShowSlot,
  episodeListSchema,
  episodeSchema,
  FINAL_UPLOAD_STATUSES,
  type PutSlotException,
  presignedUploadPartsSchema,
  showHostCandidateListSchema,
  showListSchema,
  showOccurrencesResponseSchema,
  showSchema,
  showSlotChangeSchema,
  showSlotDeletedSchema,
  showSlotListSchema,
  showSlotSchema,
  type UpdateEpisode,
  type UpdateShow,
  type UpdateShowSlot,
  type Upload,
  uploadSchema,
} from '@ondes/shared';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { ApiError, request } from '../../app/api/client.ts';

// Shows api (#44, ADR 0014) under /api/v1/stations/:stationId, plus the two library calls the
// pages need: episode asset search and upload (#18).

const station = (stationId: string) => `/stations/${encodeURIComponent(stationId)}`;
const shows = (stationId: string) => `${station(stationId)}/shows`;
const show = (stationId: string, showId: string) =>
  `${shows(stationId)}/${encodeURIComponent(showId)}`;

export const showKeys = {
  /** Everything shows-related of a station: invalidated after any write. */
  all: (stationId: string) => ['stations', stationId, 'shows'] as const,
  list: (stationId: string) => [...showKeys.all(stationId), 'list'] as const,
  one: (stationId: string, showId: string) => [...showKeys.all(stationId), 'show', showId] as const,
  slots: (stationId: string, showId: string) =>
    [...showKeys.one(stationId, showId), 'slots'] as const,
  episodes: (stationId: string, showId: string, scheduled?: boolean) =>
    [...showKeys.one(stationId, showId), 'episodes', scheduled ?? 'all'] as const,
  occurrences: (stationId: string, from: string, to: string, showId?: string) =>
    [...showKeys.all(stationId), 'occurrences', from, to, showId ?? 'all'] as const,
  hosts: (stationId: string) => [...showKeys.all(stationId), 'hosts'] as const,
};

export const showsQuery = (stationId: string) =>
  queryOptions({
    queryKey: showKeys.list(stationId),
    queryFn: ({ signal }) => request(shows(stationId), { schema: showListSchema, signal }),
  });

export const showQuery = (stationId: string, showId: string) =>
  queryOptions({
    queryKey: showKeys.one(stationId, showId),
    queryFn: ({ signal }) => request(show(stationId, showId), { schema: showSchema, signal }),
  });

export const slotsQuery = (stationId: string, showId: string) =>
  queryOptions({
    queryKey: showKeys.slots(stationId, showId),
    queryFn: ({ signal }) =>
      request(`${show(stationId, showId)}/slots`, { schema: showSlotListSchema, signal }),
  });

/** `scheduled: false`: episodes planned in no occurrence (new, or detached from one). */
export const episodesQuery = (stationId: string, showId: string, scheduled?: boolean) =>
  queryOptions({
    queryKey: showKeys.episodes(stationId, showId, scheduled),
    queryFn: ({ signal }) =>
      request(
        `${show(stationId, showId)}/episodes${scheduled === undefined ? '' : `?scheduled=${scheduled}`}`,
        { schema: episodeListSchema, signal },
      ),
  });

export const occurrencesQuery = (stationId: string, from: Date, to: Date, showId?: string) => {
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  if (showId) params.set('showId', showId);
  return queryOptions({
    queryKey: showKeys.occurrences(stationId, from.toISOString(), to.toISOString(), showId),
    queryFn: ({ signal }) =>
      request(`${station(stationId)}/show-occurrences?${params}`, {
        schema: showOccurrencesResponseSchema,
        signal,
      }),
  });
};

/** Who may host (members of the station). Needs `show:write`. */
export const hostCandidatesQuery = (stationId: string) =>
  queryOptions({
    queryKey: showKeys.hosts(stationId),
    queryFn: ({ signal }) =>
      request(`${station(stationId)}/show-hosts`, {
        schema: showHostCandidateListSchema,
        signal,
      }),
  });

export const showsApi = {
  create: (stationId: string, body: CreateShow) =>
    request(shows(stationId), { body, schema: showSchema }),
  update: (stationId: string, showId: string, body: UpdateShow) =>
    request(show(stationId, showId), { method: 'PATCH', body, schema: showSchema }),
  remove: (stationId: string, showId: string) =>
    request(show(stationId, showId), { method: 'DELETE' }),

  createSlot: (stationId: string, showId: string, body: CreateShowSlot) =>
    request(`${show(stationId, showId)}/slots`, { body, schema: showSlotSchema }),
  updateSlot: (stationId: string, showId: string, slotId: string, body: UpdateShowSlot) =>
    request(`${show(stationId, showId)}/slots/${encodeURIComponent(slotId)}`, {
      method: 'PATCH',
      body,
      schema: showSlotChangeSchema,
    }),
  removeSlot: (stationId: string, showId: string, slotId: string) =>
    request(`${show(stationId, showId)}/slots/${encodeURIComponent(slotId)}`, {
      method: 'DELETE',
      schema: showSlotDeletedSchema,
    }),
  putException: (
    stationId: string,
    showId: string,
    slotId: string,
    date: string,
    body: PutSlotException,
  ) =>
    request(`${show(stationId, showId)}/slots/${encodeURIComponent(slotId)}/exceptions/${date}`, {
      method: 'PUT',
      body,
      schema: showSlotChangeSchema,
    }),
  removeException: (stationId: string, showId: string, slotId: string, date: string) =>
    request(`${show(stationId, showId)}/slots/${encodeURIComponent(slotId)}/exceptions/${date}`, {
      method: 'DELETE',
      schema: showSlotChangeSchema,
    }),

  createEpisode: (stationId: string, showId: string, body: CreateEpisode) =>
    request(`${show(stationId, showId)}/episodes`, { body, schema: episodeSchema }),
  updateEpisode: (stationId: string, showId: string, episodeId: string, body: UpdateEpisode) =>
    request(`${show(stationId, showId)}/episodes/${encodeURIComponent(episodeId)}`, {
      method: 'PATCH',
      body,
      schema: episodeSchema,
    }),
  removeEpisode: (stationId: string, showId: string, episodeId: string) =>
    request(`${show(stationId, showId)}/episodes/${encodeURIComponent(episodeId)}`, {
      method: 'DELETE',
    }),

  /** The station's `episode` assets, for attaching one to an episode. */
  searchEpisodeAssets: (stationId: string, q: string, signal?: AbortSignal) => {
    const params = new URLSearchParams({ type: 'episode', limit: '30' });
    if (q) params.set('q', q);
    return request(`${station(stationId)}/assets?${params}`, { schema: assetPageSchema, signal });
  },
};

/** After any shows write: lists, show pages, occurrences. */
export const invalidateShows = (queryClient: QueryClient, stationId: string) =>
  queryClient.invalidateQueries({ queryKey: showKeys.all(stationId) });

export type UploadProgress = { phase: 'uploading'; pct: number } | { phase: 'processing' };

/**
 * Uploads an episode file to the library (#18: S3 multipart through presigned part URLs) and
 * waits for ingest. Resolves with the asset id, or the existing one when the station already
 * has this exact file. Presenters may do this with `show:write_own`.
 */
export async function uploadEpisodeAudio(
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
      assetType: 'episode',
    },
    schema: uploadSchema,
  });
  onProgress({ phase: 'uploading', pct: 0 });
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
      let res: Response;
      try {
        res = await fetch(part.url, { method: 'PUT', body: blob, signal: options.signal });
      } catch (error) {
        throw new ApiError(0, 'network', error instanceof Error ? error.message : 'upload failed');
      }
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
