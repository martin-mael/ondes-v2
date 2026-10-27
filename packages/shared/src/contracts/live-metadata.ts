import { z } from 'zod';
import { uuidSchema } from './tenancy.ts';

// Live metadata (#68, ADR 0040): what listeners see while a DJ is on air. One now-playing per
// live session: the show and DJ by default, what the DJ's encoder sends when their streamer
// allows it, or what a manager typed on the dashboard (a concert: the artist on stage). Every
// change reaches the streams (Icecast metadata, through the engine) and the api (the on-air
// snapshot's `live`, the `live.metadata.changed` event, `getLiveNowPlaying` for #74).

const isoTime = z.iso.datetime({ offset: true });

/**
 * - `default`: the session's show (or event) and episode as title, the DJ as artist;
 * - `encoder`: what the DJ's software sends (only if their streamer accepts it);
 * - `manual`: typed on the dashboard; wins over the encoder until cleared.
 */
export const liveNowPlayingSourceSchema = z.enum(['default', 'encoder', 'manual']);
export type LiveNowPlayingSource = z.infer<typeof liveNowPlayingSourceSchema>;

/** The now-playing of the live session on air. */
export const liveNowPlayingSchema = z.object({
  sessionId: uuidSchema,
  input: z.int().min(1),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  source: liveNowPlayingSourceSchema,
  /** The DJ's streamer lets their encoder's metadata through. */
  encoderAllowed: z.boolean(),
  updatedAt: isoTime,
});
export type LiveNowPlaying = z.infer<typeof liveNowPlayingSchema>;

/** `GET /api/v1/stations/:stationId/live/now-playing`: null while nobody is on air. */
export const liveNowPlayingResponseSchema = z.object({
  nowPlaying: liveNowPlayingSchema.nullable(),
});

const text = z
  .string()
  .trim()
  .max(200)
  .transform((s) => (s === '' ? null : s));

/**
 * `PUT /api/v1/stations/:stationId/live/now-playing`: the manual now-playing. At least one of
 * the two. `DELETE` goes back to the encoder's (if allowed) or the default.
 */
export const setLiveNowPlayingSchema = z
  .object({ title: text.nullish(), artist: text.nullish() })
  .refine((b) => !!b.title || !!b.artist, 'title or artist is required');
export type SetLiveNowPlaying = z.input<typeof setLiveNowPlayingSchema>;
