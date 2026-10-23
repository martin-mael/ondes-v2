import {
  assetPageSchema,
  type CreatePromo,
  type CreateVtPool,
  type ListPromosQuery,
  promoListSchema,
  promoPlaysSchema,
  promoSchema,
  type UpdatePromo,
  type UpdateVtPool,
  vtPoolListSchema,
  vtPoolSchema,
} from '@ondes/shared';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { request } from '../../app/api/client.ts';

// Promo VTs and VT pools api (#60): /api/v1/stations/:stationId/{promos,vt-pools}.

const station = (stationId: string) => `/stations/${encodeURIComponent(stationId)}`;
const pools = (stationId: string) => `${station(stationId)}/vt-pools`;
const promos = (stationId: string) => `${station(stationId)}/promos`;
const promo = (stationId: string, promoId: string) =>
  `${promos(stationId)}/${encodeURIComponent(promoId)}`;

export const promoKeys = {
  all: (stationId: string) => ['stations', stationId, 'promos'] as const,
  pools: (stationId: string) => [...promoKeys.all(stationId), 'pools'] as const,
  list: (stationId: string, filter: ListPromosQuery) =>
    [...promoKeys.all(stationId), 'list', filter] as const,
  plays: (stationId: string, promoId: string) =>
    [...promoKeys.all(stationId), 'plays', promoId] as const,
  assets: (stationId: string, q: string) => [...promoKeys.all(stationId), 'assets', q] as const,
};

/** The station's VT pools (the clock editor's promo slots pick one too). */
export const vtPoolsQuery = (stationId: string) =>
  queryOptions({
    queryKey: promoKeys.pools(stationId),
    queryFn: ({ signal }) => request(pools(stationId), { schema: vtPoolListSchema, signal }),
  });

export const promosQuery = (stationId: string, filter: ListPromosQuery = {}) =>
  queryOptions({
    queryKey: promoKeys.list(stationId, filter),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (filter.poolId) params.set('poolId', filter.poolId);
      if (filter.status) params.set('status', filter.status);
      const query = params.size ? `?${params}` : '';
      return request(`${promos(stationId)}${query}`, { schema: promoListSchema, signal });
    },
  });

export const promoPlaysQuery = (stationId: string, promoId: string) =>
  queryOptions({
    queryKey: promoKeys.plays(stationId, promoId),
    queryFn: ({ signal }) =>
      request(`${promo(stationId, promoId)}/plays`, { schema: promoPlaysSchema, signal }),
  });

export const promosApi = {
  createPool: (stationId: string, body: CreateVtPool) =>
    request(pools(stationId), { body, schema: vtPoolSchema }),
  updatePool: (stationId: string, poolId: string, body: UpdateVtPool) =>
    request(`${pools(stationId)}/${encodeURIComponent(poolId)}`, {
      method: 'PATCH',
      body,
      schema: vtPoolSchema,
    }),
  removePool: (stationId: string, poolId: string) =>
    request(`${pools(stationId)}/${encodeURIComponent(poolId)}`, { method: 'DELETE' }),
  get: (stationId: string, promoId: string) =>
    request(promo(stationId, promoId), { schema: promoSchema }),
  create: (stationId: string, body: CreatePromo) =>
    request(promos(stationId), { body, schema: promoSchema }),
  update: (stationId: string, promoId: string, body: UpdatePromo) =>
    request(promo(stationId, promoId), { method: 'PATCH', body, schema: promoSchema }),
  remove: (stationId: string, promoId: string) =>
    request(promo(stationId, promoId), { method: 'DELETE' }),
  /** Voice tracks of the library, for a new promo. */
  searchVoiceTracks: (stationId: string, q: string, signal?: AbortSignal) => {
    const params = new URLSearchParams({ type: 'vt', limit: '30' });
    if (q) params.set('q', q);
    return request(`${station(stationId)}/assets?${params}`, { schema: assetPageSchema, signal });
  },
};

/** After any promo or pool write: lists, pools, plays. */
export const invalidatePromos = (queryClient: QueryClient, stationId: string) =>
  queryClient.invalidateQueries({ queryKey: promoKeys.all(stationId) });
