import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  claimLiveRecordingBuild,
  createLiveRecordingUpload,
  type Db,
  deleteAsset,
  failLiveRecordingBuild,
  findUploadByStagingKey,
  finishLiveRecordingBuild,
  getUpload,
  type LiveRecordingRow,
  listAssetFiles,
  listLiveRecordingParts,
  liveRecordingAssetInUse,
  releaseLiveRecordingBuild,
  resolveStationScope,
  type StationContext,
  type StationScope,
  stationTimezone,
} from '@ondes/db';
import {
  type LiveRecordingJobPayload,
  localDateOf,
  type RealtimeEvent,
  realtimeEventSchema,
} from '@ondes/shared';
import { orgPrefix, type Storage } from '@ondes/storage';
import { audioStream, durationSamples, ffprobe, type Tools } from '../ingest/ffmpeg.ts';
import { type IngestDeps, ingest } from '../ingest/ingest.ts';
import { isPartFile, joinParts } from './join.ts';

// `live-recording` job (#67, ADR 0039): one version of a recording → the episode's audio.
//
//   1. claim the recording for this version (`processing`, with a claim id), or do nothing: a
//      newer part came, a part is still being written, or this version is built already. If
//      another build holds the recording, throw: the queue retries once it is done
//   2. join its parts (the engine's files in `<cache>/<station>/recordings`, in air order).
//      Parts whose files were swept after an earlier build are that build's audio: the join
//      starts from its master in the bucket instead
//   3. upload the joined FLAC as a `queued` upload and ingest it inline (the same `ingest` as
//      a browser upload: playout copy, dedupe, `asset.ingested` → loudness, autocue, peaks)
//   4. record the build and attach the asset to the episode in one transaction, only if the
//      claim still holds (else this build lost and its asset goes), and never over other
//      audio (a manual upload stays; the recording waits in the library). Then delete the
//      asset it replaced unless something still uses it
//
// Idempotent: the claim and the version make a redelivery a no-op, and ingest dedupes the
// station's audio by hash, so a retried build of the same parts ends on the same asset. A
// failed attempt lets go of the claim and is retried by the queue; the last one marks the
// recording `failed`.

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

class BusyError extends Error {}

export async function buildLiveRecording(
  deps: LiveRecordingDeps,
  payload: LiveRecordingJobPayload,
  run: LiveRecordingRun,
): Promise<BuildResult> {
  const now = deps.now ?? (() => new Date());
  const scope = await resolveStationScope(deps.db, payload.orgId, payload.stationId);
  const ctx: StationContext = { actor: LIVE_RECORDING_ACTOR, scope };
  const claim = await claimLiveRecordingBuild(
    deps.db,
    scope,
    payload.recordingId,
    payload.version,
    now(),
  );
  if (claim.status === 'skip') return { status: 'skipped' };
  // Retried by the queue, never `succeeded`: the next pending event must still enqueue it.
  if (claim.status === 'busy') throw new BusyError('another build of this recording is running');
  const { row: claimed, claim: token } = claim;
  let work: string | undefined;
  try {
    await publish(deps, claimed);
    const started = now().getTime();
    work = await mkdtemp(join(deps.tmpDir ?? tmpdir(), 'ondes-live-recording-'));
    const built = await build(deps, ctx, claimed, work, run);
    const buildMs = now().getTime() - started;
    const finished = await finishLiveRecordingBuild(
      deps.db,
      ctx,
      claimed.id,
      payload.version,
      token,
      { ...built, buildMs },
    );
    if (finished.status === 'lost') {
      deps.log?.({
        level: 'warn',
        msg: 'live recording build lost its claim, result dropped',
        recordingId: claimed.id,
        version: payload.version,
      });
      await dropIfUnused(deps, ctx, built.assetId);
      return { status: 'skipped' };
    }
    if (finished.status === 'episode-gone') throw new BuildError('the episode was deleted');
    await publish(deps, finished.row);
    if (finished.replacedAssetId) await dropIfUnused(deps, ctx, finished.replacedAssetId);
    deps.log?.({
      level: 'info',
      msg: finished.attached
        ? 'live recording built'
        : 'live recording built; the episode keeps its other audio',
      stationId: scope.stationId,
      recordingId: claimed.id,
      version: payload.version,
      durationMs: built.durationMs,
      buildMs,
    });
    return { status: 'ready', assetId: built.assetId, durationMs: built.durationMs, buildMs };
  } catch (error) {
    const final = error instanceof BuildError || run.isLastAttempt;
    if (!final) {
      await releaseLiveRecordingBuild(deps.db, scope, claimed.id, token);
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const failed = await failLiveRecordingBuild(
      deps.db,
      scope,
      claimed.id,
      payload.version,
      token,
      message,
    );
    if (failed) await publish(deps, failed);
    return { status: 'failed', error: message };
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
  }
}

/** What the join reads: the engine's files, after the earlier build's audio if they were swept. */
type JoinInput = { path: string; seconds: number };

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
  const inputs: JoinInput[] = [];

  // Swept files were all in the last build (the sweep only takes a built recording's files):
  // they come first in air order, and that build's master stands in for them.
  const swept = parts.filter((p) => p.status === 'deleted');
  const rest = parts.filter((p) => p.status !== 'deleted');
  if (swept.length > 0) {
    const lastSwept = swept.at(-1)?.startedAt.getTime() ?? 0;
    if (rest.some((p) => p.startedAt.getTime() < lastSwept)) {
      throw new BuildError('a late part belongs before audio whose files were already swept');
    }
    inputs.push(await previousBuild(deps, scope, recording, work));
  }
  for (const part of rest) {
    if (!isPartFile(part.file)) throw new BuildError(`not an engine recording: ${part.file}`);
    const path = join(dir, part.file);
    const size = await sizeOf(path);
    const seconds = ((part.endedAt ?? part.startedAt).getTime() - part.startedAt.getTime()) / 1000;
    if (part.status === 'interrupted') {
      // Cut short (a crash, a write error): whatever the engine got into the file, if anything.
      if (size) inputs.push({ path, seconds });
      continue;
    }
    if (size === null) throw new BuildError(`recording file ${part.file} is gone`);
    inputs.push({ path, seconds });
  }
  if (inputs.length === 0) throw new BuildError('no recorded audio');

  const out = join(work, 'joined.flac');
  const firstStart = parts[0]?.startedAt ?? new Date();
  const timezone = (await stationTimezone(deps.db, scope)) ?? 'UTC';
  const date = recordingDate(firstStart, timezone);
  await joinParts(
    deps.tools,
    inputs.map((i) => i.path),
    out,
    {
      work,
      expectedSeconds: inputs.reduce((s, i) => s + i.seconds, 0),
      signal: run.signal,
      tags: { title: recording.title ?? 'Live', date },
    },
  );
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
    filename: `${fileTitle(recording.title)} ${date}.flac`,
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
  return { assetId, uploadId: upload.id, durationMs };
}

/** The last build's master, downloaded: the audio of the parts whose files were swept. */
async function previousBuild(
  deps: LiveRecordingDeps,
  scope: StationScope,
  recording: LiveRecordingRow,
  work: string,
): Promise<JoinInput> {
  const master = recording.assetId
    ? (await listAssetFiles(deps.db, scope, recording.assetId).catch(() => [])).find(
        (f) => f.role === 'master',
      )
    : undefined;
  if (!master) {
    throw new BuildError("the recorded files were swept and the recording's audio is gone");
  }
  const path = join(work, 'previous.flac');
  const { body } = await deps.storage.get(master.storageKey);
  await pipeline(body, createWriteStream(path));
  // A short download is the network's fault: retried.
  if ((await stat(path)).size !== master.sizeBytes) {
    throw new Error('short download of the previous build');
  }
  return { path, seconds: (recording.durationMs ?? 0) / 1000 };
}

/**
 * The recording's date for its tags and file name: the station's local date of its first
 * part (a show at 00:30 in Lyon is that day's, not the day before in UTC).
 */
export function recordingDate(startedAt: Date, timezone: string): string {
  return localDateOf(startedAt, timezone);
}

/**
 * An asset a build made or replaced: deleted, unless the recording or the episode still use
 * it, or the log still plans it (a rerun of it).
 */
async function dropIfUnused(deps: LiveRecordingDeps, ctx: StationContext, assetId: string) {
  try {
    if (await liveRecordingAssetInUse(deps.db, ctx.scope, assetId)) return;
    await deleteAsset(deps.db, ctx, assetId);
  } catch (err) {
    deps.log?.({
      level: 'warn',
      msg: 'live recording asset kept',
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

/** The file's size, or null when it isn't there. */
async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

const fileTitle = (title: string | null) =>
  (title ?? 'Live')
    .replaceAll(/[/\\:*?"<>|]+/g, ' ')
    .trim()
    .slice(0, 120) || 'Live';
