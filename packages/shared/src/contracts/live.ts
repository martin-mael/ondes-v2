import { z } from 'zod';
import { dateInputSchema } from './library.ts';
import { uuidSchema } from './tenancy.ts';

// Live streamers: DJ identities and their stream credentials (#63, ADR 0023). Mirrors
// packages/db/src/schema/live.ts.
//
// A streamer is a username and password a DJ types into BUTT, Mixxx or OBS. It belongs to one
// station, optionally to one of its users (guests have none), and may connect any time or only
// around the slots of the shows it is allowed on. The engine asks the api on every source
// connection (`POST /internal/engine/stations/:stationId/live-auth`); the api checks the
// credentials against the database. Passwords are stored as argon2id hashes only: the api
// shows a password once, when it sets it.
//
// Built on by: the harbor input pool and live switching (#64), live slots (#65).

/** Same as shows': optional fields, but an update must change something. */
function patchOf<S extends z.ZodObject>(schema: S) {
  return schema
    .partial()
    .refine((patch) => Object.values(patch).some((v) => v !== undefined), 'empty update');
}

/**
 * Login names Liquidsoap gives Shoutcast (ICY) clients, which send no user name. Reserved: such
 * a client sends `username:password` as its password instead (see `liveAuthLogin`).
 */
export const RESERVED_STREAMER_USERNAMES = ['source', 'admin', 'shoutcast'] as const;

/** Lowercase, 2–32 characters, starting with a letter or digit. Unique per station. */
export const streamerUsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{1,31}$/, 'letters, digits, dots, dashes, underscores (2–32)')
  .refine(
    (u) => !(RESERVED_STREAMER_USERNAMES as readonly string[]).includes(u),
    'reserved username',
  );

/** DJ software stores it in clear text: long and random beats memorable. */
export const STREAMER_PASSWORD_MIN = 12;
export const streamerPasswordSchema = z.string().min(STREAMER_PASSWORD_MIN).max(128);

/** How long the engine lets a DJ connect before an allowed slot starts (soundcheck). */
export const LIVE_EARLY_CONNECT_MS = 15 * 60 * 1000;

/** `disabled` wins over `expired`. */
export const streamerStatusSchema = z.enum(['active', 'disabled', 'expired']);
export type StreamerStatus = z.infer<typeof streamerStatusSchema>;

export const streamerSchema = z.object({
  id: uuidSchema,
  stationId: uuidSchema,
  displayName: z.string(),
  username: z.string(),
  /** The station user this DJ is, or null for a guest. */
  user: z.object({ id: uuidSchema, name: z.string() }).nullable(),
  enabled: z.boolean(),
  /** After this instant the credentials are refused (one-off guests). */
  expiresAt: z.coerce.date().nullable(),
  /** Connect at any time, not only around the allowed shows' slots. */
  anyTime: z.boolean(),
  /** Shows whose slots this streamer may connect for. */
  shows: z.array(z.object({ id: uuidSchema, name: z.string(), colour: z.string().nullable() })),
  status: streamerStatusSchema,
  lastConnectedAt: z.coerce.date().nullable(),
  passwordChangedAt: z.coerce.date(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Streamer = z.infer<typeof streamerSchema>;

export const streamerListSchema = z.object({ streamers: z.array(streamerSchema) });
export type StreamerList = z.infer<typeof streamerListSchema>;

const streamerFields = z.object({
  displayName: z.string().trim().min(1).max(100),
  username: streamerUsernameSchema,
  userId: uuidSchema.nullable(),
  enabled: z.boolean(),
  expiresAt: dateInputSchema.nullable(),
  anyTime: z.boolean(),
  showIds: z
    .array(uuidSchema)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'duplicate show'),
});

/** No `password`: the api generates one and returns it once. */
export const createStreamerSchema = streamerFields
  .partial({ userId: true, enabled: true, expiresAt: true, anyTime: true, showIds: true })
  .extend({ password: streamerPasswordSchema.optional() });
export type CreateStreamer = z.input<typeof createStreamerSchema>;

export const updateStreamerSchema = patchOf(streamerFields);
export type UpdateStreamer = z.input<typeof updateStreamerSchema>;

/** No `password`: the api generates one. */
export const setStreamerPasswordSchema = z
  .object({ password: streamerPasswordSchema.optional() })
  .nullish()
  .transform((b) => b ?? {});
export type SetStreamerPassword = z.input<typeof setStreamerPasswordSchema>;

/** The password in clear: shown once, never stored or returned again. */
export const streamerWithPasswordSchema = z.object({
  streamer: streamerSchema,
  password: z.string(),
});
export type StreamerWithPassword = z.infer<typeof streamerWithPasswordSchema>;

/** What DJ software needs to connect. */
export const liveConnectionInfoSchema = z.object({
  /** The station's live input is on in its engine settings. */
  enabled: z.boolean(),
  /** Public host name DJs connect to. */
  host: z.string(),
  /** Public port (Icecast protocol); null until the engine has one (never started). */
  port: z.int().nullable(),
  mount: z.string(),
  /**
   * Shoutcast (ICY) clients connect on `port + 1` and send `username:password` as the password.
   * Null while the engine doesn't listen for them (#64).
   */
  shoutcastPort: z.int().nullable(),
  /** Encoders DJs may send. */
  formats: z.array(z.string()),
});
export type LiveConnectionInfo = z.infer<typeof liveConnectionInfoSchema>;

// --- Engine -> api ------------------------------------------------------------------------

/** The template's live auth webhook body (snake_case wire, like the other engine payloads). */
export const liveAuthRequestSchema = z.object({
  user: z.string().max(256),
  password: z.string().max(1024),
  address: z.string().max(256).optional(),
});
export type LiveAuthRequest = z.infer<typeof liveAuthRequestSchema>;

/**
 * The login to check: Shoutcast (ICY) clients send no user name, so Liquidsoap reports a
 * placeholder (`source`, or empty) and the DJ types `username:password` as the password.
 */
export function liveAuthLogin(req: Pick<LiveAuthRequest, 'user' | 'password'>): {
  username: string;
  password: string;
} {
  const user = req.user.trim().toLowerCase();
  const placeholder =
    user === '' || (RESERVED_STREAMER_USERNAMES as readonly string[]).includes(user);
  const colon = req.password.indexOf(':');
  if (placeholder && colon > 0) {
    return {
      username: req.password.slice(0, colon).trim().toLowerCase(),
      password: req.password.slice(colon + 1),
    };
  }
  return { username: user, password: req.password };
}

/** Why a login was refused: logged and audited, never sent back to the source client. */
export const liveAuthRefusalSchema = z.enum([
  'unknown',
  'bad_password',
  'disabled',
  'expired',
  'outside_slot',
]);
export type LiveAuthRefusal = z.infer<typeof liveAuthRefusalSchema>;
