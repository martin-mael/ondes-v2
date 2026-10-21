import {
  assetPageSchema,
  type CreateCategory,
  categoryDetailSchema,
  categoryListSchema,
  categoryPreviewSchema,
  type DraftPreview,
  type UpdateCategory,
} from '@ondes/shared';
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { request } from '../../../app/api/client.ts';

// Categories api (#37): /api/v1/stations/:stationId/categories.

const base = (stationId: string) => `/stations/${stationId}/categories`;

export const categoryKeys = {
  all: (stationId: string) => ['stations', stationId, 'categories'] as const,
  one: (stationId: string, id: string) => ['stations', stationId, 'categories', id] as const,
};

export const categoriesQuery = (stationId: string) =>
  queryOptions({
    queryKey: categoryKeys.all(stationId),
    queryFn: ({ signal }) => request(base(stationId), { schema: categoryListSchema, signal }),
  });

export const categoryQuery = (stationId: string, id: string) =>
  queryOptions({
    queryKey: categoryKeys.one(stationId, id),
    queryFn: ({ signal }) =>
      request(`${base(stationId)}/${id}`, { schema: categoryDetailSchema, signal }),
  });

export const categoriesApi = {
  create: (stationId: string, body: CreateCategory) =>
    request(base(stationId), { method: 'POST', body, schema: categoryDetailSchema }),
  update: (stationId: string, id: string, body: UpdateCategory) =>
    request(`${base(stationId)}/${id}`, { method: 'PATCH', body, schema: categoryDetailSchema }),
  remove: (stationId: string, id: string) =>
    request(`${base(stationId)}/${id}`, { method: 'DELETE' }),
};

/** Value that settles `delay` ms after its last change. */
export function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/**
 * Live preview of a draft category. The draft is debounced; the last preview stays on screen
 * while the next one loads.
 */
export function useDraftPreview(
  stationId: string,
  draft: DraftPreview,
  { enabled = true, delay = 300 }: { enabled?: boolean; delay?: number } = {},
) {
  const settled = useDebounced(JSON.stringify(draft), delay);
  return useQuery({
    queryKey: [...categoryKeys.all(stationId), 'preview', settled],
    queryFn: ({ signal }) =>
      request(`${base(stationId)}/preview`, {
        body: JSON.parse(settled) as DraftPreview,
        schema: categoryPreviewSchema,
        signal,
      }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Library search for manual members. */
export function useAssetSearch(stationId: string, q: string, type: string) {
  const settled = useDebounced(q.trim(), 250);
  return useQuery({
    queryKey: ['stations', stationId, 'assets', 'search', type, settled],
    queryFn: ({ signal }) =>
      request(
        `/stations/${stationId}/assets?${new URLSearchParams({ q: settled, type, limit: '10' })}`,
        { schema: assetPageSchema, signal },
      ),
    enabled: settled.length > 0,
  });
}
