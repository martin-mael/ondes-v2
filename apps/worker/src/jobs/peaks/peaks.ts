import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
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
  sha256HexSchema,
} from '@ondes/shared';
import type { Storage } from '@ondes/storage';
import { z } from 'zod';
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
// gone, or whose playout copy was replaced (before or during the work), records and writes
// nothing. Like ingest, the reference is charged before the object is written, and the object
// is checked (or rewritten) after: a recorded peaks file whose object went missing is restored
// by the next run (the api enqueues one, `peaksRepairIdempotencyKey`). Like loudness, only a
// playout copy that isn't decodable FLAC is final (logged, nothing stored); S3, Postgres, a
// short download and a killed or timed-out ffmpeg throw and are retried.

export const PEAKS_ACTOR = { type: 'system', name: 'peaks' } as const;

export interface PeaksDeps {
  db: Db;
  storage: Storage;
  tools: Tools;
  /** Scratch space for downloads. Default: the OS temp dir. */
  tmpDir?: string;
  log?: (entry: Record<string, unknown>) => void;
  /** Test seam: runs once the peaks are computed (or found), before they're recorded. */
  beforeRecord?: () => Promise<void>;
}

/**
 * `stored`: recorded now (computed, or found in storage), or a missing object restored;
 * `current`: already recorded and stored; `stale`: asset or station gone, or playout copy
 * replaced; `unreadable`: the playout copy isn't a FLAC ffmpeg can decode.
 */
export type PeaksOutcome = 'stored' | 'current' | 'stale' | 'unreadable';

interface PeaksMeta {
  sha256: string;
  sizeBytes: number;
  sampleRate: number;
  channels: number;
  lengthSamples: number;
}

interface ComputedPeaks {
  bytes: Uint8Array;
  meta: PeaksMeta;
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
    const recorded = files.find((file) => file.role === 'peaks' && file.storageKey === key);
    const found = await findStored(deps.storage, key);
    if (recorded && found) return 'current';

    // Nothing is written to the bucket until the asset holds a reference to the key (the
    // ingest rule): an object written for a job that then turns out stale would be charged
    // to no one and never deleted.
    let computed: ComputedPeaks | undefined;
    let meta = found;
    if (!meta) {
      computed = await compute(deps, playout, run);
      if (!computed) return 'unreadable';
      meta = computed.meta;
    }
    await deps.beforeRecord?.();
    if (!recorded || recorded.sha256 !== meta.sha256 || recorded.sizeBytes !== meta.sizeBytes) {
      // Charges the reference (and cancels a pending bucket delete of the key), only if this
      // file is still the asset's playout copy, checked under the asset's lock.
      await putAssetFile(
        deps.db,
        ctx,
        payload.assetId,
        {
          role: 'peaks',
          storageKey: key,
          sha256: meta.sha256,
          sizeBytes: meta.sizeBytes,
          codec: PEAKS_CODEC,
          mimeType: PEAKS_MIME_TYPE,
          sampleRate: meta.sampleRate,
          channels: meta.channels,
          durationSamples: meta.lengthSamples,
        },
        { ifPlayoutSha256: payload.playoutSha256 },
      );
    }
    // Referenced now, so no sweep deletes it from here on. Make sure it exists: the object
    // `head` found may have been swept before the reference was charged.
    if (!computed && !(await findStored(deps.storage, key))) {
      computed = await compute(deps, playout, run);
      if (!computed) return 'unreadable';
    }
    if (computed) await putPeaks(deps.storage, key, computed);
    return 'stored';
  } catch (error) {
    // The station or asset was deleted, or the playout copy replaced, while we worked.
    if (error instanceof NotFoundError || error instanceof StaleMeasurementError) return 'stale';
    throw error;
  }
}

/** Metadata the job writes on each peaks object, so a later run can record it unread. */
const objectMetadataSchema = z.object({
  sha256: sha256HexSchema,
  'sample-rate': z
    .string()
    .regex(/^[1-9][0-9]{0,8}$/)
    .transform(Number),
  channels: z
    .string()
    .regex(/^[1-8]$/)
    .transform(Number),
  'length-samples': z
    .string()
    .regex(/^(0|[1-9][0-9]{0,14})$/)
    .transform(Number),
});

/** The object at `key`, when a previous run (or another asset) stored it. */
async function findStored(storage: Storage, key: string): Promise<PeaksMeta | undefined> {
  const head = await storage.head(key);
  if (!head) return undefined;
  const parsed = objectMetadataSchema.safeParse(head.metadata);
  // Written without our metadata (or by something else): recompute and overwrite it.
  if (!parsed.success) return undefined;
  const meta = parsed.data;
  return {
    sha256: meta.sha256,
    sizeBytes: head.size,
    sampleRate: meta['sample-rate'],
    channels: meta.channels,
    lengthSamples: meta['length-samples'],
  };
}

async function putPeaks(storage: Storage, key: string, { bytes, meta }: ComputedPeaks) {
  await storage.put(key, bytes, {
    contentType: PEAKS_MIME_TYPE,
    metadata: {
      sha256: meta.sha256,
      'sample-rate': String(meta.sampleRate),
      channels: String(meta.channels),
      'length-samples': String(meta.lengthSamples),
    },
  });
}

/** Errors `parseFlacStreamInfo` throws for a file that isn't a FLAC stream: final. */
const FLAC_FORMAT_ERRORS = [/^not a FLAC stream$/, /^first FLAC metadata block is not STREAMINFO$/];

async function compute(
  deps: PeaksDeps,
  playout: { storageKey: string; sizeBytes: number; durationSamples: number | null },
  run: { signal?: AbortSignal },
): Promise<ComputedPeaks | undefined> {
  const work = await mkdtemp(join(deps.tmpDir ?? tmpdir(), 'ondes-peaks-'));
  try {
    const path = join(work, 'playout.flac');
    const { body } = await deps.storage.get(playout.storageKey);
    await pipeline(body, createWriteStream(path));
    // A short download is the network's fault, not the file's: retried.
    const { size } = await stat(path);
    if (size !== playout.sizeBytes) {
      throw new Error(`peaks: downloaded ${size} of ${playout.sizeBytes} bytes`);
    }
    let info: Awaited<ReturnType<typeof readFlacStreamInfo>>;
    try {
      // The file's own STREAMINFO, not the database's copy of it: channels decide the layout.
      info = await readFlacStreamInfo(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!FLAC_FORMAT_ERRORS.some((re) => re.test(message))) throw error;
      return unreadable(deps, playout.storageKey, message);
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
    return {
      bytes,
      meta: {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        sampleRate: peaks.sampleRate,
        channels: peaks.channels,
        lengthSamples: peaks.lengthSamples,
      },
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function unreadable(deps: PeaksDeps, key: string, err: string): undefined {
  deps.log?.({ level: 'warn', msg: 'peaks: playout copy not decodable', key, err });
  return undefined;
}
