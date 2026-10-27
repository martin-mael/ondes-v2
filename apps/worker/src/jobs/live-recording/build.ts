import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assetPlannedInLog,
  attachLiveRecordingAsset,
  claimLiveRecordingBuild,
  createLiveRecordingUpload,
  type Db,
  deleteAsset,
  failLiveRecordingBuild,
  findUploadByStagingKey,
  finishLiveRecordingBuild,
  getUpload,
  type LiveRecordingRow,
  listLiveRecordingParts,
  resolveStationScope,
  type StationContext,
} from '@ondes/db';
import {
  type LiveRecordingJobPayload,
  type RealtimeEvent,
  realtimeEventSchema,
} from '@ondes/shared';
import { orgPrefix, type Storage } from '@ondes/storage';
import { audioStream, durationSamples, ffprobe, type Tools } from '../ingest/ffmpeg.ts';
import { type IngestDeps, ingest } from '../ingest/ingest.ts';
import { isPartFile, joinParts } from './join.ts';

// `live-recording` job (#67, ADR 0039): one version of a recording → the episode's audio.
//
//   1. claim the version (`processing`), or do nothing: a newer part came, a part is still
//      being written, or this version is built already
//   2. join its parts (the engine's files in `<cache>/<station>/recordings`, in air order)
//   3. upload the joined FLAC as a `queued` upload and ingest it inline (the same `ingest` as
//      a browser upload: playout copy, dedupe, `asset.ingested` → loudness, autocue, peaks)
//   4. attach the asset to the episode (an unbound session's stays in the library), record
//      the build, and delete the asset it replaced unless the log still plans it
//
// Idempotent: the claim and the version make a redelivery a no-op, and ingest dedupes the
// station's audio by hash, so a retried build of the same parts ends on the same asset. A
// failed attempt is retried by the queue; the last one marks the recording `failed`.

export const LIVE_RECORDING_ACTOR = { type: 'system', name: 'live-recording' } as const;

export interface LiveRecordingDeps {
  db: Db;
  storage: Storage;
  tools: Tools;
  publish(event: RealtimeEvent): Promise<void>;
  /** The host directory of the station caches (PLAYOUT_CACHE_ROOT). Null: no local files. */
  cacheRoot: string | null;
  tmpDir?: string;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

export interface LiveRecordingRun {
  attempt: number;
  isLastAttempt: boolean;
  signal?: AbortSignal;
}

/** The station's recordings directory as the worker sees it. */
export function recordingsDir(cacheRoot: string, stationId: string): string {
  return join(cacheRoot, stationId, 'recordings');
}

export type BuildResult =
  | { status: 'skipped' }
  | { status: 'ready'; assetId: string; durationMs: number; buildMs: number }
  | { status: 'failed'; error: string };

/** A build that can't succeed as it is (a file is gone): no retry. */
class BuildError extends Error {}

export async function buildLiveRecording(
  deps: LiveRecordingDeps,
  payload: LiveRecordingJobPayload,
  run: LiveRecordingRun,
): Promise<BuildResult> {
  const now = deps.now ?? (() => new Date());
  const scope = await resolveStationScope(deps.db, payload.orgId, payload.stationId);
  const ctx: StationContext = { actor: LIVE_RECORDING_ACTOR, scope };
  const claimed = await claimLiveRecordingBuild(
    deps.db,
    scope,
    payload.recordingId,
    payload.version,
  );
  if (!claimed) return { status: 'skipped' };
  await publish(deps, claimed);
  const started = now().getTime();
  const work = await mkdtemp(join(deps.tmpDir ?? tmpdir(), 'ondes-live-recording-'));
  try {
    const built = await build(deps, ctx, claimed, work, run);
    const buildMs = now().getTime() - started;
    const finished = await finishLiveRecordingBuild(deps.db, scope, claimed.id, payload.version, {
      ...built,
      buildMs,
    });
    if (finished) {
      await publish(deps, finished.row);
      if (finished.replacedAssetId) await dropReplaced(deps, ctx, finished.replacedAssetId);
    }
    deps.log?.({
      level: 'info',
      msg: 'live recording built',
      stationId: scope.stationId,
      recordingId: claimed.id,
      version: payload.version,
      durationMs: built.durationMs,
      buildMs,
    });
    return { status: 'ready', assetId: built.assetId, durationMs: built.durationMs, buildMs };
  } catch (error) {
    const final = error instanceof BuildError || run.isLastAttempt;
    if (!final) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const failed = await failLiveRecordingBuild(
      deps.db,
      scope,
      claimed.id,
      payload.version,
      message,
    );
    if (failed) await publish(deps, failed);
    return { status: 'failed', error: message };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function build(
  deps: LiveRecordingDeps,
  ctx: StationContext,
  recording: LiveRecordingRow,
  work: string,
  run: LiveRecordingRun,
): Promise<{ assetId: string; uploadId: string; durationMs: number }> {
  const { scope } = ctx;
  if (!deps.cacheRoot) {
    throw new BuildError('this worker keeps no playout cache (PLAYOUT_CACHE_ROOT is not set)');
  }
  const parts = (await listLiveRecordingParts(deps.db, scope, recording.id)).filter(
    (p) => p.status === 'closed' || p.status === 'interrupted' || p.status === 'deleted',
  );
  if (parts.length === 0) throw new BuildError('no recorded parts');
  const dir = recordingsDir(deps.cacheRoot, scope.stationId);
  const paths: string[] = [];
  for (const part of parts) {
    if (!isPartFile(part.file)) throw new BuildError(`not an engine recording: ${part.file}`);
    const path = join(dir, part.file);
    if (part.status === 'deleted' || !(await exists(path))) {
      throw new BuildError(`recording file ${part.file} is gone`);
    }
    paths.push(path);
  }
  const expectedSeconds = parts.reduce(
    (s, p) => s + ((p.endedAt ?? p.startedAt).getTime() - p.startedAt.getTime()) / 1000,
    0,
  );
  const out = join(work, 'joined.flac');
  const firstStart = parts[0]?.startedAt ?? new Date();
  await joinParts(deps.tools, paths, out, {
    work,
    expectedSeconds,
    signal: run.signal,
    tags: {
      title: recording.title ?? 'Live',
      date: firstStart.toISOString().slice(0, 10),
    },
  });
  const durationMs = await durationOf(deps.tools, out, run.signal);
  const { size, sha256 } = await digest(out);

  // 3. One upload per version, found again by its staging key: a retried attempt resumes it
  //    (ingest picks a `processing` upload up where it stopped) instead of leaving it behind.
  //    Ingest deletes the staging object once the asset's files are stored.
  const stagingKey = `${orgPrefix(scope.orgId)}uploads/live-${recording.id}-v${recording.version}`;
  let upload = await findUploadByStagingKey(deps.db, scope, stagingKey);
  const pending = !upload || upload.status === 'queued' || upload.status === 'processing';
  if (pending && !(await deps.storage.head(stagingKey))) {
    await deps.storage.put(stagingKey, createReadStream(out), {
      contentType: 'audio/flac',
      contentLength: size,
      metadata: { sha256 },
    });
  }
  upload ??= await createLiveRecordingUpload(deps.db, ctx, {
    filename: `${fileTitle(recording.title)} ${firstStart.toISOString().slice(0, 10)}.flac`,
    sizeBytes: size,
    assetType: recording.episodeId ? 'episode' : 'other',
    stagingKey,
  });
  const ingestDeps: IngestDeps = {
    db: deps.db,
    storage: deps.storage,
    tools: deps.tools,
    publish: deps.publish,
    tmpDir: work,
  };
  // Ingest's own retries are this job's: a failure throws to the queue.
  await ingest(
    ingestDeps,
    { orgId: scope.orgId, stationId: scope.stationId, uploadId: upload.id, generation: 0 },
    { attempt: 1, isLastAttempt: run.isLastAttempt, signal: run.signal },
  );
  const ingested = await getUpload(deps.db, scope, upload.id);
  const assetId =
    ingested.status === 'ingested'
      ? ingested.assetId
      : ingested.status === 'duplicate'
        ? ingested.duplicateOfAssetId
        : null;
  if (!assetId) {
    throw new BuildError(
      `ingest ended ${ingested.status}${ingested.error ? `: ${ingested.error}` : ''}`,
    );
  }

  // 4. The episode's audio. An unbound session's recording is a library asset only.
  if (recording.episodeId) {
    const attached = await attachLiveRecordingAsset(deps.db, ctx, recording.episodeId, assetId);
    if (!attached) throw new BuildError('the episode was deleted');
  }
  return { assetId, uploadId: upload.id, durationMs };
}

/** The previous build's asset: deleted, unless the log still plans it (a rerun of it). */
async function dropReplaced(deps: LiveRecordingDeps, ctx: StationContext, assetId: string) {
  try {
    if (await assetPlannedInLog(deps.db, ctx.scope, assetId)) return;
    await deleteAsset(deps.db, ctx, assetId);
  } catch (err) {
    deps.log?.({
      level: 'warn',
      msg: 'replaced live recording asset kept',
      assetId,
      err: String(err),
    });
  }
}

async function publish(deps: LiveRecordingDeps, row: LiveRecordingRow) {
  try {
    await deps.publish(
      realtimeEventSchema.parse({
        id: randomUUID(),
        stationId: row.stationId,
        at: new Date().toISOString(),
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
  } catch (err) {
    // Screens refetch on the next change; the row is the truth.
    deps.log?.({ level: 'warn', msg: 'live recording event publish failed', err: String(err) });
  }
}

async function durationOf(tools: Tools, path: string, signal?: AbortSignal): Promise<number> {
  const probe = await ffprobe(tools, path, signal);
  const stream = audioStream(probe);
  const samples = stream ? durationSamples(stream, probe) : null;
  const rate = stream?.sample_rate ?? 44100;
  return samples === null ? 0 : Math.round((samples / rate) * 1000);
}

async function digest(path: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { size: (await stat(path)).size, sha256: hash.digest('hex') };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const fileTitle = (title: string | null) =>
  (title ?? 'Live')
    .replaceAll(/[/\\:*?"<>|]+/g, ' ')
    .trim()
    .slice(0, 120) || 'Live';
