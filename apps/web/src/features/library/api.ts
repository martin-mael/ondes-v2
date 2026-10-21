import {
  assetActivitySchema,
  assetDetailSchema,
  type LibraryBulk,
  type LibraryFilter,
  type LibrarySort,
  libraryBulkResultSchema,
  libraryFacetsSchema,
  librarySearchPageSchema,
  type SortDirection,
  tagSchema,
} from '@ondes/shared';
import {
  infiniteQueryOptions,
  keepPreviousData,
  type QueryClient,
  queryOptions,
} from '@tanstack/react-query';
import { z } from 'zod';
import { request } from '../../app/api/client.ts';

// Library api (#23): search, facets and bulk edits under /stations/:id/library, the asset
// detail and tags from #17's routes.

const station = (stationId: string) => `/stations/${stationId}`;

export const libraryKeys = {
  all: (stationId: string) => ['stations', stationId, 'library'] as const,
  search: (stationId: string, filter: LibraryFilter, sort: LibrarySort, dir: SortDirection) =>
    ['stations', stationId, 'library', 'search', { filter, sort, dir }] as const,
  facets: (stationId: string, filter: LibraryFilter) =>
    ['stations', stationId, 'library', 'facets', filter] as const,
  asset: (stationId: string, assetId: string) =>
    ['stations', stationId, 'library', 'asset', assetId] as const,
  activity: (stationId: string, assetId: string) =>
    ['stations', stationId, 'library', 'asset', assetId, 'activity'] as const,
  tags: (stationId: string) => ['stations', stationId, 'library', 'tags'] as const,
};

export const PAGE_SIZE = 100;

export const searchQuery = (
  stationId: string,
  filter: LibraryFilter,
  sort: LibrarySort,
  direction: SortDirection,
) =>
  infiniteQueryOptions({
    queryKey: libraryKeys.search(stationId, filter, sort, direction),
    queryFn: ({ pageParam, signal }) =>
      request(`${station(stationId)}/library/search`, {
        body: { filter, sort, direction, limit: PAGE_SIZE, cursor: pageParam },
        schema: librarySearchPageSchema,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });

export const facetsQuery = (stationId: string, filter: LibraryFilter) =>
  queryOptions({
    queryKey: libraryKeys.facets(stationId, filter),
    queryFn: ({ signal }) =>
      request(`${station(stationId)}/library/facets`, {
        body: { filter },
        schema: libraryFacetsSchema,
        signal,
      }),
    placeholderData: keepPreviousData,
  });

export const assetQuery = (stationId: string, assetId: string) =>
  queryOptions({
    queryKey: libraryKeys.asset(stationId, assetId),
    queryFn: ({ signal }) =>
      request(`${station(stationId)}/assets/${assetId}`, { schema: assetDetailSchema, signal }),
  });

export const activityQuery = (stationId: string, assetId: string) =>
  queryOptions({
    queryKey: libraryKeys.activity(stationId, assetId),
    queryFn: ({ signal }) =>
      request(`${station(stationId)}/library/assets/${assetId}/activity`, {
        schema: assetActivitySchema,
        signal,
      }),
  });

export const tagsQuery = (stationId: string) =>
  queryOptions({
    queryKey: libraryKeys.tags(stationId),
    queryFn: ({ signal }) =>
      request(`${station(stationId)}/tags`, {
        schema: z.object({ tags: z.array(tagSchema) }),
        signal,
      }),
    staleTime: 60_000,
  });

export const libraryApi = {
  bulk: (stationId: string, body: LibraryBulk) =>
    request(`${station(stationId)}/library/bulk`, { body, schema: libraryBulkResultSchema }),
};

/** After an edit or new assets: every library list, count and detail of the station. */
export const invalidateLibrary = (queryClient: QueryClient, stationId: string) =>
  queryClient.invalidateQueries({ queryKey: libraryKeys.all(stationId) });

/**
 * After new assets: the first page of every loaded search and the facet counts. The later
 * pages are dropped, not refetched (one request per list, however far it was scrolled).
 */
export async function refreshFirstPage(queryClient: QueryClient, stationId: string) {
  const searches = [...libraryKeys.all(stationId), 'search'];
  queryClient.setQueriesData<{ pages: unknown[]; pageParams: unknown[] }>(
    { queryKey: searches },
    (data) => data && { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) },
  );
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: searches }),
    queryClient.invalidateQueries({ queryKey: [...libraryKeys.all(stationId), 'facets'] }),
  ]);
}
