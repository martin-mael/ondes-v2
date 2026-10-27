import {
  liveRecordingSchema,
  liveRecordingSettingsSchema,
  type UpdateLiveRecordingSettings,
} from '@ondes/shared';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { request } from '../../../app/api/client.ts';

// Live recording api (#67, ADR 0039): the station's settings, an episode's recording, and a
// rebuild. Shared by the settings page and the shows feature's episode dialog.

const station = (stationId: string) => `/stations/${encodeURIComponent(stationId)}`;
const episodeRecordingSchema = z.object({ recording: liveRecordingSchema.nullable() });

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
  episode: (stationId: string, showId: string, episodeId: string) =>
    request(
      `${station(stationId)}/shows/${encodeURIComponent(showId)}/episodes/${encodeURIComponent(episodeId)}/recording`,
      { schema: episodeRecordingSchema },
    ),
  rebuild: (stationId: string, recordingId: string) =>
    request(`${station(stationId)}/live/recordings/${encodeURIComponent(recordingId)}/rebuild`, {
      method: 'POST',
      schema: liveRecordingSchema,
    }),
};

export const liveRecordingKeys = {
  all: (stationId: string) => ['stations', stationId, 'live-recording'] as const,
  settings: (stationId: string) => [...liveRecordingKeys.all(stationId), 'settings'] as const,
  episode: (stationId: string, episodeId: string) =>
    [...liveRecordingKeys.all(stationId), 'episode', episodeId] as const,
};

export const liveRecordingSettingsQuery = (stationId: string) =>
  queryOptions({
    queryKey: liveRecordingKeys.settings(stationId),
    queryFn: () => liveRecordingApi.settings(stationId),
  });

export const episodeRecordingQuery = (stationId: string, showId: string, episodeId: string) =>
  queryOptions({
    queryKey: liveRecordingKeys.episode(stationId, episodeId),
    queryFn: () => liveRecordingApi.episode(stationId, showId, episodeId),
  });
