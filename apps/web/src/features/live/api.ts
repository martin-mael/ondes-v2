import {
  type CreateLiveEvent,
  type CreateLiveHandover,
  type CreateStreamer,
  liveConnectionInfoSchema,
  liveEventListSchema,
  liveEventSchema,
  liveNowPlayingResponseSchema,
  liveNowPlayingSchema,
  liveHandoverListSchema,
  liveHandoverSchema,
  liveRequestListSchema,
  liveSessionSchema,
  type SetLiveNowPlaying,
  type SetStreamerPassword,
  streamerListSchema,
  streamerSchema,
  streamerWithPasswordSchema,
  type UpdateLiveEvent,
  type UpdateStreamer,
  uuidSchema,
} from '@ondes/shared';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { request } from '../../app/api/client.ts';

// Live streamers api (#63), ad-hoc requests and events (#65), on-air controls and scheduled
// handovers (#66) under /api/v1/stations/:stationId/live.

const live = (stationId: string) => `/stations/${encodeURIComponent(stationId)}/live`;
const streamer = (stationId: string, streamerId: string) =>
  `${live(stationId)}/streamers/${encodeURIComponent(streamerId)}`;

export const liveKeys = {
  all: (stationId: string) => ['stations', stationId, 'live'] as const,
  streamers: (stationId: string) => [...liveKeys.all(stationId), 'streamers'] as const,
  candidates: (stationId: string) => [...liveKeys.all(stationId), 'candidates'] as const,
  connection: (stationId: string) => [...liveKeys.all(stationId), 'connection'] as const,
  requests: (stationId: string) => [...liveKeys.all(stationId), 'requests'] as const,
  events: (stationId: string) => [...liveKeys.all(stationId), 'events'] as const,
  nowPlaying: (stationId: string) => [...liveKeys.all(stationId), 'now-playing'] as const,
  handovers: (stationId: string) => [...liveKeys.all(stationId), 'handovers'] as const,
};

/** What the streams show while a DJ is on air (#68); null when nobody is. */
export const nowPlayingQuery = (stationId: string) =>
  queryOptions({
    queryKey: liveKeys.nowPlaying(stationId),
    queryFn: ({ signal }) =>
      request(`${live(stationId)}/now-playing`, { schema: liveNowPlayingResponseSchema, signal }),
  });

/** Scheduled handovers (#66): pending, and those of the last 24 h. */
export const handoversQuery = (stationId: string) =>
  queryOptions({
    queryKey: liveKeys.handovers(stationId),
    queryFn: ({ signal }) =>
      request(`${live(stationId)}/handovers`, { schema: liveHandoverListSchema, signal }),
  });

/** Pending ad-hoc requests (#65): DJs connected outside their slots, waiting for a manager. */
export const requestsQuery = (stationId: string) =>
  queryOptions({
    queryKey: liveKeys.requests(stationId),
    queryFn: ({ signal }) =>
      request(`${live(stationId)}/requests`, { schema: liveRequestListSchema, signal }),
  });

/** Events not over yet (#65). */
export const eventsQuery = (stationId: string) =>
  queryOptions({
    queryKey: liveKeys.events(stationId),
    queryFn: ({ signal }) =>
      request(`${live(stationId)}/events`, { schema: liveEventListSchema, signal }),
  });

const liveRequest = (stationId: string, requestId: string) =>
  `${live(stationId)}/requests/${encodeURIComponent(requestId)}`;
const liveEvent = (stationId: string, eventId: string) =>
  `${live(stationId)}/events/${encodeURIComponent(eventId)}`;

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
  approve: (stationId: string, requestId: string) =>
    request(`${liveRequest(stationId, requestId)}/approve`, {
      method: 'POST',
      schema: liveSessionSchema,
    }),
  refuse: (stationId: string, requestId: string) =>
    request(`${liveRequest(stationId, requestId)}/refuse`, { method: 'POST' }),
  createEvent: (stationId: string, body: CreateLiveEvent) =>
    request(`${live(stationId)}/events`, { body, schema: liveEventSchema }),
  updateEvent: (stationId: string, eventId: string, body: UpdateLiveEvent) =>
    request(liveEvent(stationId, eventId), { method: 'PATCH', body, schema: liveEventSchema }),
  removeEvent: (stationId: string, eventId: string) =>
    request(liveEvent(stationId, eventId), { method: 'DELETE' }),
  setNowPlaying: (stationId: string, body: SetLiveNowPlaying) =>
    request(`${live(stationId)}/now-playing`, {
      method: 'PUT',
      body,
      schema: liveNowPlayingSchema,
    }),
  clearNowPlaying: (stationId: string) =>
    request(`${live(stationId)}/now-playing`, { method: 'DELETE', schema: liveNowPlayingSchema }),
  // On-air controls (#64 routes, #66 UI). A handover is putting another DJ on air.
  goLive: (stationId: string, input: number, fadeMs?: number) =>
    request(`${live(stationId)}/on-air`, {
      method: 'PUT',
      body: { input, fadeMs },
      schema: liveSessionSchema,
    }),
  returnToAutomation: (stationId: string) =>
    request(`${live(stationId)}/on-air`, { method: 'DELETE' }),
  disconnect: (stationId: string, input: number) =>
    request(`${live(stationId)}/inputs/${input}/disconnect`, { method: 'POST' }),
  mute: (stationId: string, input: number, muted: boolean) =>
    request(`${live(stationId)}/inputs/${input}/mute`, { method: 'PUT', body: { muted } }),
  scheduleHandover: (stationId: string, body: CreateLiveHandover) =>
    request(`${live(stationId)}/handovers`, { body, schema: liveHandoverSchema }),
  cancelHandover: (stationId: string, handoverId: string) =>
    request(`${live(stationId)}/handovers/${encodeURIComponent(handoverId)}`, {
      method: 'DELETE',
      schema: liveHandoverSchema,
    }),
};

export const invalidateLive = (queryClient: QueryClient, stationId: string) =>
  queryClient.invalidateQueries({ queryKey: liveKeys.all(stationId) });
