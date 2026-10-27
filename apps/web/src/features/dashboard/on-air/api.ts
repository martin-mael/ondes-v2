import { onAirSchema } from '@ondes/shared';
import { queryOptions } from '@tanstack/react-query';
import { request } from '../../../app/api/client.ts';

// On air (#70): `GET …/on-air`, one snapshot of the air (ADR 0034).

export const onAirKey = (stationId: string) => ['stations', stationId, 'on-air'] as const;

export const onAirQuery = (stationId: string) =>
  queryOptions({
    queryKey: onAirKey(stationId),
    queryFn: () =>
      request(`/stations/${encodeURIComponent(stationId)}/on-air`, { schema: onAirSchema }),
  });
