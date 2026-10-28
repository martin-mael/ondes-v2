import { z } from 'zod';
import { liveEncoderTextSchema } from './live-metadata.ts';

/**
 * Engine adapter contract v1: the wire protocol between Node and one station's Liquidsoap
 * process. Drafted by spike #13, finalised by #28. See docs/adr/0002-engine-control.md.
 * Node's side is `apps/api/src/modules/engine/adapter`; the engine's side is
 * `engine/templates/station.liq` (#27). Keep the three in sync; breaking changes go in a
 * `contract:` PR first.
 *
 * - Commands: Node -> engine, harbor HTTP + JSON on the internal control port, under `/v1`.
 * - Events: engine -> Node, POSTed in ordered batches to the adapter's events endpoint,
 *   also pullable from `GET /v1/events?after=<seq>`.
 *
 * Field names are snake_case on the wire because they map one to one onto Liquidsoap
 * metadata (`liq_cue_in`, `ondes_item_id`, ...). The adapter maps them to domain types.
 * Times sent by the engine are Unix epoch seconds (float, UTC); durations are seconds.
 */

export const ENGINE_CONTRACT_VERSION = 1;

/** Path prefix of every control route. */
export const ENGINE_CONTROL_PREFIX = '/v1';

/** Control routes. `GET /v1/health` is the only one that needs no bearer token. */
export const ENGINE_ROUTES = {
  health: `${ENGINE_CONTROL_PREFIX}/health`,
  state: `${ENGINE_CONTROL_PREFIX}/state`,
  events: `${ENGINE_CONTROL_PREFIX}/events`,
  queue: `${ENGINE_CONTROL_PREFIX}/queue`,
  segment: `${ENGINE_CONTROL_PREFIX}/segment`,
  skip: `${ENGINE_CONTROL_PREFIX}/skip`,
  live: `${ENGINE_CONTROL_PREFIX}/live`,
  /** Added by #64: hangs up the DJ on one input of the harbor pool. */
  liveDisconnect: `${ENGINE_CONTROL_PREFIX}/live/disconnect`,
  /** Added by #68: the now-playing while a DJ is on air. */
  liveMetadata: `${ENGINE_CONTROL_PREFIX}/live/metadata`,
  /** Added by #66: mutes or unmutes what one input of the pool sends on air. */
  liveMute: `${ENGINE_CONTROL_PREFIX}/live/mute`,
  /** Added by #46: the hard start waiting for its time (`POST`), or cancelling it (`DELETE`). */
  schedule: `${ENGINE_CONTROL_PREFIX}/schedule`,
} as const;

/** Harbor inputs per station (#64): input `n` listens on mount `<mount>` (1) or `<mount>-n`. */
export const ENGINE_LIVE_INPUTS_MAX = 4;
const liveInput = z.int().min(1).max(ENGINE_LIVE_INPUTS_MAX);

/** Which branch of the source chain is on air. */
export const engineSourceSchema = z.enum(['live', 'queue', 'safety', 'emergency', 'unknown']);
export type EngineSource = z.infer<typeof engineSourceSchema>;

const seconds = z.number().nonnegative();

// ---------------------------------------------------------------------------------------
// Commands (Node -> engine)

const cueOrder = <T extends { cue_in?: number; cue_out?: number }>(p: T) =>
  p.cue_in === undefined || p.cue_out === undefined || p.cue_out > p.cue_in;
const cueOrderError = { message: 'cue_out must be after cue_in', path: ['cue_out'] };

/** Log item ids, segment ids: reported back on every as-run event. */
const engineId = z.string().min(1).max(128);

/** What one request plays: a file from the playout cache, its cue points and gain. */
const requestFields = {
  /** Log item id; reported back on every as-run event for this item. */
  item_id: engineId,
  /** Local path in the station's playout cache (Liquidsoap never reads S3). */
  uri: z.string().min(1),
  /** Seconds from the start of the file. Applied at request resolution. */
  cue_in: seconds.optional(),
  /** Seconds from the start of the file. Applied at request resolution. */
  cue_out: seconds.optional(),
  /** Per-item gain (loudness normalisation), in dB. */
  amplify_db: z.number().min(-60).max(24).optional(),
  title: z.string().optional(),
  artist: z.string().optional(),
};

/** How the station crossfade enters and leaves a queue entry (an item or a segment). */
const transitionFields = {
  /** Fade-in length applied by the crossfade into this entry. */
  fade_in: seconds.optional(),
  /** Fade-out length applied by the crossfade out of this entry. */
  fade_out: seconds.optional(),
  /**
   * Crossfade lengths at each end of this entry. The overlap between two entries is
   * min(previous.cross_out, next.cross_in), so set both to the planned overlap.
   * 0 on both = an abrupt cut, but not a sample-exact one (frame-granular, see ADR 0002):
   * never use it for island joins, push a segment instead. Default: the station's
   * cross duration.
   */
  cross_in: seconds.optional(),
  cross_out: seconds.optional(),
};

/**
 * A voice laid over the transition out of a queue entry (#57, ADR 0024): the degraded path of a
 * voice track whose island isn't rendered or cached at air time. The engine starts it `at`
 * seconds after the entry's last request goes on air, ducks the music to `duck_db` for
 * `duration` seconds, and reports nothing for it (it is part of the transition, not an item).
 * A skip of the entry cancels its voices that haven't started.
 */
export const engineOverlayVoiceSchema = z.object({
  uri: z.string().min(1),
  /** Seconds after the entry's last request goes on air. */
  at: z.number().min(0),
  /** How long the voice plays and the music stays ducked, in seconds. */
  duration: z.number().positive(),
  cue_in: seconds.optional(),
  cue_out: seconds.optional(),
  amplify_db: z.number().min(-60).max(24).optional(),
  /** Music gain while the voice plays, in dB (0 = no duck). */
  duck_db: z.number().min(-60).max(0).optional(),
});
export type EngineOverlayVoice = z.infer<typeof engineOverlayVoiceSchema>;

const overlayField = {
  /** Voices over the transition out of this entry (the island fallback). Up to 8. */
  overlay: z.array(engineOverlayVoiceSchema).max(8).optional(),
};

/**
 * `POST /v1/queue`: append one log item to the engine queue.
 * The engine resolves the file before answering, so a 201 means it is playable.
 */
export const enginePushItemSchema = z
  .object({ ...requestFields, ...transitionFields, ...overlayField })
  .refine(cueOrder, cueOrderError);
export type EnginePushItem = z.infer<typeof enginePushItemSchema>;

/**
 * `POST /v1/schedule` (#46, ADR 0031, after ADR 0003): the item that must start at `at`, a hard
 * start. The engine holds it above the automation and opens the gate on its own audio
 * timeline, to the frame (20 ms); whatever is on air then fades out under it over `fade_out`
 * seconds (default 1) and is skipped. A new schedule replaces the previous one. The item
 * reports `source: queue` on the as-run, like any log item. `201` like a push; `422` if the
 * file can't be resolved (nothing is scheduled).
 */
export const engineScheduleSchema = z
  .object({
    ...requestFields,
    /** Wall-clock epoch seconds (UTC) at which the item starts. */
    at: z.number().positive(),
    /** Fade into the item itself (default none: it starts at full level). */
    fade_in: seconds.optional(),
    /** How long the automation it interrupts fades out under it. Default 1 s. */
    fade_out: seconds.optional(),
  })
  .refine(cueOrder, cueOrderError);
export type EngineSchedule = z.infer<typeof engineScheduleSchema>;

/** `DELETE /v1/schedule`: whether an item was scheduled (one already on air keeps playing). */
export const engineUnscheduleResultSchema = z.object({ cancelled: z.boolean() });
export type EngineUnscheduleResult = z.infer<typeof engineUnscheduleResultSchema>;

/** One request inside a segment. Cue points follow spike #12 (grid, half-sample bias). */
export const engineSegmentPartSchema = z.object(requestFields).refine(cueOrder, cueOrderError);
export type EngineSegmentPart = z.infer<typeof engineSegmentPartSchema>;

/**
 * `POST /v1/segment`: append an island chain (`A body -> island -> B body`, #54) as one
 * queue entry. The engine plays the parts back to back as one merged track
 * (`sequence(merge=true, ...)`), with `liq_amplify` applied per part before the merge, so
 * the station crossfade never sees the joins inside it. The transition fields apply to the
 * crossfade into and out of the whole segment. Every part is resolved before anything is
 * queued: a 422 means nothing was queued. Skipping during a segment skips all of it.
 */
export const enginePushSegmentSchema = z.object({
  /** Reported on the as-run events of every part, and accepted by `DELETE /v1/queue/:id`. */
  segment_id: engineId,
  parts: z.array(engineSegmentPartSchema).min(2).max(16),
  ...transitionFields,
  ...overlayField,
});
export type EnginePushSegment = z.infer<typeof enginePushSegmentSchema>;

/**
 * `POST /v1/live`: allow or forbid a connected live DJ to take over the air.
 * `409` if the station's live input is disabled in its settings.
 *
 * Harbor pool (#64): opening names the `input` to put on air (absent: the first ready one)
 * and the live session Node opened, which the engine reports on that input's as-run events.
 * Opening on another input while the gate is open is a handover (1 s crossfade). Closing
 * hands the air back to automation; `400` for an input the pool doesn't have.
 */
export const engineLiveGateSchema = z.object({
  enabled: z.boolean(),
  input: liveInput.optional(),
  session_id: engineId.optional(),
  /**
   * DJ handover (#66): the crossfade, in seconds, when this opening moves the air from one DJ
   * to another (0: a cut). Absent: the last one asked (1 s at boot).
   */
  fade: z.number().min(0).max(10).optional(),
});
export type EngineLiveGate = z.infer<typeof engineLiveGateSchema>;

/**
 * `POST /v1/live/disconnect` (#64): hangs up the DJ on `input` (revoked streamer, kick). If
 * they are on air, automation takes the air back. Answers `{disconnected}`: false if nobody
 * was connected there.
 */
export const engineLiveDisconnectSchema = z.object({ input: liveInput });
export type EngineLiveDisconnect = z.infer<typeof engineLiveDisconnectSchema>;
export const engineLiveDisconnectResultSchema = z.object({ disconnected: z.boolean() });

/**
 * `POST /v1/live/metadata` (#68): the now-playing listeners see while a DJ is on air. Sent on
 * the streams at once if the gate is open, else at the next takeover. `encoder`: let the
 * metadata the DJ's software sends through instead. A new live session (`POST /v1/live` with
 * another session id) clears it until Node sends the next one. Answers `{applied}`.
 */
export const engineLiveMetadataSchema = z.object({
  title: z.string().nullable(),
  artist: z.string().nullable(),
  encoder: z.boolean(),
});
export type EngineLiveMetadata = z.infer<typeof engineLiveMetadataSchema>;
export const engineLiveMetadataResultSchema = z.object({ applied: z.boolean() });

/**
 * `POST /v1/live/mute` (#66): mutes (or unmutes) what `input` sends on air, over 100 ms. The DJ
 * stays connected, and on air if they were (silence until unmuted); pre-listen still hears
 * them. The engine unmutes an input when its DJ hangs up. `400` for an input the pool lacks.
 */
export const engineLiveMuteSchema = z.object({ input: liveInput, muted: z.boolean() });
export type EngineLiveMute = z.infer<typeof engineLiveMuteSchema>;
export const engineLiveMuteResultSchema = z.object({
  input: liveInput,
  muted: z.boolean(),
  /** Whether a DJ was connected on the input. */
  connected: z.boolean(),
});

// `DELETE /v1/queue/:id` removes every queued entry whose item_id or segment_id is `id`
// (404 if none). A segment can't be split: naming any of its parts removes all of it, and
// `removed` counts requests. `DELETE /v1/queue` clears the queue. `POST /v1/skip` ends whatever is on
// air. None of them take a body.

// ---------------------------------------------------------------------------------------
// Responses (engine -> Node)

/** A request in the engine queue. `rid` is Liquidsoap's request id. */
export const engineQueuedRequestSchema = z.object({
  rid: z.number().int().nonnegative(),
  item_id: z.string().nullable(),
  /** Set on the parts of a segment, absent or null for single items. */
  segment_id: z.string().nullable().optional(),
  /** Liquidsoap's request URI: the pushed path behind our `annotate:` prefix. */
  uri: z.string(),
  /** Liquidsoap request status: idle, resolving, ready, playing, destroyed. */
  status: z.string(),
});
export type EngineQueuedRequest = z.infer<typeof engineQueuedRequestSchema>;

/** `201` answer to `POST /v1/segment`: one queued request per part, in play order. */
export const enginePushSegmentResultSchema = z.object({
  segment_id: z.string(),
  requests: z.array(engineQueuedRequestSchema),
});
export type EnginePushSegmentResult = z.infer<typeof enginePushSegmentResultSchema>;

export const engineSkipResultSchema = z.object({ skipped: z.boolean() });
export type EngineSkipResult = z.infer<typeof engineSkipResultSchema>;

export const engineRemoveResultSchema = z.object({ removed: z.number().int().nonnegative() });
export type EngineRemoveResult = z.infer<typeof engineRemoveResultSchema>;

/** Body of every 4xx/5xx answer. */
export const engineErrorSchema = z.object({ error: z.string() });
export type EngineError = z.infer<typeof engineErrorSchema>;

/** `GET /v1/health`: unauthenticated liveness probe. */
export const engineHealthSchema = z.object({
  status: z.literal('ok'),
  boot_id: z.string(),
  version: z.string(),
  /**
   * Hash of the template and station settings the running script was rendered from (#27).
   * Differs from the expected one when a settings change is waiting for a restart.
   */
  config_version: z.string().optional(),
});
export type EngineHealth = z.infer<typeof engineHealthSchema>;

const onAirSchema = z.object({
  item_id: z.string().nullable(),
  segment_id: z.string().nullable().optional(),
  source: engineSourceSchema,
  title: z.string().nullable(),
  artist: z.string().nullable(),
  filename: z.string().nullable(),
  rid: z.string().nullable(),
  /** Seconds since this track went on air. Remaining time is Node's to compute. */
  elapsed: z.number(),
});

/** `GET /v1/state`: snapshot used to reconcile after a restart or an event gap. */
export const engineStateSchema = z.object({
  boot_id: z.string(),
  station_id: z.string(),
  version: z.string(),
  /**
   * Hash of the template and station settings the running script was rendered from (#27).
   * Differs from the expected one when a settings change is waiting for a restart.
   */
  config_version: z.string().optional(),
  uptime: z.number(),
  /** Last event sequence number emitted by this boot. */
  seq: z.number().int().nonnegative(),
  /** Missing fields until the first track starts. */
  on_air: onAirSchema.partial(),
  queue: z.array(engineQueuedRequestSchema),
  /**
   * The hard start waiting for its time (`POST /v1/schedule`, #46), null when none. Absent from
   * engines rendered before #46.
   */
  scheduled: z.object({ item_id: z.string(), at: z.number() }).nullable().optional(),
  /** `ready` turns true once input.harbor has buffered enough to go on air (about 5 s). */
  live: z.object({
    enabled: z.boolean(),
    /** Some input of the pool has a DJ connected / ready. */
    connected: z.boolean(),
    ready: z.boolean(),
    /** The input Node selected; null: the first ready one. Added by #64. */
    selected: liveInput.nullable().optional(),
    /** The input whose audio is on air, null while automation is. */
    on_air: liveInput.nullable().optional(),
    /** The live session Node opened the gate with. */
    session_id: z.string().nullable().optional(),
    /** The now-playing Node last sent (#68); empty strings when none. */
    now_playing: z
      .object({ title: z.string(), artist: z.string(), encoder: z.boolean() })
      .optional(),
    /** The harbor pool, in order. */
    inputs: z
      .array(
        z.object({
          input: liveInput,
          mount: z.string(),
          connected: z.boolean(),
          ready: z.boolean(),
          /** The streamer Node's auth webhook accepted on this input, if any. */
          streamer_id: z.string().nullable(),
          /** Muted on air (#66). Absent from engines rendered before #66. */
          muted: z.boolean().optional(),
        }),
      )
      .optional(),
  }),
  blank: z.boolean(),
  /** Output level per channel in dBFS (floored at -120), null before the first frames. */
  output_db: z.array(z.number()).nullable(),
});
export type EngineState = z.infer<typeof engineStateSchema>;

// ---------------------------------------------------------------------------------------
// Events (engine -> Node)

const eventBase = {
  /** Contract version. */
  v: z.literal(ENGINE_CONTRACT_VERSION),
  /** 1, 2, 3, ... per boot. A gap means lost events: backfill with `GET /v1/events`. */
  seq: z.number().int().positive(),
  /** Changes on every engine start; seq restarts at 1. */
  boot_id: z.string(),
  station_id: z.string(),
  /** Unix epoch seconds (UTC) when the engine saw it. */
  at: z.number(),
};

const empty = z.object({});

export const engineEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...eventBase,
    type: z.literal('engine.started'),
    data: z.object({ version: z.string() }),
  }),
  /** A track went on air (after transitions, right before the output). */
  z.object({
    ...eventBase,
    type: z.literal('track.started'),
    data: z.object({
      item_id: z.string().nullable(),
      /** The segment this part of an island chain belongs to; absent or null otherwise. */
      segment_id: z.string().nullable().optional(),
      source: engineSourceSchema,
      title: z.string().nullable(),
      artist: z.string().nullable(),
      filename: z.string().nullable(),
      rid: z.string().nullable(),
      /**
       * The live session on air, for `source: live` (#30, #62): the id Node gave the engine
       * when it opened the gate. Absent or null otherwise, and until the template sends it.
       */
      live_session_id: z.string().nullable().optional(),
      /** For `source: live`: the streamer connected on the input on air (#64). */
      live_streamer_id: z.string().nullable().optional(),
      /** For `source: live`: the harbor input on air (#64). */
      live_input: liveInput.nullable().optional(),
    }),
  }),
  /** The previous track left the air; `played` is how long it was the on-air track. */
  z.object({
    ...eventBase,
    type: z.literal('track.ended'),
    data: z.object({
      item_id: z.string().nullable(),
      segment_id: z.string().nullable().optional(),
      source: engineSourceSchema,
      started_at: z.number(),
      played: z.number().nonnegative(),
    }),
  }),
  z.object({
    ...eventBase,
    type: z.literal('live.connected'),
    data: z.object({
      /** The source client's HTTP headers, minus Authorization. */
      headers: z.array(z.tuple([z.string(), z.string()])),
      /** The harbor input it connected to, and the streamer the auth webhook named (#64). */
      input: liveInput.optional(),
      streamer_id: z.string().nullable().optional(),
    }),
  }),
  z.object({
    ...eventBase,
    type: z.literal('live.disconnected'),
    data: z.object({
      input: liveInput.optional(),
      streamer_id: z.string().nullable().optional(),
    }),
  }),
  z.object({
    ...eventBase,
    type: z.literal('live.gate'),
    data: z.object({
      enabled: z.boolean(),
      /** Added by #64: the selected input (null: the first ready one) and the session. */
      input: liveInput.nullable().optional(),
      session_id: z.string().nullable().optional(),
    }),
  }),
  /**
   * The DJ on air's encoder sent metadata (#68), whether or not it reaches the streams. `title`
   * is the ICY `song` when the encoder sends no title.
   */
  z.object({
    ...eventBase,
    type: z.literal('live.metadata'),
    data: z.object({
      input: z.int().min(0),
      session_id: z.string().nullable(),
      streamer_id: z.string().nullable(),
      title: liveEncoderTextSchema.nullable(),
      artist: liveEncoderTextSchema.nullable(),
    }),
  }),
  z.object({
    ...eventBase,
    type: z.literal('live.muted'),
    /** Added by #66: an input muted or unmuted (`POST /v1/live/mute`). */
    data: z.object({ input: liveInput, muted: z.boolean(), connected: z.boolean() }),
  }),
  z.object({ ...eventBase, type: z.literal('blank.detected'), data: empty }),
  z.object({ ...eventBase, type: z.literal('blank.recovered'), data: empty }),
]);
export type EngineEvent = z.infer<typeof engineEventSchema>;
export type EngineEventType = EngineEvent['type'];

/** Body of the engine's POST to the adapter (and of `GET /v1/events`): seq-ordered. */
export const engineEventBatchSchema = z.array(engineEventSchema);
export type EngineEventBatch = z.infer<typeof engineEventBatchSchema>;

/**
 * Live DJ login, POSTed by the engine to the adapter's auth webhook when a source client
 * connects to `input.harbor`. Answer 2xx to accept, anything else to refuse.
 */
export const engineLiveAuthRequestSchema = z.object({
  user: z.string(),
  password: z.string(),
  address: z.string(),
  /** The harbor input the source connects to (#64). */
  input: liveInput.optional(),
});
export type EngineLiveAuthRequest = z.infer<typeof engineLiveAuthRequestSchema>;

/**
 * `GET /api/v1/stations/:stationId/engine` (#35's lifecycle `status`), for the dashboard (#71).
 * Domain shape (camelCase), unlike the engine's wire format above.
 */
export const engineStatusViewSchema = z.object({
  stationId: z.string(),
  desiredState: z.enum(['running', 'stopped']),
  container: z
    .object({
      id: z.string(),
      status: z.string(),
      running: z.boolean(),
      restartCount: z.int().nonnegative(),
      configVersion: z.string().nullable(),
    })
    .nullable(),
  /** The health monitor's view: `unknown` until the first probe, null when not monitored. */
  health: z.enum(['unknown', 'up', 'down']).nullable(),
  reportedVersion: z.string().nullable(),
  expectedVersion: z.string(),
  /** The engine runs an older script than its settings: a restart is due. */
  restartPending: z.boolean(),
  livePort: z.int().nullable(),
  restartStorm: z.object({
    tripped: z.boolean(),
    since: z.string().nullable(),
    restarts: z.int().nonnegative(),
    windowSeconds: z.int().positive(),
  }),
});
export type EngineStatusView = z.infer<typeof engineStatusViewSchema>;
