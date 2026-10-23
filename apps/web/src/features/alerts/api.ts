import {
  type AlertSeverity,
  alertListSchema,
  alertSchema,
  type ListAlertsQuery,
} from '@ondes/shared';
import { infiniteQueryOptions, type QueryClient } from '@tanstack/react-query';
import { request } from '../../app/api/client.ts';
import { useSse } from '../../app/sse/sse.tsx';

// Alerts api (#33) under /api/v1/stations/:stationId/alerts, for the alerts page and the
// dashboard's alerts panel (#71). Kept fresh by the `alert.*` events (no polling).

const base = (stationId: string) => `/stations/${encodeURIComponent(stationId)}/alerts`;

export type AlertFilter = Pick<ListAlertsQuery, 'status' | 'type'>;

export const alertKeys = {
  all: (stationId: string) => ['stations', stationId, 'alerts'] as const,
  list: (stationId: string, filter: AlertFilter) =>
    [...alertKeys.all(stationId), 'list', filter] as const,
};

export const alertsQuery = (stationId: string, filter: AlertFilter, limit = 50) =>
  infiniteQueryOptions({
    queryKey: [...alertKeys.list(stationId, filter), limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => {
      const params = new URLSearchParams({ status: filter.status ?? 'open', limit: String(limit) });
      if (filter.type) params.set('type', filter.type);
      if (pageParam) params.set('before', pageParam);
      return request(`${base(stationId)}?${params}`, { schema: alertListSchema, signal });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const alertsApi = {
  acknowledge: (stationId: string, alertId: string) =>
    request(`${base(stationId)}/${encodeURIComponent(alertId)}/acknowledge`, {
      method: 'POST',
      schema: alertSchema,
    }),
  resolve: (stationId: string, alertId: string) =>
    request(`${base(stationId)}/${encodeURIComponent(alertId)}/resolve`, {
      method: 'POST',
      schema: alertSchema,
    }),
};

export const invalidateAlerts = (queryClient: QueryClient, stationId: string) =>
  queryClient.invalidateQueries({ queryKey: alertKeys.all(stationId) });

/** Refetches the station's alert lists on every `alert.*` event: on screen within a second. */
export function useLiveAlerts(queryClient: QueryClient, stationId: string) {
  useSse((event) => {
    if (event.type.startsWith('alert.') && event.type !== 'alert.silence_settings.updated') {
      void invalidateAlerts(queryClient, stationId);
    }
  });
}

/** Most severe first. */
export const severityOrder: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
