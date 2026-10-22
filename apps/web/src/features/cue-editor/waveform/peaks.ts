import { type DecodedPeaks, decodePeaks } from '@ondes/shared';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { API_BASE, ApiError } from '../../../app/api/client.ts';

// Peaks of an asset (#22) for the waveform: `GET …/assets/:assetId/peaks`, a binary file parsed
// with `decodePeaks`. With the peaks file's sha256 (`AssetDetail.files`, role `peaks`) the URL is
// `?v=<sha256>`, which the api serves as immutable, so the browser cache answers next time.

export const peaksKey = (stationId: string, assetId: string, sha256?: string) =>
  ['stations', stationId, 'library', 'asset', assetId, 'peaks', sha256 ?? null] as const;

export async function fetchPeaks(
  stationId: string,
  assetId: string,
  sha256?: string,
  signal?: AbortSignal,
): Promise<DecodedPeaks> {
  const query = sha256 ? `?v=${encodeURIComponent(sha256)}` : '';
  let res: Response;
  try {
    const path = `/stations/${encodeURIComponent(stationId)}/assets/${encodeURIComponent(assetId)}`;
    res = await fetch(`${API_BASE}${path}/peaks${query}`, {
      credentials: 'same-origin',
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, 'network', error instanceof Error ? error.message : 'network error');
  }
  if (!res.ok) {
    throw new ApiError(res.status, res.status === 404 ? 'not_found' : 'http_error', res.statusText);
  }
  return decodePeaks(new Uint8Array(await res.arrayBuffer()));
}

export const peaksQuery = (stationId: string, assetId: string, sha256?: string, enabled = true) =>
  queryOptions({
    enabled,
    queryKey: peaksKey(stationId, assetId, sha256),
    queryFn: ({ signal }) => fetchPeaks(stationId, assetId, sha256, signal),
    // A versioned file never changes; an unversioned one is revalidated by the browser (ETag).
    staleTime: sha256 ? Number.POSITIVE_INFINITY : 60_000,
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });

/**
 * The decoded peaks of an asset (a TanStack query). 404 (`not_found`) while none exist yet.
 * `enabled: false` (e.g. the asset lists no peaks file) sends nothing.
 */
export function usePeaks(stationId: string, assetId: string, sha256?: string, enabled = true) {
  return useQuery(peaksQuery(stationId, assetId, sha256, enabled));
}
