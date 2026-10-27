import { z } from 'zod';
import { uuidSchema } from './tenancy.ts';

// DJ handover (#66, ADR 0038): the crossfade between two DJs, scheduled handovers and muting
// an input. Builds on the harbor pool and live sessions (contracts/live.ts, ADR 0027).

/** The crossfade of a handover when none is asked, in ms. */
export const LIVE_HANDOVER_FADE_MS_DEFAULT = 2000;
/** The longest crossfade a handover may ask for, in ms (the engine takes up to 10 s). */
export const LIVE_HANDOVER_FADE_MS_MAX = 10_000;

export const liveHandoverFadeMsSchema = z.int().min(0).max(LIVE_HANDOVER_FADE_MS_MAX);

/**
 * `pending` until its time; `running` while a replica carries it out; then `done` (the DJ is on
 * air), `failed` (`reason` says why) or `cancelled` (by a member, before its time).
 */
export const liveHandoverStatusSchema = z.enum([
  'pending',
  'running',
  'done',
  'failed',
  'cancelled',
]);
export type LiveHandoverStatus = z.infer<typeof liveHandoverStatusSchema>;

/**
 * Why a scheduled handover failed. `not_connected`: the DJ wasn't connected at its time.
 * `streamer_not_allowed`: disabled, expired or deleted. `engine_unavailable`: the engine
 * didn't answer. `missed`: the api wasn't running at its time (more than a minute late).
 * `interrupted`: the replica carrying it out stopped. `error`: anything else (logged).
 */
export const liveHandoverFailureSchema = z.enum([
  'not_connected',
  'streamer_not_allowed',
  'engine_unavailable',
  'missed',
  'interrupted',
  'error',
]);
export type LiveHandoverFailure = z.infer<typeof liveHandoverFailureSchema>;

export const liveHandoverSchema = z.object({
  id: uuidSchema,
  /** The DJ who takes the air; null once their streamer is deleted. */
  streamer: z.object({ id: uuidSchema, displayName: z.string() }).nullable(),
  at: z.coerce.date(),
  fadeMs: liveHandoverFadeMsSchema,
  status: liveHandoverStatusSchema,
  reason: liveHandoverFailureSchema.nullable(),
  /** The live session it opened, once `done`. */
  sessionId: uuidSchema.nullable(),
  createdAt: z.coerce.date(),
});
export type LiveHandover = z.infer<typeof liveHandoverSchema>;

/** `GET …/live/handovers`: the pending ones and those of the last 24 h, by time. */
export const liveHandoverListSchema = z.object({ handovers: z.array(liveHandoverSchema) });
export type LiveHandoverList = z.infer<typeof liveHandoverListSchema>;

/**
 * `POST …/live/handovers`: at `at`, the DJ `streamerId` (connected on any input by then) takes
 * the air with a `fadeMs` crossfade. `at` must be in the future and within 24 h.
 */
export const createLiveHandoverSchema = z.object({
  streamerId: uuidSchema,
  at: z.coerce.date(),
  fadeMs: liveHandoverFadeMsSchema.default(LIVE_HANDOVER_FADE_MS_DEFAULT),
});
export type CreateLiveHandover = z.input<typeof createLiveHandoverSchema>;

/** `PUT …/live/inputs/:input/mute`: mute (or unmute) what this input sends on air. */
export const putLiveInputMuteSchema = z.object({ muted: z.boolean() });
export type PutLiveInputMute = z.infer<typeof putLiveInputMuteSchema>;
