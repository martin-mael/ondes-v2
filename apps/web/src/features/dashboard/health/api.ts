import {
  currentListenersSchema,
  engineStatusViewSchema,
  listenerHistorySchema,
  liveStatusSchema,
} from '@ondes/shared';
import { queryOptions } from '@tanstack/react-query';
import { request } from '../../../app/api/client.ts';

// The dashboard's health panels (#71): engine status (#35), live sources (#64), listener counts
// (#32's poller, read through the listeners api).

const station = (stationId: string) => `/stations/${encodeURIComponent(stationId)}`;

export const healthKeys = {
  engine: (stationId: string) => ['stations', stationId, 'health', 'engine'] as const,
  live: (stationId: string) => ['stations', stationId, 'health', 'live'] as const,
  listeners: (stationId: string) => ['stations', stationId, 'health', 'listeners'] as const,
  history: (stationId: string) =>
    ['stations', stationId, 'health', 'listeners', 'history'] as const,
};

export const engineStatusQuery = (stationId: string) =>
  queryOptions({
    queryKey: healthKeys.engine(stationId),
    queryFn: ({ signal }) =>
      request(`${station(stationId)}/engine`, { schema: engineStatusViewSchema, signal }),
  });

export const liveStatusQuery = (stationId: string) =>
  queryOptions({
    queryKey: healthKeys.live(stationId),
    queryFn: ({ signal }) =>
      request(`${station(stationId)}/live/status`, { schema: liveStatusSchema, signal }),
  });

export const currentListenersQuery = (stationId: string) =>
  queryOptions({
    queryKey: healthKeys.listeners(stationId),
    queryFn: ({ signal }) =>
      request(`${station(stationId)}/listeners`, { schema: currentListenersSchema, signal }),
  });

export const listenerHistoryQuery = (stationId: string) =>
  queryOptions({
    queryKey: healthKeys.history(stationId),
    queryFn: ({ signal }) =>
      request(`${station(stationId)}/listeners/history?hours=24`, {
        schema: listenerHistorySchema,
        signal,
      }),
  });
