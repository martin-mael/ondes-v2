import { z } from 'zod';
import { uuidSchema } from './tenancy.ts';

// Loudness (#19): measured once at ingest, applied at playout as a precomputed gain. The
// engine never normalises at runtime (Liquidsoap's `normalize` pumps, docs/research/03).
//
//   asset.ingested ──▶ `loudness` job: ffmpeg ebur128 (true peak) on the playout copy
//                      ──▶ asset_loudness (integrated LUFS, LRA, true peak, analyzer version)
//   feeder (#29) ──▶ getPlayoutGain(asset, station) ──▶ request `amplify_db` ──▶ `liq_amplify`

// --- Station targets ---------------------------------------------------------------------

/**
 * Target presets (docs/research/03 §1): AES TD1008 / EBU R128 s2 for streams. A station stores
 * the number (`station.loudnessTargetLufs`); a target that matches no preset is `custom`.
 */
export const LOUDNESS_PRESETS = {
  music: -16,
  talk: -18,
  ebu: -23,
} as const;
export const loudnessPresetSchema = z.enum(['music', 'talk', 'ebu', 'custom']);
export type LoudnessPreset = z.infer<typeof loudnessPresetSchema>;

/** Default true-peak ceiling, in dBTP (`station.truePeakLimitDbtp`). */
export const DEFAULT_TRUE_PEAK_CEILING_DBTP = -1;

/** The preset a station target corresponds to. */
export function loudnessPresetOf(targetLufs: number): LoudnessPreset {
  for (const [preset, value] of Object.entries(LOUDNESS_PRESETS)) {
    if (value === targetLufs) return preset as LoudnessPreset;
  }
  return 'custom';
}

/** The target of a preset; `custom` has none. */
export function loudnessPresetTarget(preset: Exclude<LoudnessPreset, 'custom'>): number {
  return LOUDNESS_PRESETS[preset];
}

// --- Playout gain ------------------------------------------------------------------------

/** Bounds of a playout gain, the same as the engine's `amplify_db`. */
export const PLAYOUT_GAIN_MIN_DB = -60;
export const PLAYOUT_GAIN_MAX_DB = 24;
export const playoutGainDbSchema = z.number().min(PLAYOUT_GAIN_MIN_DB).max(PLAYOUT_GAIN_MAX_DB);

/**
 * EBU R128's absolute gate. Content measured at or below it is silence (or nearly): it is
 * played as it is, never boosted.
 */
export const SILENCE_LUFS = -70;

/**
 * Where a playout gain comes from:
 * - `measured`: target − integrated, clamped to the true-peak ceiling;
 * - `override`: the asset's fixed gain (`gainOverrideDb`), applied as given;
 * - `disabled`: normalisation off for the asset (`normalizeLoudness: false`): 0 dB;
 * - `unmeasured`: no loudness yet (or silence): 0 dB.
 */
export const playoutGainSourceSchema = z.enum(['measured', 'override', 'disabled', 'unmeasured']);
export type PlayoutGainSource = z.infer<typeof playoutGainSourceSchema>;

export const playoutGainSchema = z.object({
  /** dB, rounded to 0.1 dB. Sent to the engine as `amplify_db` (`liq_amplify`). */
  gainDb: playoutGainDbSchema,
  source: playoutGainSourceSchema,
  /** The ceiling lowered the gain: target − integrated would have pushed peaks over it. */
  limitedByPeak: z.boolean(),
});
export type PlayoutGain = z.infer<typeof playoutGainSchema>;

/** What {@link getPlayoutGain} reads from an asset (an `Asset` plus its loudness row). */
export interface PlayoutGainAsset {
  normalizeLoudness: boolean;
  gainOverrideDb: number | null;
  loudness: { integratedLufs: number; truePeakDbtp: number | null } | null;
}

/** What {@link getPlayoutGain} reads from a station (a `Station`). */
export interface PlayoutGainStation {
  loudnessTargetLufs: number;
  truePeakLimitDbtp: number;
}

/**
 * The gain the engine applies to an asset, in dB. Pure: the feeder (#29) calls it for each
 * request and the library shows it on each asset.
 *
 * Precedence: normalisation disabled (0 dB) > override (as given) > measured. Measured gain is
 * `target − integrated`, clamped so `true peak + gain ≤ ceiling`; then bounded to
 * [{@link PLAYOUT_GAIN_MIN_DB}, {@link PLAYOUT_GAIN_MAX_DB}].
 *
 * Rounding: to the nearest 0.1 dB (inaudible, and stable in logs and metadata), except that a
 * gain limited by the ceiling is rounded *down*, so the rounded gain still respects it. An
 * unknown true peak is not clamped.
 */
export function getPlayoutGain(asset: PlayoutGainAsset, station: PlayoutGainStation): PlayoutGain {
  if (!asset.normalizeLoudness) return { gainDb: 0, source: 'disabled', limitedByPeak: false };
  if (asset.gainOverrideDb !== null) {
    return { gainDb: bound(round(asset.gainOverrideDb)), source: 'override', limitedByPeak: false };
  }
  const loudness = asset.loudness;
  if (!loudness || loudness.integratedLufs <= SILENCE_LUFS) {
    return { gainDb: 0, source: 'unmeasured', limitedByPeak: false };
  }
  const wanted = station.loudnessTargetLufs - loudness.integratedLufs;
  let gain = round(wanted);
  let limitedByPeak = false;
  if (loudness.truePeakDbtp !== null) {
    const headroom = station.truePeakLimitDbtp - loudness.truePeakDbtp;
    if (wanted > headroom || gain > headroom) {
      gain = roundDown(headroom);
      limitedByPeak = true;
    }
  }
  return { gainDb: bound(gain), source: 'measured', limitedByPeak };
}

// The epsilon absorbs float noise (−16 − −19.3 = 3.3000000000000007) without moving a real
// value across a 0.1 dB step.
const EPSILON = 1e-9;
const round = (db: number) => clean(Math.round(db * 10 + EPSILON) / 10);
const roundDown = (db: number) => clean(Math.floor(db * 10 + EPSILON) / 10);
/** No `-0` in JSON or the engine's metadata. */
const clean = (db: number) => (Object.is(db, -0) ? 0 : db);
const bound = (db: number) => Math.min(PLAYOUT_GAIN_MAX_DB, Math.max(PLAYOUT_GAIN_MIN_DB, db));

// --- `loudness` job ----------------------------------------------------------------------

export const LOUDNESS_JOB = 'loudness';

/** Analyzer recorded with each measurement; bump the version when the method changes. */
export const LOUDNESS_ANALYZER = 'ffmpeg-ebur128';

/** Measures the playout copy with this hash; a job for a replaced copy does nothing. */
export const loudnessJobPayloadSchema = z.object({
  orgId: uuidSchema,
  stationId: uuidSchema,
  assetId: uuidSchema,
  playoutSha256: z.string().regex(/^[0-9a-f]{64}$/, 'lowercase hex SHA-256'),
});
export type LoudnessJobPayload = z.infer<typeof loudnessJobPayloadSchema>;

/** Explicit key: each playout copy of an asset is measured once (ADR 0006 `once` mode). */
export const loudnessIdempotencyKey = (payload: LoudnessJobPayload) =>
  `loudness:${payload.assetId}:${payload.playoutSha256}`;
