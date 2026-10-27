import {
  DEFAULT_LIVE_RECORDING_SETTINGS,
  type LiveRecording,
  type LiveRecordingPartStatus,
  type LiveRecordingSettings,
  type LiveRecordingStatus,
  type UpdateLiveRecordingSettings,
} from '@ondes/shared';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { auditDiff, withAudit, writeAudit } from '../audit.ts';
import type { Db, Executor } from '../client.ts';
import { NotFoundError } from '../errors.ts';
import { liveSession } from '../schema/live.ts';
import {
  liveRecording,
  liveRecordingPart,
  liveRecordingSettings,
} from '../schema/live-recording.ts';
import { logItem } from '../schema/log.ts';
import { episode } from '../schema/shows.ts';
import { station } from '../schema/tenancy.ts';
import { upload } from '../schema/upload.ts';
import { type StationScope, whereStation } from '../tenant.ts';
import type { StationContext } from './tenancy.ts';
import { toUpload, type UploadRecord } from './upload.ts';

// Live recording (#67, ADR 0039): settings, the engine's files (parts) and the recordings
// they are joined into. The api records parts from the engine's events
// (apps/api/src/modules/live/recording); the worker's `live-recording` job builds them and its
// `live-recording-cleanup` job applies the retention.

export type LiveRecordingRow = typeof liveRecording.$inferSelect;
export type LiveRecordingPartRow = typeof liveRecordingPart.$inferSelect;

// --- Settings ----------------------------------------------------------------------------

export async function getLiveRecordingSettings(
  db: Executor,
  scope: StationScope,
): Promise<LiveRecordingSettings> {
  const [row] = await db
    .select()
    .from(liveRecordingSettings)
    .where(whereStation(liveRecordingSettings, scope));
  return row
    ? { enabled: row.enabled, retentionDays: row.retentionDays }
    : { ...DEFAULT_LIVE_RECORDING_SETTINGS };
}

export async function updateLiveRecordingSettings(
  db: Db,
  ctx: StationContext,
  patch: UpdateLiveRecordingSettings,
): Promise<LiveRecordingSettings> {
  return withAudit(db, ctx, async (tx, audit) => {
    const before = await getLiveRecordingSettings(tx, ctx.scope);
    const after = { ...before, ...definedOnly(patch) };
    await tx
      .insert(liveRecordingSettings)
      .values({ ...ctx.scope, ...after })
      .onConflictDoUpdate({ target: liveRecordingSettings.stationId, set: after });
    await audit({
      action: 'live_recording.settings.update',
      entity: { type: 'station', id: ctx.scope.stationId },
      diff: auditDiff(before, after),
    });
    return after;
  });
}

function definedOnly<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// --- Parts, from the engine's events -----------------------------------------------------

export type PartStarted = {
  file: string;
  sessionId: string;
  bootId: string;
  startedAt: Date;
};

export type PartClosed = PartStarted & {
  endedAt: Date;
  status: Extract<LiveRecordingPartStatus, 'closed' | 'interrupted'>;
};

/** What a part event changed: the recording to announce, if any. */
export type PartChange = { recording: LiveRecordingRow; changed: boolean } | null;

const OPEN: LiveRecordingPartStatus = 'recording';

/**
 * A file the engine opened. Assigned to its recording at once (so a build started meanwhile
 * by another part waits for it). Null when the session isn't known (another station's, or an
 * engine opened by hand): the part stays unassigned and is swept with its file.
 */
export async function recordPartStarted(
  db: Db,
  scope: StationScope,
  part: PartStarted,
): Promise<PartChange> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(liveRecordingPart)
      .values({ ...scope, ...part, status: OPEN })
      .onConflictDoNothing({ target: [liveRecordingPart.stationId, liveRecordingPart.file] })
      .returning();
    const row = inserted[0] ?? (await lockPart(tx, scope, part.file));
    if (!row || row.status !== OPEN) return null;
    if (row.recordingId) {
      const recording = await getRow(tx, scope, row.recordingId);
      return recording ? { recording, changed: false } : null;
    }
    const recording = await recordingOfSession(tx, scope, part.sessionId);
    if (!recording) return null;
    await tx
      .update(liveRecordingPart)
      .set({ recordingId: recording.id })
      .where(eq(liveRecordingPart.id, row.id));
    const [updated] = await tx
      .update(liveRecording)
      .set({ status: 'recording' })
      .where(eq(liveRecording.id, recording.id))
      .returning();
    return updated ? { recording: updated, changed: updated.status !== recording.status } : null;
  });
}

/**
 * A file the engine closed (or that a restart interrupted): one more part of its recording,
 * so its version goes up. When no other part is still open, the recording is `pending` (the
 * worker builds it), or `skipped` when the station records nothing. A redelivered event
 * changes nothing.
 */
export async function recordPartClosed(
  db: Db,
  scope: StationScope,
  part: PartClosed,
): Promise<PartChange> {
  return db.transaction(async (tx) => {
    await tx
      .insert(liveRecordingPart)
      .values({ ...scope, ...part, status: OPEN })
      .onConflictDoNothing({ target: [liveRecordingPart.stationId, liveRecordingPart.file] });
    const row = await lockPart(tx, scope, part.file);
    if (!row) return null;
    if (row.status !== OPEN) {
      const recording = row.recordingId ? await getRow(tx, scope, row.recordingId) : undefined;
      return recording ? { recording, changed: false } : null;
    }
    const recording = row.recordingId
      ? await lockRow(tx, scope, row.recordingId)
      : await recordingOfSession(tx, scope, part.sessionId);
    await tx
      .update(liveRecordingPart)
      .set({ status: part.status, endedAt: part.endedAt, recordingId: recording?.id ?? null })
      .where(eq(liveRecordingPart.id, row.id));
    if (!recording) return null;
    const [open] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(liveRecordingPart)
      .where(
        and(eq(liveRecordingPart.recordingId, recording.id), eq(liveRecordingPart.status, OPEN)),
      );
    const settings = await getLiveRecordingSettings(tx, scope);
    const status: LiveRecordingStatus =
      (open?.n ?? 0) > 0 ? 'recording' : settings.enabled ? 'pending' : 'skipped';
    const [updated] = await tx
      .update(liveRecording)
      .set({
        status,
        version: sql`${liveRecording.version} + 1`,
        endedAt: sql`greatest(${liveRecording.endedAt}, ${part.endedAt.toISOString()}::timestamptz)`,
      })
      .where(eq(liveRecording.id, recording.id))
      .returning();
    return updated ? { recording: updated, changed: true } : null;
  });
}

/** Files of earlier boots still open: the engine restarted while writing them. */
export async function openPartsOfOtherBoots(
  db: Executor,
  scope: StationScope,
  bootId: string,
): Promise<LiveRecordingPartRow[]> {
  return db
    .select()
    .from(liveRecordingPart)
    .where(
      and(
        whereStation(liveRecordingPart, scope),
        eq(liveRecordingPart.status, OPEN),
        ne(liveRecordingPart.bootId, bootId),
      ),
    );
}

async function lockPart(tx: Executor, scope: StationScope, file: string) {
  const [row] = await tx
    .select()
    .from(liveRecordingPart)
    .where(and(whereStation(liveRecordingPart, scope), eq(liveRecordingPart.file, file)))
    .for('update');
  return row;
}

async function getRow(tx: Executor, scope: StationScope, id: string) {
  const [row] = await tx
    .select()
    .from(liveRecording)
    .where(and(whereStation(liveRecording, scope), eq(liveRecording.id, id)));
  return row;
}

async function lockRow(tx: Executor, scope: StationScope, id: string) {
  const [row] = await tx
    .select()
    .from(liveRecording)
    .where(and(whereStation(liveRecording, scope), eq(liveRecording.id, id)))
    .for('update');
  return row;
}

/**
 * The recording a session's audio goes to, created if needed: its episode's, else its
 * event's (a handover inside an event keeps the event, #66), else its own. Undefined when
 * the session isn't one of the station's.
 */
async function recordingOfSession(
  tx: Executor,
  scope: StationScope,
  sessionId: string,
): Promise<LiveRecordingRow | undefined> {
  const [session] = await tx
    .select()
    .from(liveSession)
    .where(and(whereStation(liveSession, scope), eq(liveSession.id, sessionId)));
  if (!session) return undefined;
  const owner = session.episodeId
    ? { episodeId: session.episodeId, eventId: null, sessionId: null }
    : session.eventId
      ? { episodeId: null, eventId: session.eventId, sessionId: null }
      : { episodeId: null, eventId: null, sessionId: session.id };
  const title = session.episodeNumber
    ? `${session.title ?? 'Live'} #${session.episodeNumber}`
    : (session.title ?? session.streamerName ?? null);
  // Each partial unique index arbitrates its own kind of owner.
  await tx
    .insert(liveRecording)
    .values({ ...scope, ...owner, showId: session.showId, title, status: 'recording' })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(liveRecording)
    .where(
      and(
        whereStation(liveRecording, scope),
        owner.episodeId
          ? eq(liveRecording.episodeId, owner.episodeId)
          : owner.eventId
            ? and(isNull(liveRecording.episodeId), eq(liveRecording.eventId, owner.eventId))
            : and(
                isNull(liveRecording.episodeId),
                isNull(liveRecording.eventId),
                eq(liveRecording.sessionId, sessionId),
              ),
      ),
    )
    .for('update');
  return row;
}

// --- Builds (worker) ---------------------------------------------------------------------

/**
 * Claims a build of `version`: the recording is still at that version, has no open part and
 * isn't built at it yet. Null otherwise (a newer part came, or it is already done): the job
 * does nothing.
 */
export async function claimLiveRecordingBuild(
  db: Db,
  scope: StationScope,
  id: string,
  version: number,
): Promise<LiveRecordingRow | null> {
  return db.transaction(async (tx) => {
    const row = await lockRow(tx, scope, id);
    if (!row || row.version !== version || row.builtVersion === version) return null;
    if (!['pending', 'processing', 'failed'].includes(row.status)) return null;
    const [open] = await tx
      .select({ id: liveRecordingPart.id })
      .from(liveRecordingPart)
      .where(and(eq(liveRecordingPart.recordingId, id), eq(liveRecordingPart.status, OPEN)))
      .limit(1);
    if (open) return null;
    const [updated] = await tx
      .update(liveRecording)
      .set({ status: 'processing', error: null })
      .where(eq(liveRecording.id, id))
      .returning();
    return updated ?? null;
  });
}

/** The parts of a recording in air order (the engine's file names carry no order). */
export async function listLiveRecordingParts(
  db: Executor,
  scope: StationScope,
  recordingId: string,
): Promise<LiveRecordingPartRow[]> {
  return db
    .select()
    .from(liveRecordingPart)
    .where(
      and(whereStation(liveRecordingPart, scope), eq(liveRecordingPart.recordingId, recordingId)),
    )
    .orderBy(asc(liveRecordingPart.startedAt), asc(liveRecordingPart.file));
}

/**
 * Records a finished build of `version`, unless a newer version arrived meanwhile (then the
 * row stays `pending` for that one). Returns the row and the asset the build replaced.
 */
export async function finishLiveRecordingBuild(
  db: Executor,
  scope: StationScope,
  id: string,
  version: number,
  result: { assetId: string; uploadId: string; durationMs: number; buildMs: number },
): Promise<{ row: LiveRecordingRow; replacedAssetId: string | null } | null> {
  const before = await getRow(db, scope, id);
  if (!before) return null;
  const [row] = await db
    .update(liveRecording)
    .set({
      ...result,
      builtVersion: version,
      builtAt: new Date(),
      error: null,
      status: sql`case when ${liveRecording.version} = ${version} then 'ready' else ${liveRecording.status} end`,
    })
    .where(and(whereStation(liveRecording, scope), eq(liveRecording.id, id)))
    .returning();
  if (!row) return null;
  const replaced = before.assetId && before.assetId !== result.assetId ? before.assetId : null;
  return { row, replacedAssetId: replaced };
}

export async function failLiveRecordingBuild(
  db: Executor,
  scope: StationScope,
  id: string,
  version: number,
  error: string,
): Promise<LiveRecordingRow | null> {
  const [row] = await db
    .update(liveRecording)
    .set({ status: 'failed', error: error.slice(0, 2000) })
    .where(
      and(
        whereStation(liveRecording, scope),
        eq(liveRecording.id, id),
        eq(liveRecording.version, version),
      ),
    )
    .returning();
  return row ?? null;
}

/** Asks for another build of the current parts (`POST …/recording/rebuild`). */
export async function requestLiveRecordingRebuild(
  db: Db,
  ctx: StationContext,
  id: string,
): Promise<LiveRecordingRow> {
  return withAudit(db, ctx, async (tx, audit) => {
    const before = await lockRow(tx, ctx.scope, id);
    if (!before) throw new NotFoundError('live_recording', id);
    const [row] = await tx
      .update(liveRecording)
      .set({ status: 'pending', version: sql`${liveRecording.version} + 1`, error: null })
      .where(eq(liveRecording.id, id))
      .returning();
    if (!row) throw new NotFoundError('live_recording', id);
    await audit({
      action: 'live_recording.rebuild',
      entity: { type: 'live_recording', id },
      diff: auditDiff(
        { status: before.status, version: before.version },
        { status: row.status, version: row.version },
      ),
    });
    return row;
  });
}

// --- Reads -------------------------------------------------------------------------------

export async function getLiveRecording(
  db: Executor,
  scope: StationScope,
  id: string,
): Promise<LiveRecordingRow> {
  const row = await getRow(db, scope, id);
  if (!row) throw new NotFoundError('live_recording', id);
  return row;
}

export async function getEpisodeLiveRecording(
  db: Executor,
  scope: StationScope,
  episodeId: string,
): Promise<LiveRecording | null> {
  const [row] = await db
    .select()
    .from(liveRecording)
    .where(and(whereStation(liveRecording, scope), eq(liveRecording.episodeId, episodeId)));
  if (!row) return null;
  const parts = await listLiveRecordingParts(db, scope, row.id);
  const settings = await getLiveRecordingSettings(db, scope);
  return toLiveRecording(row, parts, settings);
}

export function liveRecordingExpiresAt(
  row: Pick<LiveRecordingRow, 'endedAt' | 'status'>,
  settings: LiveRecordingSettings,
): Date | null {
  if (settings.retentionDays === null || !row.endedAt || row.status === 'expired') return null;
  return new Date(row.endedAt.getTime() + settings.retentionDays * 24 * 60 * 60 * 1000);
}

export function toLiveRecording(
  row: LiveRecordingRow,
  parts: LiveRecordingPartRow[],
  settings: LiveRecordingSettings,
): LiveRecording {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    id: row.id,
    stationId: row.stationId,
    episodeId: row.episodeId,
    eventId: row.eventId,
    sessionId: row.sessionId,
    title: row.title,
    status: row.status,
    version: row.version,
    durationMs: row.durationMs,
    assetId: row.assetId,
    error: row.error,
    builtAt: iso(row.builtAt),
    buildMs: row.buildMs,
    expiresAt: iso(liveRecordingExpiresAt(row, settings)),
    parts: parts.map((p) => ({
      id: p.id,
      sessionId: p.sessionId,
      status: p.status,
      startedAt: p.startedAt.toISOString(),
      endedAt: iso(p.endedAt),
    })),
    createdAt: row.createdAt.toISOString(),
  };
}

// --- Retention (worker) ------------------------------------------------------------------

/** Every station with a retention, for the cleanup sweep. */
export async function liveRecordingRetentions(
  db: Executor,
): Promise<{ orgId: string; stationId: string; retentionDays: number }[]> {
  const rows = await db
    .select({
      orgId: liveRecordingSettings.orgId,
      stationId: liveRecordingSettings.stationId,
      retentionDays: liveRecordingSettings.retentionDays,
    })
    .from(liveRecordingSettings);
  return rows.flatMap((r) =>
    r.retentionDays === null ? [] : [{ ...r, retentionDays: r.retentionDays }],
  );
}

/** Built recordings of the station whose last part ended before `before`. */
export async function liveRecordingsEndedBefore(
  db: Executor,
  scope: StationScope,
  before: Date,
): Promise<LiveRecordingRow[]> {
  return db
    .select()
    .from(liveRecording)
    .where(
      and(
        whereStation(liveRecording, scope),
        inArray(liveRecording.status, ['ready', 'failed', 'skipped']),
        sql`${liveRecording.endedAt} < ${before.toISOString()}::timestamptz`,
      ),
    );
}

export async function markLiveRecordingExpired(
  db: Executor,
  scope: StationScope,
  id: string,
): Promise<LiveRecordingRow | null> {
  const [row] = await db
    .update(liveRecording)
    .set({ status: 'expired', assetId: null })
    .where(and(whereStation(liveRecording, scope), eq(liveRecording.id, id)))
    .returning();
  return row ?? null;
}

/**
 * Parts whose local file may go: their recording was built from them (or skipped) at least
 * `keepMs` ago, or they never belonged to a recording and closed that long ago.
 */
export async function livePartsToDelete(
  db: Executor,
  scope: StationScope,
  now: Date,
  keepMs: number,
): Promise<LiveRecordingPartRow[]> {
  const cutoff = new Date(now.getTime() - keepMs).toISOString();
  const rows = await db
    .select({ part: liveRecordingPart, recording: liveRecording })
    .from(liveRecordingPart)
    .leftJoin(liveRecording, eq(liveRecording.id, liveRecordingPart.recordingId))
    .where(
      and(
        whereStation(liveRecordingPart, scope),
        inArray(liveRecordingPart.status, ['closed', 'interrupted']),
        sql`${liveRecordingPart.updatedAt} < ${cutoff}::timestamptz`,
      ),
    );
  return rows
    .filter(({ recording }) => {
      if (!recording) return true;
      if (recording.status === 'skipped' || recording.status === 'expired') return true;
      return (
        recording.status === 'ready' &&
        recording.builtVersion === recording.version &&
        !!recording.builtAt &&
        recording.builtAt.toISOString() < cutoff
      );
    })
    .map(({ part }) => part);
}

export async function markLivePartsDeleted(
  db: Executor,
  scope: StationScope,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(liveRecordingPart)
    .set({ status: 'deleted' })
    .where(and(whereStation(liveRecordingPart, scope), inArray(liveRecordingPart.id, ids)));
}

/** File names the database knows for the station (any status): the rest are strays. */
export async function knownLivePartFiles(db: Executor, scope: StationScope): Promise<Set<string>> {
  const rows = await db
    .select({ file: liveRecordingPart.file, status: liveRecordingPart.status })
    .from(liveRecordingPart)
    .where(and(whereStation(liveRecordingPart, scope), ne(liveRecordingPart.status, 'deleted')));
  return new Set(rows.map((r) => r.file));
}

// --- The build's writes (worker) ---------------------------------------------------------

/**
 * An upload row for a joined recording, already in the bucket under `stagingKey` and
 * `queued` for ingest (no browser, no multipart upload). Ingest then treats it like any
 * upload: playout copy, dedupe, `asset.ingested`.
 */
export async function createLiveRecordingUpload(
  db: Db,
  ctx: StationContext,
  input: {
    filename: string;
    sizeBytes: number;
    assetType: 'episode' | 'other';
    stagingKey: string;
  },
): Promise<UploadRecord> {
  return withAudit(db, ctx, async (tx, audit) => {
    const [row] = await tx
      .insert(upload)
      .values({
        ...ctx.scope,
        ...input,
        status: 'queued',
        contentType: 'audio/flac',
        partSize: Math.max(1, input.sizeBytes),
        partCount: 1,
      })
      .returning();
    if (!row) throw new Error('insert returned no row');
    await audit({
      action: 'upload.create',
      entity: { type: 'upload', id: row.id },
      diff: auditDiff(null, toUpload(row), ['orgId', 'stationId']),
    });
    return row;
  });
}

/**
 * Makes `assetId` the episode's audio (audited as an episode update). A `planned` or
 * `missing` episode stays as it is but for the audio: it aired live, the as-run says so.
 * False when the episode is gone.
 */
export async function attachLiveRecordingAsset(
  db: Db,
  ctx: StationContext,
  episodeId: string,
  assetId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ assetId: episode.assetId })
      .from(episode)
      .where(and(whereStation(episode, ctx.scope), eq(episode.id, episodeId)))
      .for('update');
    if (!before) return false;
    if (before.assetId === assetId) return true;
    await tx
      .update(episode)
      .set({ assetId })
      .where(and(whereStation(episode, ctx.scope), eq(episode.id, episodeId)));
    await writeAudit(tx, ctx, {
      action: 'episode.update',
      entity: { type: 'episode', id: episodeId },
      diff: auditDiff(before, { assetId }),
    });
    return true;
  });
}

/**
 * Whether the log still plans an asset to air after `after` (a rerun of the old audio, or of
 * an expiring one): then it isn't deleted yet.
 */
export async function assetPlannedInLog(
  db: Executor,
  scope: StationScope,
  assetId: string,
  after: Date = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({ id: logItem.id })
    .from(logItem)
    .where(
      and(
        whereStation(logItem, scope),
        eq(logItem.assetId, assetId),
        sql`${logItem.plannedStart} >= ${after.toISOString()}::timestamptz`,
      ),
    )
    .limit(1);
  return !!row;
}

/** Every station (any of them may record): the cleanup sweep's list. */
export async function liveRecordingStations(
  db: Executor,
): Promise<{ orgId: string; stationId: string }[]> {
  return db.select({ orgId: station.orgId, stationId: station.id }).from(station);
}
