import { z } from 'zod';
import { uuidSchema } from './tenancy.ts';

// Live recording (#67, ADR 0039). Mirrors packages/db/src/schema/live-recording.ts.
//
//   engine: records the final mix while a DJ is on air, one FLAC file per live session
//           (`/recordings/<file>`, the station's `<cache>/recordings` on the host)
//      │  live.recording.started / live.recording.closed (wire events, engine.ts)
//      ▼
//   api (live/recording): one `live_recording_part` row per file, then the recording it
//           belongs to (the session's episode, or the session itself when it airs no
//           episode) is marked pending and `live.recording.updated` is published
//      │  durable event queue `worker.live-recording`
//      ▼
//   worker `live-recording` job: joins the parts of the recording in air order, uploads the
//           joined FLAC as an upload, ingests it inline (playout copy, `asset.ingested` →
//           loudness, autocue, peaks) and attaches the asset to the episode
//
// One recording per episode, else per event, else per (ad hoc) session: a handover inside a
// slot or an event (#66) keeps the binding, so both DJs end up in one recording.
// A DJ who hangs up and reconnects within their slot gets a new session on the same episode
// (ADR 0033): its file is a new part of the same recording, and the job rebuilds the episode's
// audio from all parts. The job is keyed by the recording and its parts (`version`), so a
// redelivered event does nothing and a new part starts a new build.

export const LIVE_RECORDING_JOB = 'live-recording';
export const LIVE_RECORDING_CLEANUP_JOB = 'live-recording-cleanup';

/**
 * `recording`: the engine is writing it. `closed`: complete. `interrupted`: the engine
 * restarted while writing it (the file is readable up to the crash), or a newer file of the
 * same boot started before it closed; the build uses what the file holds, if anything.
 * `deleted`: the local file was removed (after its recording was built, or by the retention
 * sweep); a later build starts from the recording's last audio instead.
 */
export const liveRecordingPartStatusSchema = z.enum([
  'recording',
  'closed',
  'interrupted',
  'deleted',
]);
export type LiveRecordingPartStatus = z.infer<typeof liveRecordingPartStatusSchema>;

/**
 * `recording`: a part is still being written. `pending`: waiting for the job. `processing`:
 * the job is joining and ingesting it. `ready`: the asset is attached. `failed`: see `error`
 * (retried by the next part, or by hand). `expired`: the retention policy deleted its audio.
 * `skipped`: recording is off for the station; the parts are only kept locally until swept.
 */
export const liveRecordingStatusSchema = z.enum([
  'recording',
  'pending',
  'processing',
  'ready',
  'failed',
  'expired',
  'skipped',
]);
export type LiveRecordingStatus = z.infer<typeof liveRecordingStatusSchema>;

/** Per-station settings (`GET/PUT …/live/recording/settings`, `live:manage` to write). */
export const liveRecordingSettingsSchema = z.object({
  /** Turn live sessions into episode audio. Off: the engine's files are swept, unused. */
  enabled: z.boolean(),
  /**
   * Days a recording's audio is kept after its show, then deleted (the episode stays, without
   * audio). Null: kept for good. Audio still planned in the log is kept until it aired.
   */
  retentionDays: z.int().min(1).max(3650).nullable(),
});
export type LiveRecordingSettings = z.infer<typeof liveRecordingSettingsSchema>;

export const DEFAULT_LIVE_RECORDING_SETTINGS: LiveRecordingSettings = {
  enabled: true,
  retentionDays: null,
};

export const updateLiveRecordingSettingsSchema = liveRecordingSettingsSchema
  .partial()
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), 'empty update');
export type UpdateLiveRecordingSettings = z.infer<typeof updateLiveRecordingSettingsSchema>;

export const liveRecordingPartSchema = z.object({
  id: uuidSchema,
  sessionId: uuidSchema,
  status: liveRecordingPartStatusSchema,
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type LiveRecordingPart = z.infer<typeof liveRecordingPartSchema>;

/** One recording: an episode's (or an unbound session's) live audio, built from its parts. */
export const liveRecordingSchema = z.object({
  id: uuidSchema,
  stationId: uuidSchema,
  /** The episode it is the audio of; null for a session that aired no episode (ad hoc, event). */
  episodeId: uuidSchema.nullable(),
  /** Without episode: the event it aired (all its sessions), else its one (ad hoc) session. */
  eventId: uuidSchema.nullable(),
  sessionId: uuidSchema.nullable(),
  title: z.string().nullable(),
  status: liveRecordingStatusSchema,
  /** Bumped by every part that closes; the job builds one version at a time. */
  version: z.int().min(0),
  /** Joined length, once built. */
  durationMs: z.int().min(0).nullable(),
  assetId: uuidSchema.nullable(),
  error: z.string().nullable(),
  /** When the last build finished, and how long it took (joining + upload + ingest). */
  builtAt: z.iso.datetime({ offset: true }).nullable(),
  buildMs: z.int().min(0).nullable(),
  /** When its audio is deleted under the station's retention; null: kept. */
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  parts: z.array(liveRecordingPartSchema),
  createdAt: z.iso.datetime({ offset: true }),
});
export type LiveRecording = z.infer<typeof liveRecordingSchema>;

/** `GET …/shows/:showId/episodes/:episodeId/recording`. */
export const episodeLiveRecordingSchema = z.object({ recording: liveRecordingSchema.nullable() });
export type EpisodeLiveRecording = z.infer<typeof episodeLiveRecordingSchema>;

/**
 * Statuses a recording can be built again from (`POST …/rebuild`): the others are building
 * already, or have no audio left to build from.
 */
export const LIVE_RECORDING_REBUILDABLE: readonly LiveRecordingStatus[] = [
  'ready',
  'failed',
  'skipped',
];

/** `live-recording` job: build one version of a recording. */
export const liveRecordingJobPayloadSchema = z.object({
  orgId: uuidSchema,
  stationId: uuidSchema,
  recordingId: uuidSchema,
  version: z.int().min(0),
});
export type LiveRecordingJobPayload = z.infer<typeof liveRecordingJobPayloadSchema>;

export function liveRecordingIdempotencyKey(p: LiveRecordingJobPayload): string {
  return `live-recording:${p.recordingId}:${p.version}`;
}

/** `live-recording-cleanup` job: one station's retention sweep (or every station's). */
export const liveRecordingCleanupJobPayloadSchema = z.object({
  stationId: uuidSchema.optional(),
});
export type LiveRecordingCleanupJobPayload = z.infer<typeof liveRecordingCleanupJobPayloadSchema>;

/**
 * Local engine files are kept this long after their recording was built. A later build (a
 * late part, a rebuild) starts from the recording's last audio in the bucket once they are gone.
 */
export const LIVE_RECORDING_LOCAL_KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * A failed recording (nothing built) is expired, and its files swept, this long after its
 * show when the station keeps recordings for good: someone had a month to fix it.
 */
export const LIVE_RECORDING_FAILED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A build's claim on a recording: another build waits (retries) while it holds; a claim older
 * than this is a crashed worker's and is taken over.
 */
export const LIVE_RECORDING_BUILD_LEASE_MS = 30 * 60 * 1000;
