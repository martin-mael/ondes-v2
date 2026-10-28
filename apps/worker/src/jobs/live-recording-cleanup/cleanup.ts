import { constants } from 'node:fs';
import { access, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assetPlannedInLog,
  type Db,
  deleteAsset,
  getLiveRecordingSettings,
  knownLivePartFiles,
  type LiveRecordingRow,
  livePartsToDelete,
  liveRecordingsEndedBefore,
  markLivePartsDeleted,
  markLiveRecordingExpired,
  NotFoundError,
  resetStaleLiveRecordingBuilds,
  resolveStationScope,
  type StationContext,
} from '@ondes/db';
import {
  LIVE_RECORDING_FAILED_KEEP_MS,
  LIVE_RECORDING_LOCAL_KEEP_MS,
  type LiveRecordingCleanupJobPayload,
  type RealtimeEvent,
  realtimeEventSchema,
} from '@ondes/shared';
import { recordingsDir } from '../live-recording/build.ts';
import { isPartFile } from '../live-recording/join.ts';

// `live-recording-cleanup` job (#67, ADR 0039): one station's retention, hourly.
//
// - Audio: a recording whose show ended more than `retentionDays` ago loses its asset (the
//   episode stays, without audio; a `ready` episode turns `planned` through the
//   `episode_asset_cleared` trigger, so `episode_ready_asset_check` holds; ADR 0028 then
//   never picks it for a rerun) and turns `expired`. An asset the log still plans to air is
//   kept until that has aired. A failed recording (no audio) expires after the retention, or
//   after `LIVE_RECORDING_FAILED_KEEP_MS` when the station keeps recordings for good.
// - Builds nothing is running (a lost `pending` event, a crashed worker's claim) are
//   announced again, so the `live-recording` trigger enqueues them.
// - Local files (the engine's, in `<cache>/<station>/recordings`): deleted a day after their
//   recording was built (a later build starts from that build's audio in the bucket), at once
//   when it expired, or a day after they closed when nothing will build them (recording off,
//   or no session). Files the database doesn't know (a lost event, an engine opened by hand)
//   go a day after their last write.
//
// Each recording and file is its own step: one that fails is logged and the rest go on.
// Idempotent: every step looks at what is there now.

export const LIVE_RECORDING_CLEANUP_ACTOR = {
  type: 'system',
  name: 'live-recording-cleanup',
} as const;

export interface CleanupDeps {
  db: Db;
  cacheRoot: string | null;
  publish?(event: RealtimeEvent): Promise<void>;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

export type CleanupResult = { expired: number; filesDeleted: number; failed: number };

const DAY_MS = 24 * 60 * 60 * 1000;

export async function cleanupLiveRecordings(
  deps: CleanupDeps,
  payload: Required<Pick<LiveRecordingCleanupJobPayload, 'stationId'>> & { orgId: string },
): Promise<CleanupResult> {
  const now = deps.now?.() ?? new Date();
  const scope = await resolveStationScope(deps.db, payload.orgId, payload.stationId);
  const ctx: StationContext = { actor: LIVE_RECORDING_CLEANUP_ACTOR, scope };
  const settings = await getLiveRecordingSettings(deps.db, scope);
  const result: CleanupResult = { expired: 0, filesDeleted: 0, failed: 0 };
  const step = async (what: string, fields: Record<string, unknown>, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      result.failed++;
      deps.log?.({
        level: 'error',
        msg: `live recording cleanup: ${what} failed`,
        stationId: scope.stationId,
        ...fields,
        err: String(err),
      });
    }
  };
  const announce = async (row: LiveRecordingRow) => {
    await deps.publish?.(
      realtimeEventSchema.parse({
        id: crypto.randomUUID(),
        stationId: row.stationId,
        at: now.toISOString(),
        type: 'live.recording.updated',
        data: {
          orgId: row.orgId,
          recordingId: row.id,
          episodeId: row.episodeId,
          showId: row.showId,
          status: row.status,
          version: row.version,
        },
      }),
    );
  };

  const expiring = new Map<string, LiveRecordingRow>();
  if (settings.retentionDays !== null) {
    const before = new Date(now.getTime() - settings.retentionDays * DAY_MS);
    for (const r of await liveRecordingsEndedBefore(deps.db, scope, before)) expiring.set(r.id, r);
  }
  const failedBefore = new Date(now.getTime() - LIVE_RECORDING_FAILED_KEEP_MS);
  for (const r of await liveRecordingsEndedBefore(deps.db, scope, failedBefore, ['failed'])) {
    expiring.set(r.id, r);
  }
  for (const recording of expiring.values()) {
    await step('expiry', { recordingId: recording.id }, async () => {
      if (recording.assetId) {
        if (await assetPlannedInLog(deps.db, scope, recording.assetId, now)) return;
        try {
          await deleteAsset(deps.db, ctx, recording.assetId);
        } catch (err) {
          // Deleted by hand already: the recording still expires.
          if (!(err instanceof NotFoundError)) throw err;
        }
      }
      const row = await markLiveRecordingExpired(deps.db, scope, recording.id);
      result.expired++;
      if (row) await announce(row);
    });
  }

  await step('stale builds', {}, async () => {
    for (const row of await resetStaleLiveRecordingBuilds(deps.db, scope, now)) {
      deps.log?.({
        level: 'warn',
        msg: 'live recording build announced again',
        stationId: scope.stationId,
        recordingId: row.id,
        version: row.version,
      });
      await announce(row);
    }
  });

  if (deps.cacheRoot) {
    const dir = recordingsDir(deps.cacheRoot, scope.stationId);
    await step('recordings directory', { dir }, () => ensureDir(dir));
    const parts = await livePartsToDelete(deps.db, scope, now, LIVE_RECORDING_LOCAL_KEEP_MS);
    const deleted: string[] = [];
    for (const part of parts) {
      await step('file', { file: part.file }, async () => {
        if (isPartFile(part.file)) await rm(join(dir, part.file), { force: true });
        deleted.push(part.id);
        result.filesDeleted++;
      });
    }
    await markLivePartsDeleted(deps.db, scope, deleted);
    const known = await knownLivePartFiles(deps.db, scope);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!isPartFile(name) || known.has(name)) continue;
      await step('stray file', { file: name }, async () => {
        const info = await stat(join(dir, name)).catch(() => null);
        if (info && now.getTime() - info.mtimeMs > LIVE_RECORDING_LOCAL_KEEP_MS) {
          await rm(join(dir, name), { force: true });
          result.filesDeleted++;
        }
      });
    }
  }
  if (result.expired || result.filesDeleted || result.failed) {
    deps.log?.({
      level: result.failed ? 'warn' : 'info',
      msg: 'live recording cleanup',
      stationId: scope.stationId,
      ...result,
    });
  }
  return result;
}

/**
 * `<cache>/<station>/recordings`, made if missing. The api's engine lifecycle makes it first
 * (owned by its user, which the engine runs as; ADR 0039); this worker runs as the same user
 * and must be able to delete the engine's files there.
 */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o750 });
  try {
    await access(dir, constants.W_OK | constants.X_OK);
  } catch (err) {
    throw new Error(
      `${dir} is not writable by the worker: it must belong to the user the api and the worker run as (${String(err)})`,
    );
  }
}
