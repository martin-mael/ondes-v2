import { z } from 'zod';

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
} as const;

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
 * `POST /v1/queue`: append one log item to the engine queue.
 * The engine resolves the file before answering, so a 201 means it is playable.
 */
export const enginePushItemSchema = z
  .object({ ...requestFields, ...transitionFields })
  .refine(cueOrder, cueOrderError);
export type EnginePushItem = z.infer<typeof enginePushItemSchema>;

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
});
export type EnginePushSegment = z.infer<typeof enginePushSegmentSchema>;

/** `POST /v1/live`: allow or forbid a connected live DJ to take over the air. */
export const engineLiveGateSchema = z.object({ enabled: z.boolean() });
export type EngineLiveGate = z.infer<typeof engineLiveGateSchema>;

// `DELETE /v1/queue/:id` removes every queued request whose item_id or segment_id is `id`
// (404 if none). `DELETE /v1/queue` clears the queue. `POST /v1/skip` ends whatever is on
// air. None of them take a body.

// ---------------------------------------------------------------------------------------
// Responses (engine -> Node)

/** A request in the engine queue. `rid` is Liquidsoap's request id. */
export const engineQueuedRequestSchema = z.object({
  rid: z.number().int().nonnegative(),
  item_id: z.string().nullable(),
  /** Set on the parts of a segment, absent or null for single items. */
  segment_id: z.string().nullable().optional(),
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
  uptime: z.number(),
  /** Last event sequence number emitted by this boot. */
  seq: z.number().int().nonnegative(),
  /** Missing fields until the first track starts. */
  on_air: onAirSchema.partial(),
  queue: z.array(engineQueuedRequestSchema),
  /** `ready` turns true once input.harbor has buffered enough to go on air (about 5 s). */
  live: z.object({ enabled: z.boolean(), connected: z.boolean(), ready: z.boolean() }),
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
    /** The source client's HTTP headers, minus Authorization. */
    data: z.object({ headers: z.array(z.tuple([z.string(), z.string()])) }),
  }),
  z.object({ ...eventBase, type: z.literal('live.disconnected'), data: empty }),
  z.object({
    ...eventBase,
    type: z.literal('live.gate'),
    data: z.object({ enabled: z.boolean() }),
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
});
export type EngineLiveAuthRequest = z.infer<typeof engineLiveAuthRequestSchema>;
