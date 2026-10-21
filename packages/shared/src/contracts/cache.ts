import { z } from 'zod';
import { sha256HexSchema } from './library.ts';
import { uuidSchema } from './tenancy.ts';

// Playout cache (#31, ADR 0004). The worker keeps each station's log horizon on local disk,
// content-addressed, and records what it holds in `playout_cache_file`; the feeder (#29)
// builds engine paths with `playoutPath` and checks readiness before each push.
//
//   <cache root>/<stationId>/            mounted read-only in the station's engine at /cache
//     media/<aa>/<sha256>.<ext>          final files, 0444, only ever created by rename(2)
//     .partial/<sha256>.<ext>.part       downloads in progress
//     safety/, emergency.flac            the template's fallbacks (#34, safety.ts): never evicted

/** Where the station's cache directory is mounted inside its engine (ADR 0008). */
export const ENGINE_CACHE_ROOT = '/cache';

const SHA256 = /^[0-9a-f]{64}$/;
const EXT = /^[a-z0-9]{1,10}$/;

export type CacheObject = { sha256: string; ext: string };

/** Path of a cached file relative to the station's cache directory: `media/<aa>/<sha256>.<ext>`. */
export function playoutRelPath({ sha256, ext }: CacheObject): string {
  if (!SHA256.test(sha256)) throw new Error(`Invalid sha256: ${sha256}`);
  if (!EXT.test(ext)) throw new Error(`Invalid extension: ${ext}`);
  return `media/${sha256.slice(0, 2)}/${sha256}.${ext}`;
}

/** Engine URI of a cached file, for the feeder's push. Pure; no I/O. */
export function playoutPath(file: CacheObject, engineRoot: string = ENGINE_CACHE_ROOT): string {
  return `${engineRoot.replace(/\/+$/, '')}/${playoutRelPath(file)}`;
}

/** File extension of a content key (`org/<orgId>/sha256/<hash>.<ext>`), lower case. */
export function cacheExtOf(storageKey: string): string {
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(storageKey)?.[1]?.toLowerCase();
  if (!ext) throw new Error(`No extension in storage key: ${storageKey}`);
  return ext;
}

// --- Files -------------------------------------------------------------------------------

/** `ready`: on disk and verified. `failed`: the last attempt failed (`error`). */
export const cacheFileStateSchema = z.enum(['ready', 'failed']);
export type CacheFileState = z.infer<typeof cacheFileStateSchema>;

/**
 * - `source_missing`: the object isn't in storage; retries won't help.
 * - `checksum_mismatch`: the stored object doesn't match its hash or size.
 * - `io`: anything else (network, disk); retried by the next pass.
 */
export const cacheFileErrorSchema = z.enum(['source_missing', 'checksum_mismatch', 'io']);
export type CacheFileError = z.infer<typeof cacheFileErrorSchema>;

// --- Readiness ---------------------------------------------------------------------------

/**
 * Why a log item isn't ready:
 * - `pending`: not fetched yet (or being fetched);
 * - `deferred`: the horizon doesn't fit the station's budget, it waits for space;
 * - `no_file`: the item's asset has no playout file (not ingested, or deleted);
 * - `source_missing` / `checksum_mismatch` / `io`: the last fetch failed (see above).
 */
export const cacheMissingReasonSchema = z.enum([
  'pending',
  'deferred',
  'no_file',
  'source_missing',
  'checksum_mismatch',
  'io',
]);
export type CacheMissingReason = z.infer<typeof cacheMissingReasonSchema>;

export const cacheReadinessSchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  /** Log items in the window that play a file (songs, VTs, jingles, beds, segment parts). */
  items: z.int().nonnegative(),
  readyItems: z.int().nonnegative(),
  /** 0–100. */
  pctItems: z.number().min(0).max(100),
  /** 0–100, weighted by planned duration: the dashboard number. */
  pctAirTime: z.number().min(0).max(100),
  /** Planned start of the first item that isn't ready, or null. */
  firstMissingAt: z.iso.datetime({ offset: true }).nullable(),
  missing: z.array(
    z.object({
      logItemId: uuidSchema,
      airAt: z.iso.datetime({ offset: true }),
      durationMs: z.int().nonnegative(),
      assetFileId: uuidSchema.nullable(),
      sha256: sha256HexSchema.nullable(),
      reason: cacheMissingReasonSchema,
    }),
  ),
});
export type CacheReadiness = z.infer<typeof cacheReadinessSchema>;

export const cacheReadinessQuerySchema = z.object({
  /** Window length from now, in hours. Default 48. */
  hours: z.coerce.number().min(0.25).max(168).default(48),
});

/** The station's cache as the UI shows it: budget, horizon size, readiness. */
export const cacheStatusSchema = z.object({
  budgetBytes: z.int().nonnegative(),
  usedBytes: z.int().nonnegative(),
  horizonBytes: z.int().nonnegative(),
  deferredFiles: z.int().nonnegative(),
  diskLow: z.boolean(),
  /** Null until the worker's first complete pass for the station. */
  lastPassAt: z.iso.datetime({ offset: true }).nullable(),
  /** The last failed pass and why; null if none failed since the last complete one. */
  lastError: z.object({ at: z.iso.datetime({ offset: true }), message: z.string() }).nullable(),
  readiness: cacheReadinessSchema,
});
export type CacheStatus = z.infer<typeof cacheStatusSchema>;

// --- Jobs --------------------------------------------------------------------------------

/**
 * `cache-sync`: one pass over a station's horizon (scan, plan, evict, fetch, record). Enqueued
 * on log changes, by the worker's sweep and after a 422. No explicit idempotency key: the
 * payload hash collapses concurrent duplicates (`in_flight`) and a later pass runs again.
 */
export const CACHE_SYNC_JOB = 'cache-sync';
export const cacheSyncJobPayloadSchema = z.object({ orgId: uuidSchema, stationId: uuidSchema });
export type CacheSyncJobPayload = z.infer<typeof cacheSyncJobPayloadSchema>;

/** `cache-fetch`: the feeder's urgent fetch of one file it is about to push (high lane). */
export const CACHE_FETCH_JOB = 'cache-fetch';
export const cacheFetchJobPayloadSchema = z.object({
  orgId: uuidSchema,
  stationId: uuidSchema,
  assetFileId: uuidSchema,
});
export type CacheFetchJobPayload = z.infer<typeof cacheFetchJobPayloadSchema>;
