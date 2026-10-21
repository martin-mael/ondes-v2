import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  type Db,
  listAssetFiles,
  NotFoundError,
  putAssetFile,
  resolveStationScope,
  StaleMeasurementError,
  type StationContext,
} from '@ondes/db';
import {
  encodePeaks,
  PEAKS_CODEC,
  PEAKS_LEVELS,
  PEAKS_MIME_TYPE,
  type PeaksJobPayload,
  peaksStorageKey,
} from '@ondes/shared';
import type { Storage } from '@ondes/storage';
import { isFileError, readFlacStreamInfo, type Tools } from '../ingest/ffmpeg.ts';
import { finishPeaks, PeaksAccumulator } from './compute.ts';
import { decodePcm16 } from './decode.ts';

// Waveform peaks (#22): decodes an asset's playout copy once, computes min/max peaks per
// channel at every level of `PEAKS_LEVELS` (compute.ts), stores the peaks file (format in
// packages/shared/src/contracts/peaks.ts) under `peaksStorageKey(orgId, playoutSha256)`, and
// records it as the asset's `peaks` file.
//
// Idempotent: the job is keyed by asset, playout hash and format version, and the object key
// is a function of the playout hash and format version, so a retry, or another asset with the
// same playout copy, finds the object already stored and only records it. A job whose asset is
// gone, or whose playout copy was replaced (before or during the work), records nothing. Like
// loudness, only ffmpeg rejecting the file is final (logged, nothing stored); S3, Postgres and
// a killed or timed-out ffmpeg throw and are retried.

export const PEAKS_ACTOR = { type: 'system', name: 'peaks' } as const;

export interface PeaksDeps {
  db: Db;
  storage: Storage;
  tools: Tools;
  /** Scratch space for downloads. Default: the OS temp dir. */
  tmpDir?: string;
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * `stored`: recorded now (computed, or found in storage); `current`: already recorded;
 * `stale`: asset or station gone, or playout copy replaced; `unreadable`: ffmpeg rejected it.
 */
export type PeaksOutcome = 'stored' | 'current' | 'stale' | 'unreadable';

interface StoredPeaks {
  sha256: string;
  sizeBytes: number;
  sampleRate: number;
  channels: number;
  lengthSamples: number;
}

export async function generateAssetPeaks(
  deps: PeaksDeps,
  payload: PeaksJobPayload,
  run: { signal?: AbortSignal } = {},
): Promise<PeaksOutcome> {
  try {
    const scope = await resolveStationScope(deps.db, payload.orgId, payload.stationId);
    const ctx: StationContext = { actor: PEAKS_ACTOR, scope };
    const files = await listAssetFiles(deps.db, scope, payload.assetId);
    const playout = files.find((file) => file.role === 'playout');
    // Asset deleted, or its playout copy replaced (that one has its own job).
    if (!playout || playout.sha256 !== payload.playoutSha256) return 'stale';
    const key = peaksStorageKey(scope.orgId, playout.sha256);
    if (files.some((file) => file.role === 'peaks' && file.storageKey === key)) return 'current';

    const stored =
      (await findStored(deps.storage, key)) ?? (await compute(deps, key, playout, run));
    if (!stored) return 'unreadable';
    // Recorded only if this file is still the asset's playout copy (checked under its lock).
    await putAssetFile(
      deps.db,
      ctx,
      payload.assetId,
      {
        role: 'peaks',
        storageKey: key,
        sha256: stored.sha256,
        sizeBytes: stored.sizeBytes,
        codec: PEAKS_CODEC,
        mimeType: PEAKS_MIME_TYPE,
        sampleRate: stored.sampleRate,
        channels: stored.channels,
        durationSamples: stored.lengthSamples,
      },
      { ifPlayoutSha256: payload.playoutSha256 },
    );
    return 'stored';
  } catch (error) {
    // The station or asset was deleted, or the playout copy replaced, while we worked.
    if (error instanceof NotFoundError || error instanceof StaleMeasurementError) return 'stale';
    throw error;
  }
}

/** The object at `key`, when a previous run (or another asset) stored it. */
async function findStored(storage: Storage, key: string): Promise<StoredPeaks | undefined> {
  const head = await storage.head(key);
  if (!head) return undefined;
  const meta = head.metadata;
  const numbers = [meta['sample-rate'], meta.channels, meta['length-samples']].map(Number);
  const [sampleRate, channels, lengthSamples] = numbers;
  if (
    !/^[0-9a-f]{64}$/.test(meta.sha256 ?? '') ||
    sampleRate === undefined ||
    channels === undefined ||
    lengthSamples === undefined ||
    !numbers.every(Number.isSafeInteger)
  ) {
    return undefined; // Not ours, or written without metadata: rewrite it.
  }
  return {
    sha256: meta.sha256 as string,
    sizeBytes: head.size,
    sampleRate,
    channels,
    lengthSamples,
  };
}

async function compute(
  deps: PeaksDeps,
  key: string,
  playout: { storageKey: string; durationSamples: number | null },
  run: { signal?: AbortSignal },
): Promise<StoredPeaks | undefined> {
  const work = await mkdtemp(join(deps.tmpDir ?? tmpdir(), 'ondes-peaks-'));
  try {
    const path = join(work, 'playout.flac');
    const { body } = await deps.storage.get(playout.storageKey);
    await pipeline(body, createWriteStream(path));
    let info: Awaited<ReturnType<typeof readFlacStreamInfo>>;
    try {
      // The file's own STREAMINFO, not the database's copy of it: channels decide the layout.
      info = await readFlacStreamInfo(path);
    } catch (error) {
      // A file system error has a code; a parse error means the file isn't the FLAC we wrote.
      if ((error as NodeJS.ErrnoException).code) throw error;
      return unreadable(deps, playout.storageKey, (error as Error).message);
    }
    const accumulator = new PeaksAccumulator(
      info.channels,
      Math.min(...PEAKS_LEVELS),
      playout.durationSamples ?? info.totalSamples,
    );
    try {
      await decodePcm16(deps.tools, path, {
        channels: info.channels,
        onSamples: (samples) => accumulator.push(samples),
        signal: run.signal,
        durationSeconds: info.totalSamples ? info.totalSamples / info.sampleRate : undefined,
      });
    } catch (error) {
      if (!isFileError(error)) throw error;
      return unreadable(deps, playout.storageKey, error.stderr || error.message);
    }
    const peaks = finishPeaks(accumulator, info.sampleRate);
    const bytes = encodePeaks(peaks);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await deps.storage.put(key, bytes, {
      contentType: PEAKS_MIME_TYPE,
      metadata: {
        sha256,
        'sample-rate': String(peaks.sampleRate),
        channels: String(peaks.channels),
        'length-samples': String(peaks.lengthSamples),
      },
    });
    return {
      sha256,
      sizeBytes: bytes.length,
      sampleRate: peaks.sampleRate,
      channels: peaks.channels,
      lengthSamples: peaks.lengthSamples,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function unreadable(deps: PeaksDeps, key: string, err: string): undefined {
  deps.log?.({ level: 'warn', msg: 'peaks: playout copy not decodable', key, err });
  return undefined;
}
