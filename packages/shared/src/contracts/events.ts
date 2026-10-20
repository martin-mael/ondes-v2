import { z } from 'zod';
import { engineSourceSchema } from './engine.ts';

/**
 * Real-time events: what the api publishes on the RabbitMQ events fanout (`@ondes/queue`
 * `createEventPublisher`) and relays to browsers over SSE. One discriminated union for the
 * whole app; each domain adds its events here (additive changes only, see CLAUDE.md).
 *
 * Unlike the engine wire format (`engine.ts`, snake_case, epoch seconds), these are domain
 * events: camelCase, ISO 8601 UTC timestamps, scoped by `stationId`.
 */

const envelope = {
  /** Unique per event; SSE clients use it as the event id. */
  id: z.uuid(),
  stationId: z.string().min(1),
  /** When it happened (for engine events: when the engine saw it), ISO 8601 UTC. */
  at: z.iso.datetime({ offset: true }),
};

/** Where an engine event came from: the engine boot and its sequence number. */
const engineOrigin = {
  bootId: z.string(),
  seq: z.int().positive(),
};

const isoTime = z.iso.datetime({ offset: true });

// ---------------------------------------------------------------------------------------
// Engine (#28). Mapped one to one from the engine wire events, plus the adapter's own
// up/down view from health polling.

/** The adapter reached the engine again (first contact, recovery or a new boot). */
export const engineUpEventSchema = z.object({
  ...envelope,
  type: z.literal('engine.up'),
  data: z.object({ bootId: z.string(), version: z.string() }),
});

/** The engine stopped answering its health probe. The station may be off air. */
export const engineDownEventSchema = z.object({
  ...envelope,
  type: z.literal('engine.down'),
  data: z.object({
    /** Last boot seen, if any. */
    bootId: z.string().nullable(),
    /** Why the last probe failed, e.g. `timeout`, `unreachable`, `http_503`. */
    reason: z.string(),
  }),
});

/** The engine process started (wire `engine.started`). Its queue is empty. */
export const engineBootedEventSchema = z.object({
  ...envelope,
  type: z.literal('engine.booted'),
  data: z.object({ ...engineOrigin, version: z.string() }),
});

/** As-run: an item went on air (wire `track.started`). */
export const engineTrackStartedEventSchema = z.object({
  ...envelope,
  type: z.literal('engine.track.started'),
  data: z.object({
    ...engineOrigin,
    /** Log item id; null for safety/emergency/live. */
    itemId: z.string().nullable(),
    /** Island chain this item is part of, if any. */
    segmentId: z.string().nullable(),
    source: engineSourceSchema,
    title: z.string().nullable(),
    artist: z.string().nullable(),
    filename: z.string().nullable(),
    rid: z.string().nullable(),
  }),
});

/** As-run: an item left the air (wire `track.ended`). */
export const engineTrackEndedEventSchema = z.object({
  ...envelope,
  type: z.literal('engine.track.ended'),
  data: z.object({
    ...engineOrigin,
    itemId: z.string().nullable(),
    segmentId: z.string().nullable(),
    source: engineSourceSchema,
    startedAt: isoTime,
    /** Seconds it was the on-air item. */
    played: z.number().nonnegative(),
  }),
});

export const engineLiveConnectedEventSchema = z.object({
  ...envelope,
  type: z.literal('engine.live.connected'),
  /** The DJ software's HTTP headers (never Authorization). */
  data: z.object({ ...engineOrigin, headers: z.array(z.tuple([z.string(), z.string()])) }),
});

export const engineLiveDisconnectedEventSchema = z.object({
  ...envelope,
  type: z.literal('engine.live.disconnected'),
  data: z.object(engineOrigin),
});

/** Node opened or closed the live gate. */
export const engineLiveGateEventSchema = z.object({
  ...envelope,
  type: z.literal('engine.live.gate'),
  data: z.object({ ...engineOrigin, enabled: z.boolean() }),
});

/** Silence on the output for longer than the station's blank threshold. */
export const engineBlankDetectedEventSchema = z.object({
  ...envelope,
  type: z.literal('engine.blank.detected'),
  data: z.object(engineOrigin),
});

export const engineBlankRecoveredEventSchema = z.object({
  ...envelope,
  type: z.literal('engine.blank.recovered'),
  data: z.object(engineOrigin),
});

export const engineRealtimeEventSchema = z.discriminatedUnion('type', [
  engineUpEventSchema,
  engineDownEventSchema,
  engineBootedEventSchema,
  engineTrackStartedEventSchema,
  engineTrackEndedEventSchema,
  engineLiveConnectedEventSchema,
  engineLiveDisconnectedEventSchema,
  engineLiveGateEventSchema,
  engineBlankDetectedEventSchema,
  engineBlankRecoveredEventSchema,
]);
export type EngineRealtimeEvent = z.infer<typeof engineRealtimeEventSchema>;

// ---------------------------------------------------------------------------------------
// Every real-time event. Add other domains' schemas to this union.

export const realtimeEventSchema = z.discriminatedUnion('type', [
  ...engineRealtimeEventSchema.options,
]);
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;
export type RealtimeEventType = RealtimeEvent['type'];
