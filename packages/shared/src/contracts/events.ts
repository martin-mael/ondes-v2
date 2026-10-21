import { z } from 'zod';
import { alertSeveritySchema, alertStatusSchema, silenceSettingsSchema } from './alerts.ts';
import { engineSourceSchema } from './engine.ts';
import { assetIngestedDataSchema, uploadUpdatedDataSchema } from './library-jobs.ts';
import {
  localDateSchema,
  logItemChangeSchema,
  logItemSchema,
  logUpdateCauseSchema,
} from './log.ts';

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

/**
 * The engine lifecycle (#35) stopped restarting a station's engine: it restarted too often
 * in a short window (a crash loop). The engine stays stopped until someone restarts it.
 */
export const engineRestartStormEventSchema = z.object({
  ...envelope,
  type: z.literal('engine.restart_storm'),
  data: z.object({
    /** Last boot the health monitor saw, if any. */
    bootId: z.string().nullable(),
    /** Restarts counted in the window, the last one included. */
    restarts: z.int().positive(),
    windowSeconds: z.int().positive(),
  }),
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
  engineRestartStormEventSchema,
]);
export type EngineRealtimeEvent = z.infer<typeof engineRealtimeEventSchema>;

// ---------------------------------------------------------------------------------------
// Log (#100). Published after the change is committed. Consumers refetch the range over HTTP
// (`GET …/log?from&to`) rather than patching from events: events are transient (no replay).

/** Some of the station's log changed between `from` and `to` (planned times, UTC). */
export const logUpdatedEventSchema = z.object({
  ...envelope,
  type: z.literal('log.updated'),
  data: z.object({
    from: isoTime,
    to: isoTime,
    /** The log days touched, at their new version. */
    days: z.array(
      z.object({ logDayId: z.uuid(), localDate: localDateSchema, version: z.int().min(1) }),
    ),
    cause: logUpdateCauseSchema,
  }),
});

/** One item was edited. Followed by the `log.updated` covering it. */
export const logItemChangedEventSchema = z.object({
  ...envelope,
  type: z.literal('log.item.changed'),
  data: z.object({
    itemId: z.uuid(),
    logDayId: z.uuid(),
    change: logItemChangeSchema,
    /** The item after the change; null once deleted. */
    item: logItemSchema.nullable(),
  }),
});

export const logRealtimeEventSchema = z.discriminatedUnion('type', [
  logUpdatedEventSchema,
  logItemChangedEventSchema,
]);
export type LogRealtimeEvent = z.infer<typeof logRealtimeEventSchema>;
// Alerts (#33). `data` is a snapshot of the alert after the change (API shape in
// `contracts/alerts.ts`, with ISO times). A repeat raise of an open alert publishes nothing.
// These are for the UI (best effort): side effects run from durable consumers (ADR 0006).

const alertSnapshotSchema = z.object({
  alertId: z.uuid(),
  type: z.string(),
  severity: alertSeveritySchema,
  status: alertStatusSchema,
  dedupeKey: z.string(),
  title: z.string(),
  message: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  occurrences: z.int().positive(),
  raisedAt: isoTime,
  acknowledgedAt: isoTime.nullable(),
  acknowledgedBy: z.uuid().nullable(),
  resolvedAt: isoTime.nullable(),
  resolution: z.string().nullable(),
  action: z
    .object({
      name: z.string(),
      state: z.enum(['pending', 'running', 'done', 'failed']),
      attempts: z.int().nonnegative(),
      error: z.string().nullable(),
    })
    .nullable(),
});
export type AlertSnapshot = z.infer<typeof alertSnapshotSchema>;

export const alertRaisedEventSchema = z.object({
  ...envelope,
  type: z.literal('alert.raised'),
  data: alertSnapshotSchema,
});

/** The same problem came back shortly after it was resolved: the alert is open again. */
export const alertReopenedEventSchema = z.object({
  ...envelope,
  type: z.literal('alert.reopened'),
  data: alertSnapshotSchema,
});

/** Severity went up: a raise at a higher severity, or a time-based escalation. */
export const alertEscalatedEventSchema = z.object({
  ...envelope,
  type: z.literal('alert.escalated'),
  data: alertSnapshotSchema.extend({ previousSeverity: alertSeveritySchema }),
});

export const alertAcknowledgedEventSchema = z.object({
  ...envelope,
  type: z.literal('alert.acknowledged'),
  data: alertSnapshotSchema,
});

export const alertResolvedEventSchema = z.object({
  ...envelope,
  type: z.literal('alert.resolved'),
  data: alertSnapshotSchema,
});

/**
 * A station's silence settings changed. `maxSeconds` / `thresholdDb` are the template's
 * `blank` settings: the engine lifecycle (#35) re-renders the station's config.
 */
export const alertSilenceSettingsUpdatedEventSchema = z.object({
  ...envelope,
  type: z.literal('alert.silence_settings.updated'),
  data: silenceSettingsSchema,
});

export const alertRealtimeEventSchema = z.discriminatedUnion('type', [
  alertRaisedEventSchema,
  alertReopenedEventSchema,
  alertEscalatedEventSchema,
  alertAcknowledgedEventSchema,
  alertResolvedEventSchema,
  alertSilenceSettingsUpdatedEventSchema,
]);
export type AlertRealtimeEvent = z.infer<typeof alertRealtimeEventSchema>;
// Library (#18). Data schemas live in `library-jobs.ts`.

/** Ingest finished: the asset has its master and playout files. Analysis jobs start here. */
export const assetIngestedEventSchema = z.object({
  ...envelope,
  type: z.literal('asset.ingested'),
  data: assetIngestedDataSchema,
});

/** An upload changed status (queued, processing, ingested, duplicate, quarantined, …). */
export const uploadUpdatedEventSchema = z.object({
  ...envelope,
  type: z.literal('upload.updated'),
  data: uploadUpdatedDataSchema,
});

export const libraryRealtimeEventSchema = z.discriminatedUnion('type', [
  assetIngestedEventSchema,
  uploadUpdatedEventSchema,
]);
export type LibraryRealtimeEvent = z.infer<typeof libraryRealtimeEventSchema>;
export type AssetIngestedEvent = z.infer<typeof assetIngestedEventSchema>;

// ---------------------------------------------------------------------------------------
// Every real-time event. Add other domains' schemas to this union.

export const realtimeEventSchema = z.discriminatedUnion('type', [
  ...engineRealtimeEventSchema.options,
  ...logRealtimeEventSchema.options,
  ...alertRealtimeEventSchema.options,
  ...libraryRealtimeEventSchema.options,
]);
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;
export type RealtimeEventType = RealtimeEvent['type'];
