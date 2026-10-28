import { episodeLiveRecordingSchema, liveRecordingSchema } from '@ondes/shared';
import { queryOptions } from '@tanstack/react-query';
import { request } from '../../app/api/client.ts';

// A live episode's recording (#67, ADR 0039): read it, build it again, or make it the
// episode's audio over other audio a build left alone.

const station = (stationId: string) => `/stations/${encodeURIComponent(stationId)}`;
const recording = (stationId: string, recordingId: string) =>
  `${station(stationId)}/live/recordings/${encodeURIComponent(recordingId)}`;

export const episodeRecordingApi = {
  get: (stationId: string, showId: string, episodeId: string) =>
    request(
      `${station(stationId)}/shows/${encodeURIComponent(showId)}/episodes/${encodeURIComponent(episodeId)}/recording`,
      { schema: episodeLiveRecordingSchema },
    ),
  rebuild: (stationId: string, recordingId: string) =>
    request(`${recording(stationId, recordingId)}/rebuild`, {
      method: 'POST',
      schema: liveRecordingSchema,
    }),
  attach: (stationId: string, recordingId: string) =>
    request(`${recording(stationId, recordingId)}/attach`, {
      method: 'POST',
      schema: liveRecordingSchema,
    }),
};

export const episodeRecordingQuery = (stationId: string, showId: string, episodeId: string) =>
  queryOptions({
    queryKey: ['stations', stationId, 'live-recording', 'episode', episodeId] as const,
    queryFn: () => episodeRecordingApi.get(stationId, showId, episodeId),
  });
