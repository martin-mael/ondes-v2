import { liveRecordingSettingsSchema, type UpdateLiveRecordingSettings } from '@ondes/shared';
import { queryOptions } from '@tanstack/react-query';
import { request } from '../../../app/api/client.ts';

// Live recording settings api (#67, ADR 0039). An episode's recording is the shows
// feature's (features/shows/recording.ts).

const station = (stationId: string) => `/stations/${encodeURIComponent(stationId)}`;

export const liveRecordingApi = {
  settings: (stationId: string) =>
    request(`${station(stationId)}/live/recording/settings`, {
      schema: liveRecordingSettingsSchema,
    }),
  updateSettings: (stationId: string, body: UpdateLiveRecordingSettings) =>
    request(`${station(stationId)}/live/recording/settings`, {
      method: 'PUT',
      body,
      schema: liveRecordingSettingsSchema,
    }),
};

export const liveRecordingKeys = {
  all: (stationId: string) => ['stations', stationId, 'live-recording'] as const,
  settings: (stationId: string) => [...liveRecordingKeys.all(stationId), 'settings'] as const,
};

export const liveRecordingSettingsQuery = (stationId: string) =>
  queryOptions({
    queryKey: liveRecordingKeys.settings(stationId),
    queryFn: () => liveRecordingApi.settings(stationId),
  });
