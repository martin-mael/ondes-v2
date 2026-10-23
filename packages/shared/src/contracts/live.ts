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
// Built on by: the harbor input pool and live switching (#64), live slots, ad-hoc live and
// events (#65, ADR 0033).

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

/**
 * What happens when the DJ connects outside their live slots and events (ad-hoc live, #65):
 * - `approval`: a manager is asked in the web app ("DJ X is connected, put on air?");
 * - `allowed`: on air as soon as they connect, unless another DJ is.
 */
export const liveAdHocPolicySchema = z.enum(['approval', 'allowed']);
export type LiveAdHocPolicy = z.infer<typeof liveAdHocPolicySchema>;

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
  /** Outside their slots and events (#65). */
  adHoc: liveAdHocPolicySchema,
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
  adHoc: liveAdHocPolicySchema,
  showIds: z
    .array(uuidSchema)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'duplicate show'),
});

/** No `password`: the api generates one and returns it once. */
export const createStreamerSchema = streamerFields
  .partial({
    userId: true,
    enabled: true,
    expiresAt: true,
    anyTime: true,
    adHoc: true,
    showIds: true,
  })
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
   * Every mount of the harbor pool (#64), `mount` first: one DJ per mount, so the next DJ
   * connects to a free one while the current DJ is on air.
   */
  mounts: z.array(z.string()),
  /**
   * The port to type in a Shoutcast (ICY) client, which connects on `port + 1` and sends
   * `username:password` as the password. Null while the station doesn't take Shoutcast sources
   * (engine setting `live.icy`) or its engine hasn't started with them yet.
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
  /** The harbor input of the station's pool the source connects to (#64). */
  input: z.int().min(1).max(16).optional(),
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

// --- Live switching (#64, ADR 0027) -------------------------------------------------------
//
// A station's engine has a pool of harbor inputs (`live.inputs` in its engine settings): one
// DJ per input can be connected at once, and Node picks which one is on air. Putting a DJ on
// air opens a live session; handing the air to another input closes it and opens the next;
// returning to automation closes it. The engine tags the live as-run entries with the session.

/**
 * `slot`: its DJ connected for a live slot of their show. `manual`: someone put them on air.
 * `ad_hoc`: outside a slot, allowed for that DJ or approved by a manager (#65). `event`: an
 * event block (#65).
 */
export const liveSessionTriggerSchema = z.enum(['slot', 'manual', 'ad_hoc', 'event']);
export type LiveSessionTrigger = z.infer<typeof liveSessionTriggerSchema>;

/**
 * `returned`: back to automation. `handover`: another input went on air. `disconnected`: the
 * DJ on air hung up. `revoked`: the streamer was disabled, expired or deleted.
 * `engine_restarted`: the engine came back without it.
 */
export const liveSessionEndReasonSchema = z.enum([
  'returned',
  'handover',
  'disconnected',
  'revoked',
  'engine_restarted',
]);
export type LiveSessionEndReason = z.infer<typeof liveSessionEndReasonSchema>;

export const liveSessionSchema = z.object({
  id: uuidSchema,
  /** Null for a deleted streamer, or a source that logged in with the shared password. */
  streamer: z.object({ id: uuidSchema, displayName: z.string() }).nullable(),
  input: z.int().min(1),
  trigger: liveSessionTriggerSchema,
  startedAt: z.date(),
  endedAt: z.date().nullable(),
  endReason: liveSessionEndReasonSchema.nullable(),
  /**
   * What the session airs (#65): the show and episode of a live slot (the episode is created
   * and numbered when the DJ goes on air), or an event's title. Optional so older api
   * versions' payloads still parse.
   */
  show: z.object({ id: uuidSchema, name: z.string() }).nullable().optional(),
  episode: z
    .object({ id: uuidSchema, number: z.int().min(1) })
    .nullable()
    .optional(),
  title: z.string().nullable().optional(),
});
export type LiveSession = z.infer<typeof liveSessionSchema>;

/** `GET /api/v1/stations/:stationId/live/status`: the pool, what's on air, the open session. */
export const liveStatusSchema = z.object({
  /** The station's live input is on in its engine settings. */
  enabled: z.boolean(),
  /** The engine answered; false: nothing below is known (stopped, restarting). */
  reachable: z.boolean(),
  /** The input whose audio is on air, null while automation is. */
  onAir: z.int().min(1).nullable(),
  session: liveSessionSchema.nullable(),
  inputs: z.array(
    z.object({
      input: z.int().min(1),
      mount: z.string(),
      connected: z.boolean(),
      /** Buffered enough to take the air. */
      ready: z.boolean(),
      streamer: z.object({ id: uuidSchema, displayName: z.string() }).nullable(),
    }),
  ),
});
export type LiveStatus = z.infer<typeof liveStatusSchema>;

/** `PUT /api/v1/stations/:stationId/live/on-air`: put the DJ on this input on air. */
export const putLiveOnAirSchema = z.object({ input: z.int().min(1).max(16) });
export type PutLiveOnAir = z.infer<typeof putLiveOnAirSchema>;

// --- Ad-hoc requests (#65, ADR 0033) ------------------------------------------------------

/**
 * A DJ whose streamer needs approval connected outside their slots and events: one request
 * per connection. `pending` until a manager decides; `cancelled` when the DJ hung up first, or
 * went on air another way (their slot started).
 */
export const liveRequestStatusSchema = z.enum(['pending', 'approved', 'refused', 'cancelled']);
export type LiveRequestStatus = z.infer<typeof liveRequestStatusSchema>;

export const liveRequestSchema = z.object({
  id: uuidSchema,
  streamer: z.object({ id: uuidSchema, displayName: z.string() }),
  input: z.int().min(1),
  status: liveRequestStatusSchema,
  requestedAt: z.coerce.date(),
  decidedAt: z.coerce.date().nullable(),
});
export type LiveRequest = z.infer<typeof liveRequestSchema>;

/** `GET …/live/requests`: the pending ones, oldest first. */
export const liveRequestListSchema = z.object({ requests: z.array(liveRequestSchema) });
export type LiveRequestList = z.infer<typeof liveRequestListSchema>;

// --- Events (#65, ADR 0033) -----------------------------------------------------------------

/** Longest event block: 24 h, like a slot. */
export const LIVE_EVENT_MAX_MS = 24 * 3600 * 1000;

/**
 * A one-off live block with a title (a festival stage, a concert): not a show. Its streamers
 * (none listed: any of the station's) may connect from 15 min before it and go on air at its
 * start, like a live slot; the as-run shows its title.
 */
export const liveEventSchema = z.object({
  id: uuidSchema,
  stationId: uuidSchema,
  title: z.string(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  streamers: z.array(z.object({ id: uuidSchema, displayName: z.string() })),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type LiveEvent = z.infer<typeof liveEventSchema>;

/** `GET …/live/events`: those not over yet, by start. */
export const liveEventListSchema = z.object({ events: z.array(liveEventSchema) });
export type LiveEventList = z.infer<typeof liveEventListSchema>;

const liveEventFields = z.object({
  title: z.string().trim().min(1).max(200),
  startsAt: dateInputSchema,
  endsAt: dateInputSchema,
  streamerIds: z
    .array(uuidSchema)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, 'duplicate streamer'),
});
const eventSpan = (e: { startsAt?: Date; endsAt?: Date }) =>
  !e.startsAt ||
  !e.endsAt ||
  (e.endsAt > e.startsAt && e.endsAt.getTime() - e.startsAt.getTime() <= LIVE_EVENT_MAX_MS);
const eventSpanIssue = {
  message: 'an event ends after it starts, at most 24 h later',
  path: ['endsAt'],
};

export const createLiveEventSchema = liveEventFields
  .partial({ streamerIds: true })
  .refine(eventSpan, eventSpanIssue);
export type CreateLiveEvent = z.input<typeof createLiveEventSchema>;

/** Both ends are checked together: an update moving one end is checked against the other. */
export const updateLiveEventSchema = patchOf(liveEventFields).refine(eventSpan, eventSpanIssue);
export type UpdateLiveEvent = z.input<typeof updateLiveEventSchema>;
