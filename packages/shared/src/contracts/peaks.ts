import { z } from 'zod';
import { sha256HexSchema } from './library.ts';
import { uuidSchema } from './tenancy.ts';

// Waveform peaks (#22): min/max envelopes of an asset's playout copy, for the cue editor (#24)
// and the segue editor (#58).
//
//   asset.ingested ──▶ durable consumer (worker) ──▶ `peaks` job: one ffmpeg decode of the
//                      playout FLAC ──▶ peaks file in S3 ──▶ asset_file (role `peaks`)
//   GET /api/v1/stations/:stationId/assets/:assetId/peaks ──▶ the file below, as is
//
// ## The peaks file (format version 1)
//
// A small container holding one BBC audiowaveform `.dat` (version 2) blob per zoom level, so a
// level can be handed as is to waveform-data.js / peaks.js
// (`WaveformData.create(level.dat.slice().buffer)`), or read with {@link decodePeaks}. All
// integers are little-endian.
//
//   offset  size  field
//   0       4     magic "ODPK" (ASCII)
//   4       2     u16 format version (1)
//   6       2     u16 level count N
//   8       4     u32 sample rate (Hz): the playout copy's, 44 100
//   12      4     u32 channels (1 or 2; the playout copy's, never downmixed)
//   16      8     u64 length in samples per channel (the exact decoded length)
//   24      16×N  level table, finest first: u32 samples per point, u32 point count,
//                 u32 byte offset of the level's `.dat` blob, u32 its byte length
//   …             the `.dat` blobs
//
// Each `.dat` blob (audiowaveform's binary format, version 2):
//
//   0   i32 version (2)   4   u32 flags (1: 8-bit values)   8   i32 sample rate
//   12  i32 samples per point   16  u32 point count   20  i32 channels
//   24  i8 values: for each point, for each channel: min, max
//
// ## Mapping to samples
//
// Cue points are integer sample positions at the playout's sample rate (44 100 Hz), and so are
// peaks: point `p` of a level covers samples `[p × spp, min((p + 1) × spp, length))`, where
// spp is the level's samples per point. Sample `s` falls in point `floor(s / spp)`
// ({@link peaksPointOfSample}); the last point may cover fewer samples. Points never straddle
// a FLAC block (spp divides or is a multiple of the 1024-sample block), so the island splice
// grid lines up with point edges.
//
// Values are the min and max sample of the point, per channel, as signed 8-bit: the 16-bit
// sample shifted right by 8, i.e. floored (audiowaveform's `-b 8`; full scale is −128..127).
// Digital silence is (0, 0); a tiny negative sample gives −1. Channels are never mixed.

/** Bump when the file layout or the maths change: assets are re-processed by the backfill. */
export const PEAKS_FORMAT_VERSION = 1;

export const PEAKS_MAGIC = 'ODPK';

/** Samples per point of each level, finest first (≈ 172 and ≈ 11 points per second). */
export const PEAKS_LEVELS = [256, 4096] as const;

export const PEAKS_MIME_TYPE = 'application/vnd.ondes.peaks';
export const PEAKS_CODEC = 'ondes-peaks';

/**
 * Storage key of an asset's peaks: content-addressed by the playout copy's hash and the format
 * version (the file is a pure function of both), so assets sharing a playout copy share it.
 */
export function peaksStorageKey(
  orgId: string,
  playoutSha256: string,
  formatVersion: number = PEAKS_FORMAT_VERSION,
): string {
  return `org/${orgId}/peaks/v${formatVersion}/${playoutSha256}.peaks`;
}

// --- Encoding ----------------------------------------------------------------------------

export interface PeaksLevel {
  samplesPerPoint: number;
  points: number;
  /** `points × channels × 2` values: point-major, then channel, then (min, max). */
  values: Int8Array;
}

export interface Peaks {
  formatVersion: number;
  sampleRate: number;
  channels: number;
  /** Exact length in samples per channel. */
  lengthSamples: number;
  /** Finest first. */
  levels: PeaksLevel[];
}

export interface DecodedPeaksLevel extends PeaksLevel {
  /** The level's audiowaveform `.dat` blob (a view into the decoded buffer). */
  dat: Uint8Array;
}

export interface DecodedPeaks extends Peaks {
  levels: DecodedPeaksLevel[];
}

const HEADER_BYTES = 24;
const LEVEL_ENTRY_BYTES = 16;
const DAT_HEADER_BYTES = 24;
const DAT_VERSION = 2;
const DAT_FLAG_8BIT = 1;

/** Serialises peaks into the format above. */
export function encodePeaks(peaks: Omit<Peaks, 'formatVersion'>): Uint8Array {
  const { sampleRate, channels, lengthSamples, levels } = peaks;
  let offset = HEADER_BYTES + LEVEL_ENTRY_BYTES * levels.length;
  const placed = levels.map((level) => {
    if (level.values.length !== level.points * channels * 2) {
      throw new Error(`peaks level ${level.samplesPerPoint}: wrong number of values`);
    }
    const entry = { level, offset, bytes: DAT_HEADER_BYTES + level.values.length };
    offset += entry.bytes;
    return entry;
  });
  const out = new Uint8Array(offset);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = PEAKS_MAGIC.charCodeAt(i);
  view.setUint16(4, PEAKS_FORMAT_VERSION, true);
  view.setUint16(6, levels.length, true);
  view.setUint32(8, sampleRate, true);
  view.setUint32(12, channels, true);
  view.setBigUint64(16, BigInt(lengthSamples), true);
  placed.forEach(({ level, offset: at, bytes }, i) => {
    const entry = HEADER_BYTES + i * LEVEL_ENTRY_BYTES;
    view.setUint32(entry, level.samplesPerPoint, true);
    view.setUint32(entry + 4, level.points, true);
    view.setUint32(entry + 8, at, true);
    view.setUint32(entry + 12, bytes, true);
    view.setInt32(at, DAT_VERSION, true);
    view.setUint32(at + 4, DAT_FLAG_8BIT, true);
    view.setInt32(at + 8, sampleRate, true);
    view.setInt32(at + 12, level.samplesPerPoint, true);
    view.setUint32(at + 16, level.points, true);
    view.setInt32(at + 20, channels, true);
    out.set(
      new Uint8Array(level.values.buffer, level.values.byteOffset, level.values.length),
      at + DAT_HEADER_BYTES,
    );
  });
  return out;
}

export class PeaksFormatError extends Error {
  constructor(message: string) {
    super(`peaks file: ${message}`);
    this.name = 'PeaksFormatError';
  }
}

/** Reads a peaks file (format version 1). Values are views into `bytes`, not copies. */
export function decodePeaks(bytes: Uint8Array): DecodedPeaks {
  if (bytes.length < HEADER_BYTES) throw new PeaksFormatError('truncated header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic !== PEAKS_MAGIC) throw new PeaksFormatError('bad magic');
  const formatVersion = view.getUint16(4, true);
  if (formatVersion !== 1) throw new PeaksFormatError(`unsupported version ${formatVersion}`);
  const count = view.getUint16(6, true);
  const sampleRate = view.getUint32(8, true);
  const channels = view.getUint32(12, true);
  const lengthSamples = Number(view.getBigUint64(16, true));
  if (bytes.length < HEADER_BYTES + count * LEVEL_ENTRY_BYTES) {
    throw new PeaksFormatError('truncated level table');
  }
  const levels: DecodedPeaksLevel[] = [];
  for (let i = 0; i < count; i++) {
    const entry = HEADER_BYTES + i * LEVEL_ENTRY_BYTES;
    const samplesPerPoint = view.getUint32(entry, true);
    const points = view.getUint32(entry + 4, true);
    const at = view.getUint32(entry + 8, true);
    const length = view.getUint32(entry + 12, true);
    const expected = DAT_HEADER_BYTES + points * channels * 2;
    if (length !== expected || at + length > bytes.length) {
      throw new PeaksFormatError(`level ${i} out of bounds`);
    }
    if (
      view.getInt32(at, true) !== DAT_VERSION ||
      view.getUint32(at + 4, true) !== DAT_FLAG_8BIT ||
      view.getInt32(at + 12, true) !== samplesPerPoint ||
      view.getUint32(at + 16, true) !== points ||
      view.getInt32(at + 20, true) !== channels
    ) {
      throw new PeaksFormatError(`level ${i}: .dat header disagrees with the level table`);
    }
    levels.push({
      samplesPerPoint,
      points,
      values: new Int8Array(
        bytes.buffer,
        bytes.byteOffset + at + DAT_HEADER_BYTES,
        points * channels * 2,
      ),
      dat: bytes.subarray(at, at + length),
    });
  }
  return { formatVersion, sampleRate, channels, lengthSamples, levels };
}

/** Number of points a level of `samplesPerPoint` has for `lengthSamples` samples. */
export const peaksPointCount = (lengthSamples: number, samplesPerPoint: number) =>
  Math.ceil(lengthSamples / samplesPerPoint);

/** The point holding sample `sample` (an integer position at the file's sample rate). */
export const peaksPointOfSample = (sample: number, samplesPerPoint: number) =>
  Math.floor(sample / samplesPerPoint);

/** Samples `[start, end)` covered by point `point`. */
export function peaksPointSamples(
  point: number,
  samplesPerPoint: number,
  lengthSamples: number,
): { start: number; end: number } {
  const start = point * samplesPerPoint;
  return { start, end: Math.min(start + samplesPerPoint, lengthSamples) };
}

// --- `peaks` job -------------------------------------------------------------------------

export const PEAKS_JOB = 'peaks';

/** Computes the peaks of the playout copy with this hash; a job for a replaced copy does nothing. */
export const peaksJobPayloadSchema = z.object({
  orgId: uuidSchema,
  stationId: uuidSchema,
  assetId: uuidSchema,
  playoutSha256: sha256HexSchema,
});
export type PeaksJobPayload = z.infer<typeof peaksJobPayloadSchema>;

/** Explicit key: each playout copy of an asset gets its peaks once per format version. */
export const peaksIdempotencyKey = (payload: PeaksJobPayload) =>
  `peaks:${payload.assetId}:${payload.playoutSha256}:v${PEAKS_FORMAT_VERSION}`;
