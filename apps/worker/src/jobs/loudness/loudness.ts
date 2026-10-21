import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  type Db,
  listAssetFiles,
  NotFoundError,
  resolveStationScope,
  StaleMeasurementError,
  type StationContext,
  setLoudness,
} from '@ondes/db';
import { LOUDNESS_ANALYZER, type LoudnessJobPayload } from '@ondes/shared';
import type { Storage } from '@ondes/storage';
import { announce, assetUpdatedEvent, type PublishEvent } from '../_events/asset-updated.ts';
import { isFileError, type Tools } from '../ingest/ffmpeg.ts';
import { Ebur128ParseError, ffmpegVersion, measureLoudness } from './ebur128.ts';

// Loudness (#19): measures an asset's playout copy (the file the engine plays) with ffmpeg's
// ebur128 and stores integrated loudness, loudness range and true peak in `asset_loudness`.
// The playout gain is computed from it when needed (`getPlayoutGain` in @ondes/shared), never
// stored, so a new station target or an asset override applies at once.
//
// Idempotent: the job is keyed by asset and playout hash (`loudness:<assetId>:<sha256>`), and
// storing a measurement replaces the previous one. A job whose asset is gone, or whose
// playout copy was replaced (before or during the measurement), stores nothing. Like ingest,
// only a tool that ran and rejected the file is final (logged, nothing stored); S3, Postgres,
// a killed or timed-out ffmpeg, output we can't parse and shutdowns throw and are retried.

export const LOUDNESS_ACTOR = { type: 'system', name: 'loudness' } as const;

/** Bump when the measurement changes (filter options, channel handling), to re-measure. */
export const LOUDNESS_METHOD_VERSION = '1';

export interface LoudnessDeps {
  db: Db;
  storage: Storage;
  tools: Tools;
  /** Scratch space for downloads. Default: the OS temp dir. */
  tmpDir?: string;
  log?: (entry: Record<string, unknown>) => void;
  /** Publishes `asset.updated` once a measurement is stored (#55). */
  publish?: PublishEvent;
}

export type LoudnessOutcome = 'measured' | 'stale' | 'unmeasurable';

export async function measureAssetLoudness(
  deps: LoudnessDeps,
  payload: LoudnessJobPayload,
  run: { signal?: AbortSignal } = {},
): Promise<LoudnessOutcome> {
  try {
    const scope = await resolveStationScope(deps.db, payload.orgId, payload.stationId);
    const ctx: StationContext = { actor: LOUDNESS_ACTOR, scope };
    const playout = (await listAssetFiles(deps.db, scope, payload.assetId)).find(
      (file) => file.role === 'playout',
    );
    // Asset deleted, or its playout copy replaced (that one has its own job).
    if (!playout || playout.sha256 !== payload.playoutSha256) return 'stale';

    const work = await mkdtemp(join(deps.tmpDir ?? tmpdir(), 'ondes-loudness-'));
    try {
      const path = join(work, 'playout.flac');
      const { body } = await deps.storage.get(playout.storageKey);
      await pipeline(body, createWriteStream(path));
      const durationSeconds =
        playout.durationSamples && playout.sampleRate
          ? playout.durationSamples / playout.sampleRate
          : undefined;
      let result: Awaited<ReturnType<typeof measureLoudness>>;
      try {
        result = await measureLoudness(deps.tools, path, {
          channels: playout.channels,
          durationSeconds,
          signal: run.signal,
        });
      } catch (error) {
        if (error instanceof Ebur128ParseError) {
          // Not the file: ffmpeg's output changed. Loud, and retried (then the DLQ).
          deps.log?.({
            level: 'error',
            msg: 'loudness: unreadable ebur128 output',
            assetId: payload.assetId,
            err: error.message,
          });
        }
        if (!isFileError(error)) throw error;
        deps.log?.({
          level: 'warn',
          msg: 'loudness: file not measurable',
          assetId: payload.assetId,
          err: error.stderr || error.message,
        });
        return 'unmeasurable';
      }
      // Stored only if this file is still the asset's playout copy (checked under its lock):
      // a slow job measuring a replaced file never overwrites the newer measurement.
      await setLoudness(deps.db, ctx, payload.assetId, {
        ...result,
        playoutSha256: payload.playoutSha256,
        analyzer: LOUDNESS_ANALYZER,
        analyzerVersion: `${LOUDNESS_METHOD_VERSION}/ffmpeg ${await ffmpegVersion(deps.tools)}`,
      });
      await announce(
        deps.publish,
        assetUpdatedEvent(payload.stationId, payload.assetId, ['loudness']),
        deps.log,
      );
      return 'measured';
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  } catch (error) {
    // The station or asset was deleted, or the playout copy replaced, while we worked.
    if (error instanceof NotFoundError || error instanceof StaleMeasurementError) return 'stale';
    throw error;
  }
}
