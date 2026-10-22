import {
  type CreateStreamer,
  liveConnectionInfoSchema,
  type SetStreamerPassword,
  streamerListSchema,
  streamerSchema,
  streamerWithPasswordSchema,
  type UpdateStreamer,
  uuidSchema,
} from '@ondes/shared';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { request } from '../../app/api/client.ts';

// Live streamers api (#63) under /api/v1/stations/:stationId/live.

const live = (stationId: string) => `/stations/${encodeURIComponent(stationId)}/live`;
const streamer = (stationId: string, streamerId: string) =>
  `${live(stationId)}/streamers/${encodeURIComponent(streamerId)}`;

export const liveKeys = {
  all: (stationId: string) => ['stations', stationId, 'live'] as const,
  streamers: (stationId: string) => [...liveKeys.all(stationId), 'streamers'] as const,
  candidates: (stationId: string) => [...liveKeys.all(stationId), 'candidates'] as const,
  connection: (stationId: string) => [...liveKeys.all(stationId), 'connection'] as const,
};

export const streamersQuery = (stationId: string) =>
  queryOptions({
    queryKey: liveKeys.streamers(stationId),
    queryFn: ({ signal }) =>
      request(`${live(stationId)}/streamers`, { schema: streamerListSchema, signal }),
  });

const candidatesSchema = z.object({
  users: z.array(z.object({ id: uuidSchema, name: z.string() })),
});

/** Members a streamer can be linked to. Needs `live:manage`. */
export const userCandidatesQuery = (stationId: string) =>
  queryOptions({
    queryKey: liveKeys.candidates(stationId),
    queryFn: ({ signal }) =>
      request(`${live(stationId)}/streamers/user-candidates`, { schema: candidatesSchema, signal }),
  });

export const connectionQuery = (stationId: string) =>
  queryOptions({
    queryKey: liveKeys.connection(stationId),
    queryFn: ({ signal }) =>
      request(`${live(stationId)}/connection`, { schema: liveConnectionInfoSchema, signal }),
  });

export const liveApi = {
  create: (stationId: string, body: CreateStreamer) =>
    request(`${live(stationId)}/streamers`, { body, schema: streamerWithPasswordSchema }),
  update: (stationId: string, streamerId: string, body: UpdateStreamer) =>
    request(streamer(stationId, streamerId), { method: 'PATCH', body, schema: streamerSchema }),
  setPassword: (stationId: string, streamerId: string, body: SetStreamerPassword = {}) =>
    request(`${streamer(stationId, streamerId)}/password`, {
      body,
      schema: streamerWithPasswordSchema,
    }),
  remove: (stationId: string, streamerId: string) =>
    request(streamer(stationId, streamerId), { method: 'DELETE' }),
};

export const invalidateLive = (queryClient: QueryClient, stationId: string) =>
  queryClient.invalidateQueries({ queryKey: liveKeys.all(stationId) });
