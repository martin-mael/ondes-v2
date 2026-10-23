import { z } from 'zod';
import { alertSeveritySchema, alertStatusSchema, silenceSettingsSchema } from './alerts.ts';
import { asRunEntrySchema } from './asrun.ts';
import type { Permission } from './auth.ts';
import { engineSourceSchema } from './engine.ts';
import { assetIngestedDataSchema, uploadUpdatedDataSchema } from './library-jobs.ts';
import {
  localDateSchema,
  logItemChangeSchema,
  logItemSchema,
  logUpdateCauseSchema,
} from './log.ts';
import {
  islandStatusSchema,
  segueChangeSchema,
  segueProblemCodeSchema,
  segueStatusSchema,
} from './segues.ts';

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
    /** The live session on air, for `source: live`; absent until the engine sends it. */
    liveSessionId: z.string().nullable().optional(),
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

/**
 * Something that changes how an asset plays was stored: its cue points (`cues`: autocue or a
 * manual edit), its loudness measurement (`loudness`), or its playout settings (`settings`:
 * normalisation, gain override, …). Rendered islands that use it are re-derived (#55).
 */
export const assetUpdatedEventSchema = z.object({
  ...envelope,
  type: z.literal('asset.updated'),
  data: z.object({
    assetId: z.uuid(),
    changes: z.array(z.enum(['cues', 'loudness', 'settings'])).min(1),
  }),
});

/** An asset was deleted. */
export const assetDeletedEventSchema = z.object({
  ...envelope,
  type: z.literal('asset.deleted'),
  data: z.object({ assetId: z.uuid() }),
});

export const libraryRealtimeEventSchema = z.discriminatedUnion('type', [
  assetIngestedEventSchema,
  uploadUpdatedEventSchema,
  assetUpdatedEventSchema,
  assetDeletedEventSchema,
]);
export type LibraryRealtimeEvent = z.infer<typeof libraryRealtimeEventSchema>;
export type AssetIngestedEvent = z.infer<typeof assetIngestedEventSchema>;

// ---------------------------------------------------------------------------------------
// As-run (#30). Published after the entry is written, once per entry (a redelivered engine
// event publishes nothing). `data` is the entry as the API returns it.

/** An item took the air: its as-run entry was recorded (`endedAt` null). */
export const asRunStartedEventSchema = z.object({
  ...envelope,
  type: z.literal('asrun.started'),
  data: asRunEntrySchema,
});

/** An item left the air: its entry got its end, duration and outcome. */
export const asRunEndedEventSchema = z.object({
  ...envelope,
  type: z.literal('asrun.ended'),
  data: asRunEntrySchema,
});

export const asRunRealtimeEventSchema = z.discriminatedUnion('type', [
  asRunStartedEventSchema,
  asRunEndedEventSchema,
]);
export type AsRunRealtimeEvent = z.infer<typeof asRunRealtimeEventSchema>;

// ---------------------------------------------------------------------------------------
// Every real-time event. Add other domains' schemas to this union.

// ---------------------------------------------------------------------------------------
// Feeder (#29): what the just-in-time feeder decided, for the as-run log (#30) and the UI.

/**
 * A log item will not air: a later item went on air, or the feeder dropped it to meet an
 * anchor. Published once per item and engine boot; the id is deterministic in
 * `(station, item, boot)`, so a durable consumer can dedupe. Not the as-run `skipped` outcome
 * (an item that aired under 5 s, #30): a passed-over item never aired and has no as-run row.
 * `reason`: `not_cached` (not in the playout cache), `unresolvable` (the engine refused the
 * file), `no_media_file` (no playout file), `dropped` (removed by a soft or hard anchor).
 */
export const feederItemPassedOverEventSchema = z.object({
  ...envelope,
  type: z.literal('feeder.item.passed_over'),
  data: z.object({
    itemId: z.uuid(),
    logDayId: z.uuid(),
    /** The segment it belongs to, when a whole island chain is passed over. */
    segmentId: z.uuid().nullable(),
    plannedStart: isoTime,
    reason: z.enum(['not_cached', 'unresolvable', 'no_media_file', 'dropped']),
    bootId: z.string().nullable(),
  }),
});

export type FeederItemPassedOverEvent = z.infer<typeof feederItemPassedOverEventSchema>;

export const feederRealtimeEventSchema = z.discriminatedUnion('type', [
  feederItemPassedOverEventSchema,
]);

// ---------------------------------------------------------------------------------------
// Segues and islands (#55). Published after the change is committed; the segue editor (#58)
// refetches over HTTP. `island.updated` with status `pending` is what the renderer (#56)
// renders from (with a sweep of `GET …/islands?status=pending`, as events are transient).

/** A segue was created, saved, deleted, or its status changed when the log or media moved. */
export const segueChangedEventSchema = z.object({
  ...envelope,
  type: z.literal('segue.changed'),
  data: z.object({
    segueId: z.uuid(),
    change: segueChangeSchema,
    /** Null once deleted. */
    status: segueStatusSchema.nullable(),
    problem: segueProblemCodeSchema.nullable(),
    islandId: z.uuid().nullable(),
    fromItemId: z.uuid().nullable(),
    toItemId: z.uuid().nullable(),
  }),
});

/** An island was created, its spec changed (`pending`: render it), or its render moved on. */
export const islandUpdatedEventSchema = z.object({
  ...envelope,
  type: z.literal('island.updated'),
  data: z.object({
    islandId: z.uuid(),
    hash: z.string(),
    status: islandStatusSchema,
    segueIds: z.array(z.uuid()),
    headItemId: z.uuid(),
    tailItemId: z.uuid(),
  }),
});

/** An island is no longer needed (its segues changed shape or were deleted). */
export const islandRemovedEventSchema = z.object({
  ...envelope,
  type: z.literal('island.removed'),
  data: z.object({ islandId: z.uuid(), hash: z.string() }),
});

// ---------------------------------------------------------------------------------------
// Stations. Published by whatever updates a station's settings.

/** A station's settings changed; `fields` names them (e.g. `loudnessTargetLufs`). */
export const stationUpdatedEventSchema = z.object({
  ...envelope,
  type: z.literal('station.updated'),
  data: z.object({ fields: z.array(z.string()).min(1) }),
});

export const stationRealtimeEventSchema = z.discriminatedUnion('type', [stationUpdatedEventSchema]);

export const segueRealtimeEventSchema = z.discriminatedUnion('type', [
  segueChangedEventSchema,
  islandUpdatedEventSchema,
  islandRemovedEventSchema,
]);
export type SegueRealtimeEvent = z.infer<typeof segueRealtimeEventSchema>;

export const realtimeEventSchema = z.discriminatedUnion('type', [
  ...engineRealtimeEventSchema.options,
  ...logRealtimeEventSchema.options,
  ...alertRealtimeEventSchema.options,
  ...libraryRealtimeEventSchema.options,
  ...asRunRealtimeEventSchema.options,
  ...feederRealtimeEventSchema.options,
  ...segueRealtimeEventSchema.options,
  ...stationRealtimeEventSchema.options,
]);
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;
export type RealtimeEventType = RealtimeEvent['type'];

// ---------------------------------------------------------------------------------------
// Who may see what (#9). The SSE plugin forwards only the types declared here, each to the
// subscribers of its station that hold the listed permission, re-serialised through the
// type's schema (undeclared fields are dropped). A new event type must be added to this map:
// the type checker refuses a missing entry, and the plugin drops undeclared types.
// The browser fanout is best-effort: anything with side effects uses a durable queue.

export const realtimeEventPermissions = {
  'engine.up': 'engine:read',
  'engine.down': 'engine:read',
  'engine.booted': 'engine:read',
  'engine.track.started': 'engine:read',
  'engine.track.ended': 'engine:read',
  'engine.live.connected': 'engine:read',
  'engine.live.disconnected': 'engine:read',
  'engine.live.gate': 'engine:read',
  'engine.blank.detected': 'engine:read',
  'engine.blank.recovered': 'engine:read',
  'engine.restart_storm': 'engine:read',
  // Log (#100): the timeline refetches the changed range.
  'log.updated': 'log:read',
  'log.item.changed': 'log:read',
  // Alerts (#33): the dashboard and alert list.
  'alert.raised': 'alert:read',
  'alert.reopened': 'alert:read',
  'alert.escalated': 'alert:read',
  'alert.acknowledged': 'alert:read',
  'alert.resolved': 'alert:read',
  'alert.silence_settings.updated': 'alert:read',
  // Library (#18): new assets and upload progress for every reader. Upload progress is what
  // `GET …/uploads` already shows readers, and presenters (`library:read` only) wait on it for
  // the episodes (#45) and voice tracks (#59) they upload.
  'asset.ingested': 'library:read',
  'upload.updated': 'library:read',
  'asset.updated': 'library:read',
  'asset.deleted': 'library:read',
  // As-run (#30): history and now playing, for everyone who reads the log.
  'asrun.started': 'log:read',
  'asrun.ended': 'log:read',
  // Feeder (#29): items that won't air.
  'feeder.item.passed_over': 'engine:read',
  // Segues (#55): the segue editor and the timeline's VT badges.
  'segue.changed': 'voice_track:read',
  'island.updated': 'voice_track:read',
  'island.removed': 'voice_track:read',
  // Stations: settings screens refetch.
  'station.updated': 'station:read',
} as const satisfies Record<RealtimeEventType, Permission>;

/** Permission needed to receive `type` over SSE; `null` for types the contract doesn't declare. */
export function eventReadPermission(type: string): Permission | null {
  return Object.hasOwn(realtimeEventPermissions, type)
    ? realtimeEventPermissions[type as RealtimeEventType]
    : null;
}

// ---------------------------------------------------------------------------------------
// Stream-only events (#9). The api emits these itself on each SSE connection; they never go
// through the fanout, have no station and no `id` (so they don't move `Last-Event-ID`).

/** The api's current time, sent on connect and periodically. Clients derive their clock skew. */
export const serverClockEventSchema = z.object({
  type: z.literal('server.clock'),
  at: isoTime,
});
export type ServerClockEvent = z.infer<typeof serverClockEventSchema>;

/** Everything a browser can receive on `GET /api/v1/stations/:stationId/events`. */
export const streamEventSchema = z.discriminatedUnion('type', [
  ...realtimeEventSchema.options,
  serverClockEventSchema,
]);
export type StreamEvent = z.infer<typeof streamEventSchema>;
export type StreamEventType = StreamEvent['type'];
