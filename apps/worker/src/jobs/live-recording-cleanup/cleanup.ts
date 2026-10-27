import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assetPlannedInLog,
  type Db,
  deleteAsset,
  getLiveRecordingSettings,
  knownLivePartFiles,
  livePartsToDelete,
  liveRecordingsEndedBefore,
  markLivePartsDeleted,
  markLiveRecordingExpired,
  NotFoundError,
  resolveStationScope,
  type StationContext,
} from '@ondes/db';
import {
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
//   episode stays, without audio; ADR 0028 then never picks it for a rerun) and turns
//   `expired`. An asset the log still plans to air is kept until that has aired.
// - Local files (the engine's, in `<cache>/<station>/recordings`): deleted a day after their
//   recording was built (a rebuild needs them), or a day after they closed when nothing will
//   build them (recording off, or no session). Files the database doesn't know (a lost
//   event, an engine opened by hand) go a day after their last write.
// - The directory itself is made here, world-writable: the engine runs as another user than
//   the worker, and Docker would create a missing mount point owned by root.
//
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

export type CleanupResult = { expired: number; filesDeleted: number };

const DAY_MS = 24 * 60 * 60 * 1000;

export async function cleanupLiveRecordings(
  deps: CleanupDeps,
  payload: Required<Pick<LiveRecordingCleanupJobPayload, 'stationId'>> & { orgId: string },
): Promise<CleanupResult> {
  const now = deps.now?.() ?? new Date();
  const scope = await resolveStationScope(deps.db, payload.orgId, payload.stationId);
  const ctx: StationContext = { actor: LIVE_RECORDING_CLEANUP_ACTOR, scope };
  const settings = await getLiveRecordingSettings(deps.db, scope);
  let expired = 0;
  if (settings.retentionDays !== null) {
    const before = new Date(now.getTime() - settings.retentionDays * DAY_MS);
    for (const recording of await liveRecordingsEndedBefore(deps.db, scope, before)) {
      if (recording.assetId) {
        if (await assetPlannedInLog(deps.db, scope, recording.assetId, now)) continue;
        try {
          await deleteAsset(deps.db, ctx, recording.assetId);
        } catch (err) {
          // Deleted by hand already: the recording still expires.
          if (!(err instanceof NotFoundError)) throw err;
        }
      }
      const row = await markLiveRecordingExpired(deps.db, scope, recording.id);
      expired++;
      if (row && deps.publish) {
        await deps.publish(
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
      }
    }
  }

  let filesDeleted = 0;
  if (deps.cacheRoot) {
    const dir = recordingsDir(deps.cacheRoot, scope.stationId);
    await ensureDir(dir);
    const parts = await livePartsToDelete(deps.db, scope, now, LIVE_RECORDING_LOCAL_KEEP_MS);
    for (const part of parts) {
      if (isPartFile(part.file)) await rm(join(dir, part.file), { force: true });
      filesDeleted++;
    }
    await markLivePartsDeleted(
      deps.db,
      scope,
      parts.map((p) => p.id),
    );
    const known = await knownLivePartFiles(deps.db, scope);
    for (const name of await readdir(dir)) {
      if (!isPartFile(name) || known.has(name)) continue;
      const info = await stat(join(dir, name)).catch(() => null);
      if (info && now.getTime() - info.mtimeMs > LIVE_RECORDING_LOCAL_KEEP_MS) {
        await rm(join(dir, name), { force: true });
        filesDeleted++;
      }
    }
  }
  if (expired || filesDeleted) {
    deps.log?.({
      level: 'info',
      msg: 'live recording cleanup',
      stationId: scope.stationId,
      expired,
      filesDeleted,
    });
  }
  return { expired, filesDeleted };
}

/** `<cache>/<station>/recordings`, writable by the engine's user (uid 100 in the image). */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const info = await stat(dir);
  // 0777 without the sticky bit: the worker must delete files the engine wrote. Fails when
  // Docker made the directory first (owned by root): the error says what to fix.
  if ((info.mode & 0o777) !== 0o777) {
    await chmod(dir, 0o777).catch((err: unknown) => {
      throw new Error(`${dir} is not writable by the engine (chmod 0777 it): ${String(err)}`);
    });
  }
}
