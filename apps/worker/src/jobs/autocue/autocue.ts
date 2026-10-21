import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  type Db,
  getCues,
  getStationEngineSettings,
  LibraryConflictError,
  listAssetFiles,
  NotFoundError,
  resolveStationScope,
  type StationContext,
  setAutoCues,
} from '@ondes/db';
import {
  type AssetCues,
  AUTOCUE_ALGORITHM_VERSION,
  type AutocueJobPayload,
  type AutocueSettings,
  autocueSettingsOf,
  type CueField,
  DEFAULT_AUTOCUE_SETTINGS,
  stableStringify,
} from '@ondes/shared';
import type { Storage } from '@ondes/storage';
import { announce, assetUpdatedEvent, type PublishEvent } from '../_events/asset-updated.ts';
import { isFileError, type Tools } from '../ingest/ffmpeg.ts';
import { type DetectedCues, detectCues, type FixedCues } from './detect.ts';
import { analyseFile } from './frames.ts';

// Autocue (#20): cue points for an asset's playout copy.
//
//   1. the playout copy the job was enqueued for (an asset deleted or re-encoded since: done)
//   2. the station's thresholds → the analyzer version
//   3. one ffmpeg pass for the frame loudness (frames.ts), then the detector (detect.ts),
//      fitted inside any cue-in/cue-out a person set or locked
//   4. `setAutoCues`, which leaves manual and locked points alone
//
// Idempotent: the result only depends on the file and the analyzer version, and storing it
// twice changes nothing. A playout copy ffmpeg can't decode gets an empty result (the engine
// uses its defaults) rather than a retry loop: the backfill would enqueue it again forever.

export const AUTOCUE_ACTOR = { type: 'system', name: 'autocue' } as const;

export interface AutocueDeps {
  db: Db;
  storage: Storage;
  tools: Tools;
  /** Scratch space for the download. Default: the OS temp dir. */
  tmpDir?: string;
  log?(entry: Record<string, unknown>): void;
  /** Publishes `asset.updated` once cues are stored (#55). */
  publish?: PublishEvent;
}

export interface AutocueRun {
  signal?: AbortSignal;
}

/**
 * Version stored with the results: the algorithm, plus a hash of the thresholds when they
 * aren't the defaults (`autocue/1`, `autocue/1+3fa9c1d2`). A new version re-analyses.
 */
export function autocueAnalyzerVersion(settings: AutocueSettings): string {
  const base = `autocue/${AUTOCUE_ALGORITHM_VERSION}`;
  const json = stableStringify(settings);
  if (json === stableStringify(DEFAULT_AUTOCUE_SETTINGS)) return base;
  return `${base}+${createHash('sha256').update(json).digest('hex').slice(0, 8)}`;
}

/** A station's thresholds; invalid ones fall back to their defaults, with a warning. */
export function stationAutocueSettings(
  engineSettings: Record<string, unknown>,
  stationId: string,
  log: (entry: Record<string, unknown>) => void = (entry) => console.log(JSON.stringify(entry)),
): AutocueSettings {
  return autocueSettingsOf(engineSettings, (keys) =>
    log({
      level: 'warn',
      msg: 'autocue: invalid station thresholds, using their defaults',
      stationId,
      keys,
    }),
  );
}

export async function autocue(
  deps: AutocueDeps,
  payload: AutocueJobPayload,
  run: AutocueRun = {},
): Promise<AssetCues | null> {
  const log = deps.log ?? (() => {});
  let scope: StationContext['scope'];
  try {
    scope = await resolveStationScope(deps.db, payload.orgId, payload.stationId);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
  const ctx: StationContext = { actor: AUTOCUE_ACTOR, scope };

  // 1. The playout copy.
  const files = await listAssetFiles(deps.db, scope, payload.assetId);
  const playout = files.find((f) => f.role === 'playout');
  if (!playout || playout.sha256 !== payload.playoutSha256) return null;
  const sampleRate = playout.sampleRate;
  // The schema requires it for playout copies; without it no cue can be stored at all.
  if (!sampleRate) {
    log({
      level: 'warn',
      msg: 'autocue: playout copy has no sample rate',
      assetId: payload.assetId,
    });
    return null;
  }

  // 2. Thresholds, read now: they may have changed since the job was enqueued.
  const settings = stationAutocueSettings(
    await getStationEngineSettings(deps.db, scope),
    scope.stationId,
    log,
  );
  const analyzerVersion = autocueAnalyzerVersion(settings);
  const existing = await getCues(deps.db, scope, payload.assetId);
  if (existing?.analyzerVersion === analyzerVersion) return existing;

  /**
   * Stores the result. `null`: the file can't be measured; only the version that tried is
   * stored (the engine uses its defaults), so the backfill doesn't enqueue it forever.
   */
  const store = async (detected: DetectedCues | null, reason?: string) => {
    const points: Partial<Record<CueField, number | null>> = detected
      ? {
          cueIn: detected.cueIn,
          cueOut: detected.cueOut,
          introEnd: detected.introEnd,
          outroStart: detected.outroStart,
          fadeIn: detected.fadeIn,
          fadeOut: detected.fadeOut,
          crossStartNext: detected.crossStartNext,
        }
      : {};
    try {
      const cues = await setAutoCues(deps.db, ctx, payload.assetId, {
        sampleRate,
        analyzerVersion,
        points,
      });
      log({
        level: 'info',
        msg: 'autocue',
        assetId: payload.assetId,
        analyzerVersion,
        ...(detected ? { points, flags: detected.flags } : { unmeasurable: reason }),
      });
      await announce(
        deps.publish,
        assetUpdatedEvent(scope.stationId, payload.assetId, ['cues']),
        log,
      );
      return cues;
    } catch (error) {
      // Deleted while we listened.
      if (error instanceof NotFoundError) return null;
      // The stored cues contradict this result (another sample rate): retrying gives the same.
      if (error instanceof LibraryConflictError) {
        log({
          level: 'warn',
          msg: 'autocue: result conflicts with the stored cues',
          assetId: payload.assetId,
          err: error.message,
        });
        return null;
      }
      throw error;
    }
  };
  if (!playout.durationSamples) return store(null, 'no length');

  // 3. Analysis.
  let detected: DetectedCues | null = null;
  const work = await mkdtemp(join(deps.tmpDir ?? tmpdir(), 'ondes-autocue-'));
  try {
    const path = join(work, 'playout.flac');
    const { body } = await deps.storage.get(playout.storageKey);
    await pipeline(body, createWriteStream(path));
    const series = await analyseFile(
      deps.tools,
      path,
      { sampleRate, totalSamples: playout.durationSamples },
      { signal: run.signal },
    ).catch((error: unknown) => {
      if (!isFileError(error)) throw error;
      log({
        level: 'warn',
        msg: 'autocue: playout copy unreadable',
        assetId: payload.assetId,
        err: error.stderr,
      });
      return null;
    });
    if (series) detected = detectCues(series, settings, fixedCues(existing));
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  // 4. Store.
  return store(detected, detected ? undefined : 'unreadable');
}

/** Cue-in and cue-out a person set or locked: the other points must fit inside them. */
function fixedCues(cues: AssetCues | null): FixedCues {
  if (!cues) return {};
  const keep = (point: AssetCues['cueIn']) =>
    (point.locked || point.source === 'manual') && point.samples !== null
      ? point.samples
      : undefined;
  return { cueIn: keep(cues.cueIn), cueOut: keep(cues.cueOut) };
}
