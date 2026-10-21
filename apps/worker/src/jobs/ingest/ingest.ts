import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  claimUploadContent,
  createAsset,
  createPostgresQuotaStore,
  type Db,
  getUpload,
  listAssetFiles,
  putAssetFile,
  resolveStationScope,
  type StationContext,
  setAssetTags,
  setUploadAsset,
  toUpload,
  transitionUpload,
  type UploadRecord,
  unreferencedKeys,
  uploadError,
} from '@ondes/db';
import {
  type AssetFile,
  type IngestedFile,
  type IngestJobPayload,
  PLAYOUT_FLAC_BLOCK_SIZE,
  PLAYOUT_SAMPLE_RATE,
  type RealtimeEvent,
  type UploadErrorCode,
} from '@ondes/shared';
import { assertQuota, contentKey, QuotaExceededError, type Storage } from '@ondes/storage';
import {
  audioStream,
  bitDepth,
  durationSamples,
  ffprobe,
  type ProbeResult,
  readFlacStreamInfo,
  ToolError,
  type Tools,
  transcodePlayout,
} from './ffmpeg.ts';
import { readTags } from './tags.ts';

// Ingest (#18): one uploaded file → one asset with a master and a playout file.
//
//   1. ffprobe validation (an audio stream, readable)  → else `quarantined`
//   2. SHA-256 of the uploaded bytes (while downloading them)
//   3. dedupe in the station on that hash               → `duplicate`, reported
//   4. playout copy: FLAC 44.1 kHz, 1024-sample blocks (spike #12); the master is the
//      original as uploaded
//   5. tags (ID3/Vorbis/…) into the asset
//   6. `putAssetFile` for both files (charges the content keys), then make sure each object
//      exists in the bucket and upload it if not (charge first, then ensure: a key released
//      and swept just before the charge must be uploaded again)
//   7. `asset.ingested`
//
// Idempotent: the upload row records progress (status, sha256, assetId) and every write is
// keyed by content, so a retried or redelivered job resumes or does nothing. Broken files are
// quarantined (no retry); infrastructure errors throw and are retried by the queue, and mark
// the upload `failed` on the last attempt.

export const INGEST_ACTOR = { type: 'system', name: 'ingest' } as const;

export interface IngestDeps {
  db: Db;
  storage: Storage;
  tools: Tools;
  publish(event: RealtimeEvent): Promise<void>;
  /** Scratch space for downloads and transcodes. Default: the OS temp dir. */
  tmpDir?: string;
}

export interface IngestRun {
  attempt: number;
  isLastAttempt: boolean;
  signal?: AbortSignal;
}

/** A file that can't be ingested as it is: quarantine it, don't retry. */
export class QuarantineError extends Error {
  readonly code: UploadErrorCode;

  constructor(code: UploadErrorCode, message: string) {
    super(message);
    this.name = 'QuarantineError';
    this.code = code;
  }
}

/** Another upload of the same file is being ingested: try again once it's done. */
export class ContentBusyError extends Error {
  override name = 'ContentBusyError';
}

/** Upload error codes that are final but not a broken file. */
const FAILED_CODES: readonly UploadErrorCode[] = ['quota_exceeded'];

const MASTER_EXTENSIONS: Record<string, string> = {
  wav: 'wav',
  w64: 'w64',
  mp3: 'mp3',
  flac: 'flac',
  ogg: 'ogg',
  aiff: 'aiff',
  'mov,mp4,m4a,3gp,3g2,mj2': 'm4a',
  'matroska,webm': 'mka',
  wv: 'wv',
  ape: 'ape',
  caf: 'caf',
  au: 'au',
};

const MIME_TYPES: Record<string, string> = {
  wav: 'audio/wav',
  w64: 'audio/x-w64',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  aiff: 'audio/aiff',
  m4a: 'audio/mp4',
  mka: 'audio/x-matroska',
  wv: 'audio/x-wavpack',
};

function masterExtension(probe: ProbeResult, filename: string): string {
  const format = probe.format?.format_name;
  if (format && MASTER_EXTENSIONS[format]) return MASTER_EXTENSIONS[format];
  const ext = filename.match(/\.([A-Za-z0-9]{1,10})$/)?.[1]?.toLowerCase();
  return ext ?? 'bin';
}

export async function ingest(
  deps: IngestDeps,
  payload: IngestJobPayload,
  run: IngestRun,
): Promise<void> {
  const scope = await resolveStationScope(deps.db, payload.orgId, payload.stationId);
  const ctx: StationContext = { actor: INGEST_ACTOR, scope };
  let row = await getUpload(deps.db, scope, payload.uploadId);

  switch (row.status) {
    case 'uploading':
    case 'aborted':
    case 'duplicate':
    case 'quarantined':
    case 'failed':
      return;
    case 'ingested':
      // An earlier attempt committed but didn't get the event out.
      await publishIngested(deps, ctx, row);
      return;
    case 'queued':
      row = await transitionUpload(deps.db, ctx, row.id, ['queued'], { status: 'processing' });
      await publishUpload(deps, row);
      break;
    case 'processing':
      break;
  }

  const work = await mkdtemp(join(deps.tmpDir ?? tmpdir(), 'ondes-ingest-'));
  try {
    await runIngest(deps, ctx, row, work, run);
  } catch (error) {
    if (error instanceof QuarantineError) {
      const status = FAILED_CODES.includes(error.code) ? 'failed' : 'quarantined';
      const done = await transitionUpload(deps.db, ctx, row.id, ['processing'], {
        status,
        ...uploadError(error.code, error.message),
      });
      await publishUpload(deps, done);
      return;
    }
    if (run.isLastAttempt) {
      const done = await transitionUpload(deps.db, ctx, row.id, ['processing'], {
        status: 'failed',
        ...uploadError('internal', error instanceof Error ? error.message : String(error)),
      }).catch(() => null);
      if (done) await publishUpload(deps, done).catch(() => {});
    }
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function runIngest(
  deps: IngestDeps,
  ctx: StationContext,
  row: UploadRecord,
  work: string,
  run: IngestRun,
): Promise<void> {
  const { db, storage } = deps;
  const orgId = ctx.scope.orgId;

  // 1–2. Download (hashing on the way), then probe.
  const sourcePath = join(work, 'source');
  const source = await download(storage, row.stagingKey, sourcePath);
  const probe = await ffprobe(deps.tools, sourcePath, run.signal).catch((error: unknown) => {
    throw new QuarantineError('probe_failed', toolMessage(error));
  });
  const stream = audioStream(probe);
  if (!stream) throw new QuarantineError('not_audio', 'no audio stream in the file');
  if (!stream.sample_rate) throw new QuarantineError('probe_failed', 'unknown sample rate');

  // 3. Dedupe within the station.
  const claim = await claimUploadContent(db, ctx, row.id, source.sha256);
  if (claim.kind === 'busy') {
    throw new ContentBusyError(`the same file is being ingested by upload ${claim.uploadId}`);
  }
  if (claim.kind === 'duplicate') {
    const done = await transitionUpload(db, ctx, row.id, ['processing'], {
      status: 'duplicate',
      sha256: source.sha256,
      duplicateOfAssetId: claim.assetId,
      error: `same file as asset ${claim.assetId}`,
    });
    await deleteStaging(storage, row.stagingKey);
    await publishUpload(deps, done);
    return;
  }

  // 4. Playout copy.
  const playoutPath = join(work, 'playout.flac');
  await transcodePlayout(deps.tools, sourcePath, playoutPath, stream, run.signal).catch(
    (error: unknown) => {
      if (run.signal?.aborted) throw error;
      throw new QuarantineError('transcode_failed', toolMessage(error));
    },
  );
  const info = await readFlacStreamInfo(playoutPath);
  if (
    info.minBlockSize !== PLAYOUT_FLAC_BLOCK_SIZE ||
    info.maxBlockSize !== PLAYOUT_FLAC_BLOCK_SIZE ||
    info.sampleRate !== PLAYOUT_SAMPLE_RATE
  ) {
    // An ffmpeg that ignores -frame_size would break island splices: never store that.
    throw new Error(
      `playout encoding is ${info.minBlockSize}-${info.maxBlockSize} samples at ${info.sampleRate} Hz`,
    );
  }
  if (info.totalSamples === 0) throw new QuarantineError('empty', 'the file has no audio samples');
  const playout = await hashFile(playoutPath);

  const masterExt = masterExtension(probe, row.filename);
  const masterKey = contentKey({ orgId, sha256: source.sha256, ext: masterExt });
  const playoutKey = contentKey({ orgId, sha256: playout.sha256, ext: 'flac' });

  // Quota: only bytes of objects the org doesn't hold yet count.
  const sizes = new Map([
    [masterKey, source.sizeBytes],
    [playoutKey, playout.sizeBytes],
  ]);
  const newKeys = await unreferencedKeys(db, orgId, [...sizes.keys()]);
  try {
    await assertQuota(
      createPostgresQuotaStore(db),
      orgId,
      newKeys.reduce((sum, key) => sum + (sizes.get(key) ?? 0), 0),
    );
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      throw new QuarantineError('quota_exceeded', error.message);
    }
    throw error;
  }

  // 5. The asset, created once: its id is stored on the upload in the same transaction.
  const read = readTags(probe, stream, row.filename);
  let assetId = row.assetId;
  if (!assetId) {
    assetId = await db.transaction(async (tx) => {
      const asset = await createAsset(tx, ctx, {
        ...read.asset,
        type: row.assetType,
        durationMs: Math.round((info.totalSamples / PLAYOUT_SAMPLE_RATE) * 1000),
      });
      if (read.tags.length) await setAssetTags(tx, ctx, asset.id, { tags: read.tags });
      await setUploadAsset(tx, ctx.scope, row.id, asset.id);
      return asset.id;
    });
  }

  // 6. Charge both keys, then make sure the objects are there.
  const lossless = bitDepth(stream) !== null;
  await putAssetFile(db, ctx, assetId, {
    role: 'master',
    storageKey: masterKey,
    sha256: source.sha256,
    sizeBytes: source.sizeBytes,
    codec: stream.codec_name ?? 'unknown',
    mimeType: MIME_TYPES[masterExt] ?? row.contentType,
    sampleRate: stream.sample_rate,
    channels: stream.channels ?? null,
    bitDepth: lossless ? bitDepth(stream) : null,
    durationSamples: durationSamples(stream, probe),
  });
  await putAssetFile(db, ctx, assetId, {
    role: 'playout',
    storageKey: playoutKey,
    sha256: playout.sha256,
    sizeBytes: playout.sizeBytes,
    codec: 'flac',
    mimeType: 'audio/flac',
    sampleRate: info.sampleRate,
    channels: info.channels,
    bitDepth: info.bitsPerSample,
    durationSamples: info.totalSamples,
    flacBlockSize: info.minBlockSize,
  });
  await ensureObject(storage, masterKey, sourcePath, source.sizeBytes, MIME_TYPES[masterExt]);
  await ensureObject(storage, playoutKey, playoutPath, playout.sizeBytes, 'audio/flac');

  // 7. Done.
  const done = await transitionUpload(db, ctx, row.id, ['processing'], {
    status: 'ingested',
    sha256: source.sha256,
    assetId,
    errorCode: null,
    error: null,
  });
  await deleteStaging(storage, row.stagingKey);
  await publishIngested(deps, ctx, done);
}

async function download(storage: Storage, key: string, path: string) {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const { body } = await storage.get(key);
  await pipeline(
    body,
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        yield chunk;
      }
    },
    createWriteStream(path),
  );
  return { sha256: hash.digest('hex'), sizeBytes };
}

async function hashFile(path: string) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return { sha256: hash.digest('hex'), sizeBytes: (await stat(path)).size };
}

/** Uploads the object unless the bucket already has it (same content key, same size). */
async function ensureObject(
  storage: Storage,
  key: string,
  path: string,
  sizeBytes: number,
  contentType: string | undefined,
): Promise<void> {
  const existing = await storage.head(key);
  if (existing && existing.size === sizeBytes) return;
  await storage.put(key, createReadStream(path), { contentLength: sizeBytes, contentType });
}

/** The staging object is ours alone (not content-addressed). A leftover is only clutter. */
async function deleteStaging(storage: Storage, key: string): Promise<void> {
  await storage.delete(key).catch((error: unknown) => {
    console.error(
      JSON.stringify({ level: 'warn', msg: 'staging delete failed', key, err: String(error) }),
    );
  });
}

function toolMessage(error: unknown): string {
  if (error instanceof ToolError) return error.stderr || error.message;
  return error instanceof Error ? error.message : String(error);
}

function fileRef(file: AssetFile): IngestedFile {
  return {
    fileId: file.id,
    storageKey: file.storageKey,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
    codec: file.codec,
    sampleRate: file.sampleRate,
    channels: file.channels,
    durationSamples: file.durationSamples,
    flacBlockSize: file.flacBlockSize,
  };
}

const envelope = (stationId: string) => ({
  id: randomUUID(),
  stationId,
  at: new Date().toISOString(),
});

async function publishUpload(deps: IngestDeps, row: UploadRecord): Promise<void> {
  const u = toUpload(row);
  await deps.publish({
    ...envelope(row.stationId),
    type: 'upload.updated',
    data: {
      id: u.id,
      status: u.status,
      filename: u.filename,
      assetId: u.assetId,
      duplicateOfAssetId: u.duplicateOfAssetId,
      errorCode: u.errorCode,
      error: u.error,
    },
  });
}

async function publishIngested(
  deps: IngestDeps,
  ctx: StationContext,
  row: UploadRecord,
): Promise<void> {
  if (!row.assetId) return;
  const files = await listAssetFiles(deps.db, ctx.scope, row.assetId);
  const master = files.find((f) => f.role === 'master');
  const playout = files.find((f) => f.role === 'playout');
  // The asset was deleted since: nothing to analyse.
  if (!master || !playout) return;
  await deps.publish({
    ...envelope(row.stationId),
    type: 'asset.ingested',
    data: {
      orgId: row.orgId,
      assetId: row.assetId,
      uploadId: row.id,
      master: fileRef(master),
      playout: fileRef(playout),
    },
  });
  await publishUpload(deps, row);
}
