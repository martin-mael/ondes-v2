import { asRunOverlaySchema, type LocalDate } from '@ondes/shared';
import { queryOptions } from '@tanstack/react-query';
import { request } from '../../../app/api/client.ts';

// The log vs as-run overlay of one station-local day (#53, `GET …/asrun/overlay`). Under the
// as-run key, so the timeline's refetch after a dropped stream refreshes it too.

export const overlayKey = (stationId: string) => ['stations', stationId, 'asrun', 'overlay'];

export const overlayQuery = (stationId: string, date: LocalDate) =>
  queryOptions({
    queryKey: [...overlayKey(stationId), date],
    queryFn: ({ signal }) =>
      request(
        `/stations/${encodeURIComponent(stationId)}/asrun/overlay?date=${encodeURIComponent(date)}`,
        { schema: asRunOverlaySchema, signal },
      ),
  });
