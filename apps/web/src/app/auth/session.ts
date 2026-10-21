import type { Me, MyOrg, MyStation } from '@ondes/shared';
import { type QueryClient, queryOptions, useSuspenseQuery } from '@tanstack/react-query';
import { authApi } from '../api/auth.ts';
import { isApiError } from '../api/client.ts';

// The signed-in user and what they can open. `me` is `null` when signed out (401), so route
// guards can branch on it without catching.

export const meQuery = queryOptions({
  queryKey: ['auth', 'me'],
  queryFn: async (): Promise<Me | null> => {
    try {
      return await authApi.me();
    } catch (error) {
      if (isApiError(error) && (error.status === 401 || error.code === 'session_required')) {
        return null;
      }
      throw error;
    }
  },
  staleTime: 60_000,
});

export const orgsQuery = queryOptions({
  queryKey: ['auth', 'orgs'],
  queryFn: async () => (await authApi.orgs()).orgs,
  staleTime: 60_000,
});

/** The signed-in user. Only under the protected layout, which guarantees one. */
export function useMe(): Me {
  const { data } = useSuspenseQuery(meQuery);
  if (!data) throw new Error('useMe outside the signed-in layout');
  return data;
}

export function useOrgs(): MyOrg[] {
  return useSuspenseQuery(orgsQuery).data;
}

export function findStation(
  orgs: readonly MyOrg[],
  stationId: string,
): { org: MyOrg; station: MyStation } | null {
  for (const org of orgs) {
    const station = org.stations.find((s) => s.id === stationId);
    if (station) return { org, station };
  }
  return null;
}

const LAST_STATION_KEY = 'ondes.lastStation';

export const lastStation = {
  get: (): string | null => globalThis.localStorage?.getItem(LAST_STATION_KEY) ?? null,
  set: (stationId: string) => globalThis.localStorage?.setItem(LAST_STATION_KEY, stationId),
};

/** Where to land after sign-in: the last station used if still reachable, else the first. */
export function homeStation(orgs: readonly MyOrg[]): MyStation | null {
  const last = lastStation.get();
  if (last) {
    const found = findStation(orgs, last);
    if (found) return found.station;
  }
  return orgs.flatMap((org) => org.stations)[0] ?? null;
}

/** Forget everything about the previous user (sign-in, sign-out). */
export async function resetSession(queryClient: QueryClient, me: Me | null = null) {
  await queryClient.cancelQueries();
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
  queryClient.removeQueries({ queryKey: orgsQuery.queryKey });
  queryClient.setQueryData(meQuery.queryKey, me);
}
