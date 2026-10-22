import {
  type CreateSegue,
  segueListSchema,
  segueMediaResponseSchema,
  segueSchema,
  type UpdateSegue,
} from '@ondes/shared';
import { queryOptions } from '@tanstack/react-query';
import { request } from '../../app/api/client.ts';

// The segue editor's calls (#58): the segue of a transition, its lanes' media, and saves. A
// save re-derives the islands in the api; #56's renderer picks up the pending island from there.

const station = (stationId: string) => `/stations/${encodeURIComponent(stationId)}`;

export const segueApi = {
  /** The segue from `fromItemId` to `toItemId`, or null when the transition has none yet. */
  find: async (stationId: string, fromItemId: string, toItemId: string, signal?: AbortSignal) => {
    const { items } = await request(
      `${station(stationId)}/segues?itemId=${encodeURIComponent(fromItemId)}`,
      { schema: segueListSchema, signal },
    );
    return items.find((s) => s.fromItemId === fromItemId && s.toItemId === toItemId) ?? null;
  },
  media: (stationId: string, itemIds: string[], assetIds: string[], signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (itemIds.length) query.set('itemIds', itemIds.join(','));
    if (assetIds.length) query.set('assetIds', assetIds.join(','));
    return request(`${station(stationId)}/segues/media?${query}`, {
      schema: segueMediaResponseSchema,
      signal,
    });
  },
  create: (stationId: string, body: CreateSegue) =>
    request(`${station(stationId)}/segues`, { body, schema: segueSchema }),
  update: (stationId: string, segueId: string, body: UpdateSegue) =>
    request(`${station(stationId)}/segues/${encodeURIComponent(segueId)}`, {
      method: 'PUT',
      body,
      schema: segueSchema,
    }),
};

export const segueKey = (stationId: string, fromItemId: string, toItemId: string) =>
  ['stations', stationId, 'segues', 'transition', fromItemId, toItemId] as const;

export const segueQuery = (stationId: string, fromItemId: string, toItemId: string) =>
  queryOptions({
    queryKey: segueKey(stationId, fromItemId, toItemId),
    queryFn: ({ signal }) => segueApi.find(stationId, fromItemId, toItemId, signal),
  });

/** Media of A, B and the voices. Voices are sorted so adding one back hits the cache. */
export const segueMediaQuery = (
  stationId: string,
  fromItemId: string,
  toItemId: string,
  voiceAssetIds: readonly string[],
) => {
  const assetIds = [...new Set(voiceAssetIds)].sort();
  return queryOptions({
    queryKey: ['stations', stationId, 'segues', 'media', fromItemId, toItemId, assetIds],
    queryFn: ({ signal }) => segueApi.media(stationId, [fromItemId, toItemId], assetIds, signal),
    staleTime: 30_000,
  });
};
