import {
  assetDetailSchema,
  assetPageSchema,
  type ClockSlot,
  type CreateClock,
  clockDetailSchema,
  clockEstimateSchema,
  clockListSchema,
  clockPreviewSchema,
  type DraftClockPreview,
  type UpdateClock,
} from '@ondes/shared';
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { request } from '../../app/api/client.ts';

// Clocks api (#39): /api/v1/stations/:stationId/clocks.

const base = (stationId: string) => `/stations/${stationId}/clocks`;

export const clockKeys = {
  all: (stationId: string) => ['stations', stationId, 'clocks'] as const,
  one: (stationId: string, id: string) => ['stations', stationId, 'clocks', id] as const,
};

export const clocksQuery = (stationId: string) =>
  queryOptions({
    queryKey: clockKeys.all(stationId),
    queryFn: ({ signal }) => request(base(stationId), { schema: clockListSchema, signal }),
  });

export const clockQuery = (stationId: string, id: string) =>
  queryOptions({
    queryKey: clockKeys.one(stationId, id),
    queryFn: ({ signal }) =>
      request(`${base(stationId)}/${id}`, { schema: clockDetailSchema, signal }),
  });

export const clocksApi = {
  create: (stationId: string, body: CreateClock) =>
    request(base(stationId), { method: 'POST', body, schema: clockDetailSchema }),
  update: (stationId: string, id: string, body: UpdateClock) =>
    request(`${base(stationId)}/${id}`, { method: 'PATCH', body, schema: clockDetailSchema }),
  duplicate: (stationId: string, id: string) =>
    request(`${base(stationId)}/${id}/duplicate`, {
      method: 'POST',
      body: {},
      schema: clockDetailSchema,
    }),
  remove: (stationId: string, id: string) =>
    request(`${base(stationId)}/${id}`, { method: 'DELETE' }),
  preview: (stationId: string, body: DraftClockPreview) =>
    request(`${base(stationId)}/preview`, { method: 'POST', body, schema: clockPreviewSchema }),
};

/** Value that settles `delay` ms after its last change. */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/**
 * Live timeline of the clock being edited (`null` while the draft is invalid). Debounced; the
 * last estimate stays on screen while the next one loads.
 */
export function useDraftEstimate(
  stationId: string,
  draft: { targetDurationMs: number; slots: ClockSlot[] } | null,
  delay = 250,
) {
  const settled = useDebounced(draft ? JSON.stringify(draft) : null, delay);
  return useQuery({
    queryKey: [...clockKeys.all(stationId), 'estimate', settled],
    queryFn: ({ signal }) =>
      request(`${base(stationId)}/estimate`, {
        body: JSON.parse(settled as string),
        schema: clockEstimateSchema,
        signal,
      }),
    placeholderData: keepPreviousData,
    enabled: settled !== null,
  });
}

/** Library search for fixed-item slots. */
export function useAssetSearch(stationId: string, q: string) {
  const settled = useDebounced(q.trim(), 250);
  return useQuery({
    queryKey: ['stations', stationId, 'assets', 'search', '', settled],
    queryFn: ({ signal }) =>
      request(`/stations/${stationId}/assets?${new URLSearchParams({ q: settled, limit: '8' })}`, {
        schema: assetPageSchema,
        signal,
      }),
    enabled: settled.length > 0,
  });
}

/** One asset, for a fixed-item slot's title. */
export function useAsset(stationId: string, assetId: string | null) {
  return useQuery({
    queryKey: ['stations', stationId, 'assets', assetId],
    queryFn: ({ signal }) =>
      request(`/stations/${stationId}/assets/${assetId}`, { schema: assetDetailSchema, signal }),
    enabled: assetId !== null,
    retry: false,
  });
}
