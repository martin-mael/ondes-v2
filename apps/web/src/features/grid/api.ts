import {
  type CreateDaypart,
  type CreateGridOverride,
  clockGridSchema,
  daypartSchema,
  gridOverrideSchema,
  type UpdateClockGrid,
  type UpdateDaypart,
  type UpdateGridOverride,
} from '@ondes/shared';
import { queryOptions } from '@tanstack/react-query';
import { request } from '../../app/api/client.ts';

// Weekly clock grid api (#40): /api/v1/stations/:stationId/clock-grid.

const base = (stationId: string) => `/stations/${stationId}/clock-grid`;

export const gridKeys = {
  all: (stationId: string) => ['stations', stationId, 'clock-grid'] as const,
};

export const gridQuery = (stationId: string) =>
  queryOptions({
    queryKey: gridKeys.all(stationId),
    queryFn: ({ signal }) => request(base(stationId), { schema: clockGridSchema, signal }),
  });

export const gridApi = {
  save: (stationId: string, body: UpdateClockGrid) =>
    request(base(stationId), { method: 'PUT', body, schema: clockGridSchema }),
  createDaypart: (stationId: string, body: CreateDaypart) =>
    request(`${base(stationId)}/dayparts`, { method: 'POST', body, schema: daypartSchema }),
  updateDaypart: (stationId: string, id: string, body: UpdateDaypart) =>
    request(`${base(stationId)}/dayparts/${id}`, { method: 'PATCH', body, schema: daypartSchema }),
  removeDaypart: (stationId: string, id: string) =>
    request(`${base(stationId)}/dayparts/${id}`, { method: 'DELETE' }),
  createOverride: (stationId: string, body: CreateGridOverride) =>
    request(`${base(stationId)}/overrides`, { method: 'POST', body, schema: gridOverrideSchema }),
  updateOverride: (stationId: string, id: string, body: UpdateGridOverride) =>
    request(`${base(stationId)}/overrides/${id}`, {
      method: 'PATCH',
      body,
      schema: gridOverrideSchema,
    }),
  removeOverride: (stationId: string, id: string) =>
    request(`${base(stationId)}/overrides/${id}`, { method: 'DELETE' }),
};
