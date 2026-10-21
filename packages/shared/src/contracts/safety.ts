import { z } from 'zod';
import { cacheFileErrorSchema } from './cache.ts';
import { engineSourceSchema } from './engine.ts';
import { assetTypeSchema, sha256HexSchema, tagInputSchema } from './library.ts';
import { uuidSchema } from './tenancy.ts';

// Safety playlist and emergency file (#34). The station's last lines of defence when the log
// runs dry (ADR 0002): the template plays `/cache/safety/*` (randomised, reloaded when the
// directory changes), then `/cache/emergency.flac` on a loop, then silence.
//
// The selection is library assets. The worker's cache-sync pass (#31) pins their playout files
// outside the evictable `media/` tree, and records each file's state, which the api reads:
//
//   <cache root>/<stationId>/
//     safety/<sha256>.flac      the safety playlist: one hard link per selected asset
//     emergency.flac            the emergency loop, replaced atomically (rename)
//     .emergency.sha256         which content emergency.flac holds (the worker's bookkeeping)

/** Most assets a safety playlist can hold. */
export const MAX_SAFETY_ASSETS = 1000;

/** Directory and file names under the station's cache directory (shared by worker and api). */
export const SAFETY_DIR = 'safety';
export const EMERGENCY_FILE = 'emergency.flac';

/** Kind of fallback file. */
export const fallbackKindSchema = z.enum(['safety', 'emergency']);
export type FallbackKind = z.infer<typeof fallbackKindSchema>;

/**
 * Where a selected asset's file stands in the engine's cache:
 * - `ready`: in place, the engine can play it;
 * - `pending`: not synced yet (the next cache-sync pass fetches it);
 * - `failed`: the last attempt failed (`error`), retried by the next pass;
 * - `no_file`: the asset has no playout file (not ingested yet, or ingest failed).
 */
export const fallbackCacheStateSchema = z.enum(['ready', 'pending', 'failed', 'no_file']);
export type FallbackCacheState = z.infer<typeof fallbackCacheStateSchema>;

export const fallbackCacheSchema = z.object({
  state: fallbackCacheStateSchema,
  error: cacheFileErrorSchema.nullable(),
  errorMessage: z.string().nullable(),
});
export type FallbackCache = z.infer<typeof fallbackCacheSchema>;

/** A selected asset with its cache state. */
export const fallbackAssetSchema = z.object({
  assetId: uuidSchema,
  type: assetTypeSchema,
  title: z.string(),
  artists: z.array(z.string()),
  durationMs: z.int().nullable(),
  /** SHA-256 of its playout file; null without one. */
  sha256: sha256HexSchema.nullable(),
  cache: fallbackCacheSchema,
  addedAt: z.date(),
});
export type FallbackAsset = z.infer<typeof fallbackAssetSchema>;

/** `GET /stations/:stationId/safety` */
export const safetyStatusSchema = z.object({
  safety: z.object({
    /** By title. */
    assets: z.array(fallbackAssetSchema),
    /** Assets whose file is in the engine's cache. */
    readyCount: z.int().nonnegative(),
    /** Total duration of the ready assets. */
    readyDurationMs: z.int().nonnegative(),
  }),
  emergency: fallbackAssetSchema.nullable(),
  /** Last time the worker synced this station's fallback files; null if it never did. */
  syncedAt: z.date().nullable(),
  /**
   * What the engine has on air, from its last `engine.track.started`: `safety` or `emergency`
   * means the station is in safety mode. Null before the first track, or after a boot.
   */
  onAir: z.object({ source: engineSourceSchema, startedAt: z.date() }).nullable(),
});
export type SafetyStatus = z.infer<typeof safetyStatusSchema>;

/** `PUT /stations/:stationId/safety/assets`: replaces the whole safety playlist. */
export const setSafetyAssetsSchema = z.object({
  assetIds: z.array(uuidSchema).max(MAX_SAFETY_ASSETS),
});
export type SetSafetyAssets = z.input<typeof setSafetyAssetsSchema>;

/**
 * `POST /stations/:stationId/safety/assets`: adds assets, by id or every asset carrying a tag
 * (a snapshot: assets tagged later aren't added). Already selected ones are kept.
 */
export const addSafetyAssetsSchema = z
  .object({
    assetIds: z.array(uuidSchema).min(1).max(MAX_SAFETY_ASSETS).optional(),
    tag: tagInputSchema.optional(),
  })
  .refine((v) => (v.assetIds === undefined) !== (v.tag === undefined), {
    message: 'expected exactly one of assetIds or tag',
  });
export type AddSafetyAssets = z.input<typeof addSafetyAssetsSchema>;

/** `PUT /stations/:stationId/safety/emergency`: null clears it (the engine then plays silence). */
export const setEmergencyAssetSchema = z.object({ assetId: uuidSchema.nullable() });
export type SetEmergencyAsset = z.input<typeof setEmergencyAssetSchema>;

/** How long the engine may stay on safety or emergency before `engine.safety_mode` is raised. */
export const SAFETY_MODE_GRACE_MS = 30_000;
