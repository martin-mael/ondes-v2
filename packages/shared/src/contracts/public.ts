import { z } from 'zod';

// Public API (#74, ADR 0041): what anyone may read about a station, without an account, under
// `/api/v1/public/stations/:slug/…`. A station is named by its public slug (the one in its
// stream mounts), never by its id. These shapes are the whole public surface: no internal ids
// (log items, as-run entries, sessions, users), no alerts, no engine state. They are also the
// source of the OpenAPI document (`GET /api/v1/public/openapi.json`), so every field carries a
// description. The schedule API (#75) adds its shapes here.

const isoTime = z.iso.datetime({ offset: true }).meta({
  description: 'UTC instant, ISO 8601.',
  example: '2026-10-27T18:04:12.345Z',
});

export const publicSlugSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .meta({ description: "The station's public slug, as in its stream URLs.", example: 'vandale' });

export const publicStationSchema = z
  .object({
    slug: publicSlugSchema,
    name: z.string(),
    timezone: z.string().meta({
      description: "The station's IANA timezone: show its times in this zone.",
      example: 'Europe/Paris',
    }),
  })
  .meta({ id: 'PublicStation' });
export type PublicStation = z.infer<typeof publicStationSchema>;

/**
 * - `automation`: the station plays its programme (music, jingles), including its safety
 *   playlist;
 * - `show`: a pre-recorded show episode is on air;
 * - `live`: a DJ is on air;
 * - `off_air`: nothing is on air, or the station is on its emergency loop.
 */
export const publicModeSchema = z
  .enum(['automation', 'show', 'live', 'off_air'])
  .meta({ id: 'PublicMode', description: 'What the station is doing.' });
export type PublicMode = z.infer<typeof publicModeSchema>;

/**
 * What an item is, publicly: a `track` (a song), an `episode` of a show, `live` (a DJ), or an
 * `interlude` (a jingle, a voice track, a bed, a promo: no title is given for those).
 */
export const publicItemKindSchema = z
  .enum(['track', 'episode', 'live', 'interlude'])
  .meta({ id: 'PublicItemKind' });
export type PublicItemKind = z.infer<typeof publicItemKindSchema>;

export const publicCurrentSchema = z
  .object({
    kind: publicItemKindSchema,
    title: z.string().nullable(),
    artist: z.string().nullable(),
    startedAt: isoTime.meta({ description: 'When it took the air (the engine clock), UTC.' }),
    durationMs: z
      .int()
      .nonnegative()
      .nullable()
      .meta({ description: 'Expected length in ms; null when unknown (live).' }),
  })
  .meta({ id: 'PublicCurrent', description: 'The item on air.' });
export type PublicCurrent = z.infer<typeof publicCurrentSchema>;

export const publicEpisodeSchema = z
  .object({ number: z.int().min(1), title: z.string().nullable() })
  .meta({ id: 'PublicEpisode' });
export type PublicEpisode = z.infer<typeof publicEpisodeSchema>;

export const publicShowSchema = z
  .object({
    name: z.string(),
    colour: z.string().nullable().meta({ description: 'CSS colour, e.g. `#ff3366`.' }),
    artworkUrl: z.string().nullable(),
    startsAt: isoTime,
    endsAt: isoTime,
    episode: publicEpisodeSchema
      .nullable()
      .meta({ description: 'The episode of this block; for a rerun, the episode aired again.' }),
    rerun: z.boolean(),
  })
  .meta({ id: 'PublicShow', description: 'The show block the station is in.' });
export type PublicShow = z.infer<typeof publicShowSchema>;

export const publicLiveSchema = z
  .object({
    djName: z.string().nullable().meta({ description: "The DJ's display name, when known." }),
    title: z
      .string()
      .nullable()
      .meta({ description: "What the live is: an event's title, or the show's name." }),
  })
  .meta({ id: 'PublicLive' });
export type PublicLive = z.infer<typeof publicLiveSchema>;

export const publicNextItemSchema = z
  .object({
    kind: z.enum(['track', 'episode']),
    title: z.string().nullable(),
    artist: z.string().nullable(),
    startsAt: isoTime.meta({ description: 'Estimated start, from what is on air.' }),
    durationMs: z.int().nonnegative(),
  })
  .meta({ id: 'PublicNextItem' });
export type PublicNextItem = z.infer<typeof publicNextItemSchema>;

/** At most this many items in `next`. */
export const PUBLIC_NEXT_ITEMS = 3;

/** `GET /api/v1/public/stations/:slug/now-playing`, and the `now_playing` SSE event. */
export const publicNowPlayingSchema = z
  .object({
    station: publicStationSchema,
    at: isoTime.meta({ description: "The server's clock when this snapshot was built." }),
    mode: publicModeSchema,
    live: z.boolean().meta({ description: 'A DJ is on air (`mode` is `live`).' }),
    current: publicCurrentSchema.nullable(),
    show: publicShowSchema.nullable(),
    liveInfo: publicLiveSchema.nullable().meta({ description: 'Set while `live` is true.' }),
    next: z.array(publicNextItemSchema).meta({
      description: `The next tracks and episodes, at most ${PUBLIC_NEXT_ITEMS}, in play order. May be empty.`,
    }),
  })
  .meta({ id: 'PublicNowPlaying' });
export type PublicNowPlaying = z.infer<typeof publicNowPlayingSchema>;

export const publicHistoryItemSchema = z
  .object({
    kind: z.enum(['track', 'episode', 'live']),
    title: z.string().nullable(),
    artist: z.string().nullable(),
    startedAt: isoTime,
    endedAt: isoTime,
    durationMs: z.int().nonnegative().meta({ description: 'How long it was on air, in ms.' }),
  })
  .meta({ id: 'PublicHistoryItem' });
export type PublicHistoryItem = z.infer<typeof publicHistoryItemSchema>;

export const PUBLIC_HISTORY_MAX = 50;

export const publicHistoryQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PUBLIC_HISTORY_MAX)
    .default(20)
    .meta({ description: `How many items, newest first (1–${PUBLIC_HISTORY_MAX}).` }),
});
export type PublicHistoryQuery = z.infer<typeof publicHistoryQuerySchema>;

/** `GET /api/v1/public/stations/:slug/history`: what aired, newest first (not the item on air). */
export const publicHistorySchema = z
  .object({
    station: publicStationSchema,
    items: z.array(publicHistoryItemSchema),
  })
  .meta({ id: 'PublicHistory' });
export type PublicHistory = z.infer<typeof publicHistorySchema>;

/** The error body of the public API: the api's own (`errorResponseSchema`), documented. */
export const publicErrorSchema = z
  .object({
    error: z.string().meta({ description: 'Stable machine code: `not_found`, `rate_limited`, …' }),
    message: z.string(),
  })
  .meta({ id: 'PublicError' });
