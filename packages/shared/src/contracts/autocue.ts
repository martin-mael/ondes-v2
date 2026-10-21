import { z } from 'zod';
import { sha256HexSchema } from './library.ts';
import { uuidSchema } from './tenancy.ts';

// Autocue (#20): cue points detected on the playout copy, from loudness-relative thresholds.
//
//   asset.ingested ──▶ durable consumer (worker) ──▶ `autocue` job: ffmpeg ebur128 frames
//                      ──▶ detector (apps/worker/src/jobs/autocue/detect.ts) ──▶ setAutoCues
//
// Points a person set or locked are never overwritten (`setAutoCues`). Each result carries an
// analyzer version made of the algorithm version and the station's thresholds, so changing
// either re-analyses the station's assets (the worker's backfill).

// --- Station thresholds ------------------------------------------------------------------

/**
 * Per-station thresholds, stored under `station.engine_settings.autocue` (the engine template
 * ignores the key). Levels are in LU relative to the track's integrated loudness, like
 * Moonbase59's autocue, whose defaults these are (except `blankSkipSeconds`, off there).
 */
export const autocueSettingsSchema = z.object({
  /** Below this the track is silent: cue-in and cue-out. */
  silenceLu: z.number().min(-70).max(-10).default(-42),
  /** Below this the ending is quiet enough for the next track to start (`crossStartNext`). */
  overlayLu: z.number().min(-40).max(0).default(-8),
  /** An ending longer than this, from the overlay point to cue-out, is a long tail… */
  longTailSeconds: z.number().min(1).max(120).default(15),
  /** …whose overlay point is looked for this much lower again. */
  longTailExtraLu: z.number().min(-40).max(0).default(-12),
  /**
   * An ending whose second half is less than this much quieter (percent of LUFS) than its
   * first half is sustained (a held chord, not a fade): the next track starts later. 0: off.
   */
  sustainedDropPercent: z.number().min(0).max(100).default(40),
  /**
   * Silence in the middle of a track longer than this ends it there (hidden tracks after
   * minutes of silence). 0: off.
   */
  blankSkipSeconds: z.number().min(0).max(600).default(10),
  /** A quieter opening (or closing) part at least this long gets `introEnd` (`outroStart`). */
  minIntroSeconds: z.number().min(1).max(120).default(5),
});
export type AutocueSettings = z.infer<typeof autocueSettingsSchema>;
export const DEFAULT_AUTOCUE_SETTINGS: AutocueSettings = autocueSettingsSchema.parse({});

/**
 * Reads a station's thresholds from its engine settings. Each invalid threshold falls back to
 * its default on its own (the others still apply); `onInvalid` gets their names, so the caller
 * can say so (a fallback changes the analyzer version).
 */
export function autocueSettingsOf(
  engineSettings: Record<string, unknown>,
  onInvalid?: (keys: string[]) => void,
): AutocueSettings {
  const stored = engineSettings.autocue;
  if (stored === undefined) return DEFAULT_AUTOCUE_SETTINGS;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    onInvalid?.(['autocue']);
    return DEFAULT_AUTOCUE_SETTINGS;
  }
  const settings: Record<string, unknown> = { ...DEFAULT_AUTOCUE_SETTINGS };
  const invalid: string[] = [];
  const shape = autocueSettingsSchema.shape;
  for (const [key, value] of Object.entries(stored)) {
    const field = shape[key as keyof typeof shape];
    // Unknown keys (newer code) are ignored, not errors.
    if (!field) continue;
    const parsed = field.safeParse(value);
    if (parsed.success) settings[key] = parsed.data;
    else invalid.push(key);
  }
  if (invalid.length) onInvalid?.(invalid);
  return settings as AutocueSettings;
}

// --- `autocue` job -----------------------------------------------------------------------

export const AUTOCUE_JOB = 'autocue';

/** Bump when the detection changes in a way that should re-analyse every asset. */
export const AUTOCUE_ALGORITHM_VERSION = 1;

/** Analyses the playout copy with this hash; a job for a replaced copy does nothing. */
export const autocueJobPayloadSchema = z.object({
  orgId: uuidSchema,
  stationId: uuidSchema,
  assetId: uuidSchema,
  playoutSha256: sha256HexSchema,
  /** Analyzer version (algorithm + thresholds) the job was enqueued for. */
  analyzerVersion: z.string().min(1).max(100),
});
export type AutocueJobPayload = z.infer<typeof autocueJobPayloadSchema>;

/** Explicit key: one analysis per playout copy and analyzer version (ADR 0006 `once` mode). */
export const autocueIdempotencyKey = (payload: AutocueJobPayload) =>
  `autocue:${payload.assetId}:${payload.playoutSha256}:${payload.analyzerVersion}`;
