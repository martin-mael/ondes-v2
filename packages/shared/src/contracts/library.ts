import { z } from 'zod';
import { uuidSchema } from './tenancy.ts';

// Library contracts (#17): assets, their files, cues, loudness, analysis and tags. Mirrors
// packages/db/src/schema/library.ts. Later issues (ingest #18, analysis #19–#22, segues #37,
// islands #44, …) add fields here; they don't reshape the existing ones.

/** Same as tenancy's: optional fields, but an update must change something. */
function patchOf<S extends z.ZodObject>(schema: S) {
  return schema
    .partial()
    .refine((patch) => Object.values(patch).some((v) => v !== undefined), 'empty update');
}

/** A `Date`, or an ISO 8601 string with an offset (JSON bodies). */
export const dateInputSchema = z.union([
  z.date(),
  z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
]);

// --- Asset -------------------------------------------------------------------------------

/**
 * - `song`: music. `vt`: voice track. `jingle`: station IDs, sweepers, liners.
 * - `bed`: music bed under speech. `episode`: a whole pre-recorded show or podcast episode.
 */
export const assetTypeSchema = z.enum(['song', 'vt', 'jingle', 'bed', 'episode', 'other']);
export type AssetType = z.infer<typeof assetTypeSchema>;

/** ISRC (`FR-Z03-14-00123` or `FRZ031400123`), stored without dashes, upper case. */
export const isrcSchema = z
  .string()
  .transform((value) => value.replaceAll('-', '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/, 'invalid ISRC'));

/**
 * Free-form metadata read from file tags or entered by hand: composer, label, publisher,
 * comment, and the AES46 cart chunk fields of broadcast WAVs (`cart.cutId`, `cart.category`,
 * `cart.outCue`, …). Unknown keys are kept. Anything the scheduler filters on gets a column or
 * a tag instead.
 */
export const assetMetadataSchema = z.looseObject({
  composer: z.string().max(500).optional(),
  label: z.string().max(500).optional(),
  publisher: z.string().max(500).optional(),
  comment: z.string().max(5000).optional(),
  cart: z.looseObject({}).optional(),
});
export type AssetMetadata = z.infer<typeof assetMetadataSchema>;

const titleSchema = z.string().trim().min(1).max(500);
const artistsSchema = z.array(z.string().trim().min(1).max(500)).max(50);

export const assetSchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  /** Owning station. Sharing across an org's stations comes later, as an added link table. */
  stationId: uuidSchema,
  type: assetTypeSchema,
  title: titleSchema,
  /** In credit order. */
  artists: artistsSchema,
  album: z.string().nullable(),
  year: z.int().nullable(),
  isrc: z.string().nullable(),
  /** "Radio Edit", "Extended Mix". */
  version: z.string().nullable(),
  /** Length of the playable audio, for display and rough planning. Exact length: the files. */
  durationMs: z.int().nullable(),
  explicit: z.boolean(),
  /** Not schedulable before this instant (UTC). */
  startAt: z.date().nullable(),
  /** Not schedulable from this instant on (UTC). */
  killAt: z.date().nullable(),
  notes: z.string().nullable(),
  metadata: assetMetadataSchema,
  /** File name as uploaded, for the operator's reference. */
  sourceFilename: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Asset = z.infer<typeof assetSchema>;

const assetFields = {
  type: assetTypeSchema,
  title: titleSchema,
  artists: artistsSchema,
  album: z.string().trim().min(1).max(500).nullable(),
  year: z.int().min(1000).max(9999).nullable(),
  isrc: isrcSchema.nullable(),
  version: z.string().trim().min(1).max(200).nullable(),
  durationMs: z.int().min(0).nullable(),
  explicit: z.boolean(),
  startAt: dateInputSchema.nullable(),
  killAt: dateInputSchema.nullable(),
  notes: z.string().max(10_000).nullable(),
  metadata: assetMetadataSchema,
  sourceFilename: z.string().max(1000).nullable(),
};

function killAfterStart(asset: { startAt?: Date | null; killAt?: Date | null }): boolean {
  return !asset.startAt || !asset.killAt || asset.killAt > asset.startAt;
}

export const createAssetSchema = z
  .object({
    ...assetFields,
    artists: assetFields.artists.optional(),
    album: assetFields.album.optional(),
    year: assetFields.year.optional(),
    isrc: assetFields.isrc.optional(),
    version: assetFields.version.optional(),
    durationMs: assetFields.durationMs.optional(),
    explicit: assetFields.explicit.optional(),
    startAt: assetFields.startAt.optional(),
    killAt: assetFields.killAt.optional(),
    notes: assetFields.notes.optional(),
    metadata: assetFields.metadata.optional(),
    sourceFilename: assetFields.sourceFilename.optional(),
  })
  .refine(killAfterStart, { message: 'killAt must be after startAt', path: ['killAt'] });
/** Metadata edits. `durationMs` and `sourceFilename` belong to ingest, not to this patch. */
export const updateAssetSchema = patchOf(
  z.object(assetFields).omit({ durationMs: true, sourceFilename: true }),
).refine(killAfterStart, { message: 'killAt must be after startAt', path: ['killAt'] });

export type CreateAsset = z.input<typeof createAssetSchema>;
export type UpdateAsset = z.input<typeof updateAssetSchema>;

// --- Asset files -------------------------------------------------------------------------

/**
 * - `master`: the archived original, lossless (kept as uploaded when already lossless).
 * - `playout`: what the engine plays. Always FLAC with a fixed block size (spike #12).
 * - `peaks`: waveform data for the editors.
 */
export const assetFileRoleSchema = z.enum(['master', 'playout', 'peaks']);
export type AssetFileRole = z.infer<typeof assetFileRoleSchema>;

/**
 * Playout copies are FLAC at 44.1 kHz with 1024-sample blocks: Liquidsoap seeks to the next
 * packet boundary, so islands splice sample-exactly only on a known, fixed grid (spike #12,
 * engine/spikes/splice/RESULTS.md). MP3 and AAC are never used for playout.
 */
export const PLAYOUT_SAMPLE_RATE = 44_100;
export const PLAYOUT_FLAC_BLOCK_SIZE = 1024;

export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'lowercase hex SHA-256');

export const assetFileSchema = z.object({
  id: uuidSchema,
  assetId: uuidSchema,
  orgId: uuidSchema,
  stationId: uuidSchema,
  role: assetFileRoleSchema,
  /** Object key in the org's storage (`org/<orgId>/sha256/<hash>.<ext>`). */
  storageKey: z.string(),
  sha256: sha256HexSchema,
  sizeBytes: z.int().min(0),
  /** `flac`, `pcm_s24le`, `json`, … (ffprobe's codec name, `json`/`dat` for peaks). */
  codec: z.string(),
  mimeType: z.string().nullable(),
  sampleRate: z.int().nullable(),
  channels: z.int().nullable(),
  bitDepth: z.int().nullable(),
  /** Exact length in samples per channel, at `sampleRate`. */
  durationSamples: z.int().nullable(),
  /** FLAC block size in samples. Always set on playout copies: islands splice on this grid. */
  flacBlockSize: z.int().nullable(),
  createdAt: z.date(),
});
export type AssetFile = z.infer<typeof assetFileSchema>;

export const createAssetFileSchema = z
  .object({
    role: assetFileRoleSchema,
    storageKey: z.string().min(1).max(1024),
    sha256: sha256HexSchema,
    sizeBytes: z.int().min(0),
    codec: z.string().min(1).max(50),
    mimeType: z.string().max(100).nullable().optional(),
    sampleRate: z.int().min(1).max(768_000).nullable().optional(),
    channels: z.int().min(1).max(64).nullable().optional(),
    bitDepth: z.int().min(1).max(64).nullable().optional(),
    durationSamples: z.int().min(0).nullable().optional(),
    flacBlockSize: z.int().min(16).max(65_535).nullable().optional(),
  })
  .superRefine((file, ctx) => {
    if (file.role !== 'playout') return;
    if (file.codec !== 'flac') {
      ctx.addIssue({ code: 'custom', path: ['codec'], message: 'playout copies are FLAC' });
    }
    if (file.flacBlockSize == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['flacBlockSize'],
        message: 'playout copies need their FLAC block size',
      });
    }
    if (file.sampleRate == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['sampleRate'],
        message: 'playout copies need their sample rate',
      });
    }
  });
export type CreateAssetFile = z.input<typeof createAssetFileSchema>;

// --- Cues --------------------------------------------------------------------------------

/**
 * Cue points, as **sample positions** in the asset's audio at the cue row's `sampleRate`
 * (the playout copy's), so islands can splice sample-exactly. `fadeIn` and `fadeOut` are
 * durations in samples (fade in from `cueIn`, fade out ending at `cueOut`), like Liquidsoap's
 * `liq_fade_in`/`liq_fade_out`; the others are positions from the start of the file.
 */
export const cueFieldSchema = z.enum([
  'cueIn',
  'cueOut',
  'introEnd',
  'outroStart',
  'fadeIn',
  'fadeOut',
  'crossStartNext',
]);
export type CueField = z.infer<typeof cueFieldSchema>;
export const CUE_FIELDS = cueFieldSchema.options;

/** `auto`: set by the autocue analysis. `manual`: set by a person, in the cue editor. */
export const cueSourceSchema = z.enum(['auto', 'manual']);
export type CueSource = z.infer<typeof cueSourceSchema>;

export const samplePositionSchema = z.int().min(0);

export const cuePointSchema = z.object({
  /** `null`: not set (the engine falls back to its defaults). */
  samples: samplePositionSchema.nullable(),
  source: cueSourceSchema,
  /** A locked point is never overwritten by autocue. */
  locked: z.boolean(),
});
export type CuePoint = z.infer<typeof cuePointSchema>;

export const assetCuesSchema = z.object({
  assetId: uuidSchema,
  sampleRate: z.int().min(1),
  /** Version of the analyzer that produced the `auto` points. */
  analyzerVersion: z.string().nullable(),
  ...(Object.fromEntries(CUE_FIELDS.map((field) => [field, cuePointSchema])) as Record<
    CueField,
    typeof cuePointSchema
  >),
  updatedAt: z.date(),
});
export type AssetCues = z.infer<typeof assetCuesSchema>;

const cuePointPatchSchema = z
  .object({ samples: samplePositionSchema.nullable().optional(), locked: z.boolean().optional() })
  .refine((p) => p.samples !== undefined || p.locked !== undefined, 'empty cue point update');

/**
 * Manual cue edit. Setting `samples` marks the point `manual`; `locked` protects it from
 * autocue. `sampleRate` is required the first time cues are written for an asset and must
 * match afterwards.
 */
export const updateCuesSchema = z
  .object({
    sampleRate: z.int().min(1).max(768_000).optional(),
    ...(Object.fromEntries(CUE_FIELDS.map((field) => [field, cuePointPatchSchema.optional()])) as {
      [K in CueField]: z.ZodOptional<typeof cuePointPatchSchema>;
    }),
  })
  .refine((patch) => CUE_FIELDS.some((field) => patch[field] !== undefined), 'empty update');
export type UpdateCues = z.input<typeof updateCuesSchema>;

/** Autocue results (worker). Locked and manual points are left alone. */
export const autoCuesSchema = z.object({
  sampleRate: z.int().min(1).max(768_000),
  analyzerVersion: z.string().min(1).max(100),
  points: z.partialRecord(cueFieldSchema, samplePositionSchema.nullable()),
});
export type AutoCues = z.input<typeof autoCuesSchema>;

/** Seconds for a sample position, for the engine's request metadata. */
export function samplesToSeconds(samples: number, sampleRate: number): number {
  return samples / sampleRate;
}

// --- Loudness and analysis ---------------------------------------------------------------

/** 0 (guess) to 1 (certain). */
export const confidenceSchema = z.number().min(0).max(1);

export const assetLoudnessSchema = z.object({
  assetId: uuidSchema,
  /** EBU R128 integrated loudness. */
  integratedLufs: z.number(),
  /** EBU R128 loudness range. */
  loudnessRangeLu: z.number().nullable(),
  truePeakDbtp: z.number().nullable(),
  /** Tool that measured it: `ffmpeg-ebur128`, `libebur128`. */
  analyzer: z.string(),
  analyzerVersion: z.string(),
  confidence: confidenceSchema.nullable(),
  measuredAt: z.date(),
});
export type AssetLoudness = z.infer<typeof assetLoudnessSchema>;
export const setLoudnessSchema = assetLoudnessSchema
  .omit({ assetId: true, measuredAt: true })
  .extend({
    integratedLufs: z.number().min(-70).max(10),
    loudnessRangeLu: z.number().min(0).max(100).nullable().optional(),
    truePeakDbtp: z.number().min(-100).max(30).nullable().optional(),
    analyzer: z.string().min(1).max(100),
    analyzerVersion: z.string().min(1).max(100),
    confidence: confidenceSchema.nullable().optional(),
  });
export type SetLoudness = z.input<typeof setLoudnessSchema>;

/** Musical key, `C`, `F#m`, `Bbm` (Camelot codes are derived, not stored). */
export const musicalKeySchema = z.string().regex(/^[A-G][#b]?m?$/, 'key like C, F#m, Bbm');

export const assetAnalysisSchema = z.object({
  assetId: uuidSchema,
  bpm: z.number().nullable(),
  musicalKey: z.string().nullable(),
  /** 0 (calm) to 1 (intense). */
  energy: z.number().nullable(),
  confidence: confidenceSchema.nullable(),
  analyzer: z.string(),
  analyzerVersion: z.string(),
  /** Extra analyzer outputs (danceability, valence, …), kept as reported. */
  features: z.record(z.string(), z.unknown()),
  analyzedAt: z.date(),
});
export type AssetAnalysis = z.infer<typeof assetAnalysisSchema>;
export const setAnalysisSchema = z.object({
  bpm: z.number().min(1).max(400).nullable().optional(),
  musicalKey: musicalKeySchema.nullable().optional(),
  energy: z.number().min(0).max(1).nullable().optional(),
  confidence: confidenceSchema.nullable().optional(),
  analyzer: z.string().min(1).max(100),
  analyzerVersion: z.string().min(1).max(100),
  features: z.record(z.string(), z.unknown()).optional(),
});
export type SetAnalysis = z.input<typeof setAnalysisSchema>;

// --- Tags --------------------------------------------------------------------------------

/** Tag dimensions. An asset can carry several values per key (two genres, three moods). */
export const tagKeySchema = z.enum([
  'genre',
  'style',
  'mood',
  'energy',
  'era',
  'language',
  'custom',
]);
export type TagKey = z.infer<typeof tagKeySchema>;

export const tagValueSchema = z.string().trim().min(1).max(200);

export const tagSchema = z.object({
  id: uuidSchema,
  key: tagKeySchema,
  value: z.string(),
});
export type Tag = z.infer<typeof tagSchema>;

export const tagInputSchema = z.object({ key: tagKeySchema, value: tagValueSchema });
/** Replaces an asset's whole tag set. Duplicates (case-insensitive) are merged. */
export const setAssetTagsSchema = z.object({ tags: z.array(tagInputSchema).max(200) });
export type SetAssetTags = z.input<typeof setAssetTagsSchema>;

// --- Reads -------------------------------------------------------------------------------

export const assetDetailSchema = assetSchema.extend({
  files: z.array(assetFileSchema),
  cues: assetCuesSchema.nullable(),
  loudness: assetLoudnessSchema.nullable(),
  analysis: assetAnalysisSchema.nullable(),
  tags: z.array(tagSchema),
});
export type AssetDetail = z.infer<typeof assetDetailSchema>;

/** `GET …/assets` query string. Newest first; `cursor` is the last id of the previous page. */
export const listAssetsQuerySchema = z.object({
  type: assetTypeSchema.optional(),
  /** Case-insensitive match on title, artists and album. */
  q: z.string().trim().min(1).max(200).optional(),
  /** `key:value`, e.g. `genre:jazz`. */
  tag: z
    .string()
    .regex(/^[a-z]+:.+$/, 'expected key:value')
    .transform((value) => {
      const at = value.indexOf(':');
      return { key: value.slice(0, at), value: value.slice(at + 1) };
    })
    .pipe(tagInputSchema)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: uuidSchema.optional(),
});
export type ListAssetsQuery = z.input<typeof listAssetsQuerySchema>;

export const assetPageSchema = z.object({
  items: z.array(assetSchema),
  /** Pass as `cursor` for the next page; `null` on the last page. */
  nextCursor: uuidSchema.nullable(),
});
export type AssetPage = z.infer<typeof assetPageSchema>;
