import { z } from 'zod';
import { assetTypeSchema, sha256HexSchema } from './library.ts';
import { uuidSchema } from './tenancy.ts';

// Upload & ingest (#18): the browser upload API, the `ingest` job payload and the
// `asset.ingested` event that the analysis jobs (#19–#22, #25) start from.
//
// Flow: the browser creates an upload, PUTs its parts straight to S3 through presigned URLs
// (resuming with `GET …/parts` after an interruption), then completes it. Completing enqueues
// the `ingest` job, which validates, hashes, dedupes and transcodes the file, creates the
// asset and publishes `asset.ingested`. Each upload row keeps the file's status and error.

// --- Uploads -----------------------------------------------------------------------------

/**
 * - `uploading`: parts are being sent; the multipart upload is open.
 * - `queued`: complete, waiting for the ingest job.
 * - `processing`: the ingest job is working on it.
 * - `ingested`: the asset exists (`assetId`).
 * - `duplicate`: the station already has this exact file (`duplicateOfAssetId`); no asset
 *   was created. Reported, never dropped silently.
 * - `quarantined`: the file is broken or not audio (`error`). The uploaded object is kept for
 *   inspection until the upload is deleted.
 * - `failed`: ingest ran out of retries on an infrastructure error (`error`).
 * - `aborted`: cancelled by the client before completing.
 */
export const uploadStatusSchema = z.enum([
  'uploading',
  'queued',
  'processing',
  'ingested',
  'duplicate',
  'quarantined',
  'failed',
  'aborted',
]);
export type UploadStatus = z.infer<typeof uploadStatusSchema>;

/** Statuses after which nothing happens to an upload any more. */
export const FINAL_UPLOAD_STATUSES = [
  'ingested',
  'duplicate',
  'quarantined',
  'failed',
  'aborted',
] as const satisfies readonly UploadStatus[];

/**
 * Machine code of a quarantine or failure: `not_audio` (no audio stream), `probe_failed`
 * (ffprobe can't read it), `transcode_failed` (ffmpeg can't decode it), `empty` (no audio
 * samples), `quota_exceeded`, `size_mismatch`, `internal`.
 */
export const uploadErrorCodeSchema = z.enum([
  'not_audio',
  'probe_failed',
  'transcode_failed',
  'empty',
  'quota_exceeded',
  'size_mismatch',
  'internal',
]);
export type UploadErrorCode = z.infer<typeof uploadErrorCodeSchema>;

/** Largest accepted file: 5 GiB, one S3 multipart upload. */
export const MAX_UPLOAD_BYTES = 5 * 1024 ** 3;
/** S3 parts are 5 MiB minimum (except the last one) and at most 10,000 per upload. */
export const MIN_UPLOAD_PART_BYTES = 5 * 1024 ** 2;
export const MAX_UPLOAD_PARTS = 10_000;
/** Default part size handed to clients: large enough to keep the request count low. */
export const DEFAULT_UPLOAD_PART_BYTES = 16 * 1024 ** 2;

/** Part size for a file: the default, grown so the file fits in {@link MAX_UPLOAD_PARTS}. */
export function uploadPartSize(sizeBytes: number): number {
  const needed = Math.ceil(sizeBytes / MAX_UPLOAD_PARTS);
  return Math.max(
    DEFAULT_UPLOAD_PART_BYTES,
    Math.ceil(needed / MIN_UPLOAD_PART_BYTES) * MIN_UPLOAD_PART_BYTES,
  );
}

/** Number of parts of a file at `partSize` (at least one: an empty file is one empty part). */
export function uploadPartCount(sizeBytes: number, partSize: number): number {
  return Math.max(1, Math.ceil(sizeBytes / partSize));
}

export const uploadSchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  stationId: uuidSchema,
  status: uploadStatusSchema,
  /** File name as picked in the browser. */
  filename: z.string(),
  /** Declared by the client; checked against the stored object on completion. */
  sizeBytes: z.int().min(0),
  contentType: z.string().nullable(),
  /** Type of the asset ingest creates. */
  assetType: assetTypeSchema,
  partSize: z.int().min(1),
  partCount: z.int().min(1),
  /** SHA-256 of the uploaded bytes, once ingest computed it. */
  sha256: sha256HexSchema.nullable(),
  /** The asset created by ingest. */
  assetId: uuidSchema.nullable(),
  /** For `duplicate`: the station's asset that already has this file. */
  duplicateOfAssetId: uuidSchema.nullable(),
  errorCode: uploadErrorCodeSchema.nullable(),
  /** Human-readable detail of a quarantine or failure (ffprobe/ffmpeg stderr excerpt). */
  error: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Upload = z.infer<typeof uploadSchema>;

/** `POST …/uploads` */
export const createUploadSchema = z.object({
  filename: z.string().trim().min(1).max(1000),
  sizeBytes: z.int().min(1).max(MAX_UPLOAD_BYTES),
  contentType: z.string().trim().min(1).max(200).optional(),
  assetType: assetTypeSchema.default('song'),
});
export type CreateUpload = z.input<typeof createUploadSchema>;

/** `POST …/uploads/:uploadId/parts`: URLs for these part numbers (1-based). */
export const presignUploadPartsSchema = z.object({
  partNumbers: z.array(z.int().min(1).max(MAX_UPLOAD_PARTS)).min(1).max(1000),
});
export type PresignUploadParts = z.input<typeof presignUploadPartsSchema>;

export const presignedUploadPartsSchema = z.object({
  /** PUT each part's bytes to its URL; keep the `ETag` response header (S3 checks it). */
  parts: z.array(z.object({ partNumber: z.int(), url: z.string() })),
  /** Seconds the URLs stay valid. */
  expiresIn: z.int(),
});
export type PresignedUploadParts = z.infer<typeof presignedUploadPartsSchema>;

/** `GET …/uploads/:uploadId/parts`: parts S3 already has, to resume after an interruption. */
export const uploadedPartsSchema = z.object({
  parts: z.array(z.object({ partNumber: z.int(), etag: z.string(), size: z.int().optional() })),
});
export type UploadedParts = z.infer<typeof uploadedPartsSchema>;

/** `GET …/uploads` query string. Newest first. */
export const listUploadsQuerySchema = z.object({
  status: uploadStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: uuidSchema.optional(),
});
export type ListUploadsQuery = z.input<typeof listUploadsQuerySchema>;

export const uploadPageSchema = z.object({
  items: z.array(uploadSchema),
  nextCursor: uuidSchema.nullable(),
});
export type UploadPage = z.infer<typeof uploadPageSchema>;

// --- Ingest job --------------------------------------------------------------------------

/** Job name of the worker's `jobs/ingest`. */
export const INGEST_JOB = 'ingest';

/** Enqueued when an upload completes. */
export const ingestJobPayloadSchema = z.object({
  uploadId: uuidSchema,
  orgId: uuidSchema,
  stationId: uuidSchema,
});
export type IngestJobPayload = z.infer<typeof ingestJobPayloadSchema>;

/** Explicit key: one upload is ingested once (ADR 0006 `once` mode). */
export const ingestIdempotencyKey = (payload: IngestJobPayload) => `upload:${payload.uploadId}`;

// --- asset.ingested ----------------------------------------------------------------------

/** A stored file of the asset, as the analysis jobs need it. */
export const ingestedFileSchema = z.object({
  fileId: uuidSchema,
  storageKey: z.string(),
  sha256: sha256HexSchema,
  sizeBytes: z.int().min(0),
  codec: z.string(),
  sampleRate: z.int().nullable(),
  channels: z.int().nullable(),
  durationSamples: z.int().nullable(),
  flacBlockSize: z.int().nullable(),
});
export type IngestedFile = z.infer<typeof ingestedFileSchema>;

/**
 * Data of the `asset.ingested` event (`contracts/events.ts`): a new asset has its master and
 * playout files. Analysis jobs (loudness, autocue, analysis, peaks, dedupe) work from the
 * playout copy (FLAC, 44.1 kHz, 1024-sample blocks).
 *
 * The event goes out on the real-time fanout, which is transient and reaches every
 * subscriber (every worker replica). A subscriber turns it into its own job with an explicit
 * key such as `loudness:<assetId>:<playout.sha256>`, so replicas collapse to one run, and
 * backfills assets it missed (worker down) by querying for assets without its result.
 */
export const assetIngestedDataSchema = z.object({
  orgId: uuidSchema,
  assetId: uuidSchema,
  uploadId: uuidSchema,
  master: ingestedFileSchema,
  playout: ingestedFileSchema,
});
export type AssetIngestedData = z.infer<typeof assetIngestedDataSchema>;

/** Data of the `upload.updated` event: an upload changed status (the UI's per-file view). */
export const uploadUpdatedDataSchema = uploadSchema.pick({
  id: true,
  status: true,
  filename: true,
  assetId: true,
  duplicateOfAssetId: true,
  errorCode: true,
  error: true,
});
export type UploadUpdatedData = z.infer<typeof uploadUpdatedDataSchema>;
