import { z } from 'zod';
import {
  assetSchema,
  assetTypeSchema,
  dateInputSchema,
  tagInputSchema,
  tagSchema,
} from './library.ts';
import { playoutGainDbSchema, playoutGainSchema } from './loudness.ts';
import { uuidSchema } from './tenancy.ts';

// Library search, facets and bulk edits (#23): the library screen's api, under
// /api/v1/stations/:stationId/library. Filters travel as JSON bodies (POST), since they nest.
//
// Filter semantics: every field narrows the result (AND). Inside a list field, any value
// matches (OR), except tags: values of the same key are OR'ed, different keys AND'ed
// (`genre: jazz | soul` and `mood: warm`).

// --- Filter ------------------------------------------------------------------------------

/**
 * Analysis state of an asset, from its stored results:
 * - `complete`: loudness measured, cues analysed (or set by hand) and waveform peaks stored.
 * - `pending`: any of them missing (a job is queued, failed, or never ran).
 * - `no_loudness` / `no_cues` / `no_peaks`: that one result is missing.
 */
export const analysisStateSchema = z.enum([
  'complete',
  'pending',
  'no_loudness',
  'no_cues',
  'no_peaks',
]);
export type AnalysisState = z.infer<typeof analysisStateSchema>;
export const ANALYSIS_STATES = analysisStateSchema.options;

/**
 * Scheduling window at the time of the request: `active` (schedulable now), `future` (before
 * `startAt`) or `expired` (from `killAt` on).
 */
export const validitySchema = z.enum(['active', 'future', 'expired']);
export type Validity = z.infer<typeof validitySchema>;
export const VALIDITIES = validitySchema.options;

/** Inclusive bounds; either may be left out. */
const rangeOf = <T extends z.ZodType<number | Date, unknown>>(value: T) =>
  z
    .object({ min: value.optional(), max: value.optional() })
    .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, 'min > max');

export const libraryFilterSchema = z.object({
  /**
   * Words to find in the title, artists, album or tag values (substrings, case and accents
   * ignored). Every word must match somewhere in the asset: `daft disco` finds Daft Punk's
   * songs on "Discovery".
   */
  q: z.string().trim().max(200).optional(),
  types: z.array(assetTypeSchema).max(6).optional(),
  tags: z.array(tagInputSchema).max(50).optional(),
  analysis: z.array(analysisStateSchema).max(5).optional(),
  validity: z.array(validitySchema).max(3).optional(),
  explicit: z.boolean().optional(),
  durationMs: rangeOf(z.int().min(0)).optional(),
  bpm: rangeOf(z.number().min(0).max(400)).optional(),
  year: rangeOf(z.int().min(0).max(9999)).optional(),
  /** When the asset was added (created). */
  addedAt: rangeOf(dateInputSchema).optional(),
  /** Not aired since this instant, never-played assets included (as-run, #30). */
  notPlayedSince: dateInputSchema.optional(),
  /** Never aired on this station. */
  neverPlayed: z.boolean().optional(),
  /** Has a playout copy (ingest done), so it can be listened to or queued (#24). */
  playable: z.boolean().optional(),
});
export type LibraryFilter = z.input<typeof libraryFilterSchema>;
export type ParsedLibraryFilter = z.output<typeof libraryFilterSchema>;

// --- Search ------------------------------------------------------------------------------

/**
 * Sort keys. Text sorts ignore case and accents; an empty value (no artist, no album, no year) sorts as
 * the lowest value, so first ascending and last descending. Ties break on the id.
 */
export const librarySortSchema = z.enum([
  'added',
  'title',
  'artist',
  'album',
  'year',
  'duration',
  'bpm',
]);
export type LibrarySort = z.infer<typeof librarySortSchema>;
export const sortDirectionSchema = z.enum(['asc', 'desc']);
export type SortDirection = z.infer<typeof sortDirectionSchema>;

/** `POST …/library/search` */
export const librarySearchSchema = z.object({
  filter: libraryFilterSchema.default({}),
  sort: librarySortSchema.default('added'),
  direction: sortDirectionSchema.default('desc'),
  limit: z.int().min(1).max(200).default(100),
  /** `nextCursor` of the previous page, for the same filter and sort. */
  cursor: z.string().max(1000).optional(),
});
export type LibrarySearch = z.input<typeof librarySearchSchema>;

/** Which analysis results the asset has (see {@link analysisStateSchema}). */
export const assetAnalysisSummarySchema = z.object({
  loudness: z.boolean(),
  cues: z.boolean(),
  peaks: z.boolean(),
});
export type AssetAnalysisSummary = z.infer<typeof assetAnalysisSummarySchema>;

export const libraryItemSchema = assetSchema.extend({
  tags: z.array(tagSchema),
  analysis: assetAnalysisSummarySchema,
  integratedLufs: z.number().nullable(),
  playoutGain: playoutGainSchema,
  bpm: z.number().nullable(),
  musicalKey: z.string().nullable(),
  /** Last time it aired on this station (as-run), `null` if never. */
  lastPlayedAt: z.date().nullable(),
});
export type LibraryItem = z.infer<typeof libraryItemSchema>;

export const librarySearchPageSchema = z.object({
  items: z.array(libraryItemSchema),
  /** Pass as `cursor` for the next page; `null` on the last page. */
  nextCursor: z.string().nullable(),
});
export type LibrarySearchPage = z.infer<typeof librarySearchPageSchema>;

// --- Random pick ---------------------------------------------------------------------------

/**
 * `POST …/library/random`: one asset matching the filter, drawn uniformly at random from the
 * whole station (the cue editor's random next track, #24), or `null` when none matches.
 */
export const libraryRandomSchema = z.object({
  filter: libraryFilterSchema.default({}),
  /** Assets not to draw (the one being edited, the current pick). */
  exclude: z.array(uuidSchema).max(50).default([]),
});
export type LibraryRandom = z.input<typeof libraryRandomSchema>;

export const libraryRandomResultSchema = z.object({ item: libraryItemSchema.nullable() });
export type LibraryRandomResult = z.infer<typeof libraryRandomResultSchema>;

// --- Facets ------------------------------------------------------------------------------

/** `POST …/library/facets` */
export const libraryFacetsQuerySchema = z.object({ filter: libraryFilterSchema.default({}) });
export type LibraryFacetsQuery = z.input<typeof libraryFacetsQuerySchema>;

/**
 * Counts for the facet panel. `total` matches the whole filter. Each facet's counts apply
 * every filter except that facet's own (and, for tags, except the same key's), so picking
 * one value shows how many the others would add.
 */
export const libraryFacetsSchema = z.object({
  total: z.int(),
  types: z.array(z.object({ type: assetTypeSchema, count: z.int() })),
  tags: z.array(tagSchema.extend({ count: z.int() })),
  analysis: z.array(z.object({ state: analysisStateSchema, count: z.int() })),
  validity: z.array(z.object({ validity: validitySchema, count: z.int() })),
});
export type LibraryFacets = z.infer<typeof libraryFacetsSchema>;

/** Most tag values returned per key, by count. */
export const FACET_TAGS_PER_KEY = 100;

// --- Bulk edits --------------------------------------------------------------------------

/** Most assets one bulk edit may touch. */
export const MAX_BULK_ASSETS = 10_000;

/**
 * What a bulk edit applies to: a list of ids, or every asset matching a filter. With a filter,
 * `expectedCount` is the count the person saw; when the library changed meanwhile and the
 * filter now matches another number of assets, nothing happens (409 `selection_changed`).
 */
export const bulkSelectionSchema = z.union([
  z.object({ ids: z.array(uuidSchema).min(1).max(MAX_BULK_ASSETS) }),
  z.object({
    filter: libraryFilterSchema,
    expectedCount: z.int().min(1).max(MAX_BULK_ASSETS),
  }),
]);
export type BulkSelection = z.input<typeof bulkSelectionSchema>;

/**
 * Fields a bulk edit may set: the ones assets share, not titles, ISRCs or notes. Same rules as
 * `updateAssetSchema`; a `killAt` that would end up before an asset's `startAt` fails the
 * whole edit (409).
 */
export const bulkAssetPatchSchema = z
  .object({
    type: assetTypeSchema,
    album: z.string().trim().min(1).max(500).nullable(),
    year: z.int().min(1000).max(9999).nullable(),
    version: z.string().trim().min(1).max(200).nullable(),
    explicit: z.boolean(),
    startAt: dateInputSchema.nullable(),
    killAt: dateInputSchema.nullable(),
    normalizeLoudness: z.boolean(),
    gainOverrideDb: playoutGainDbSchema.nullable(),
  })
  .partial()
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), 'empty update');
export type BulkAssetPatch = z.input<typeof bulkAssetPatchSchema>;

export const bulkActionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('tags'),
      add: z.array(tagInputSchema).max(50).default([]),
      /** Tag values to take off; matched case-insensitively. */
      remove: z.array(tagInputSchema).max(50).default([]),
    })
    .refine((a) => a.add.length + a.remove.length > 0, 'nothing to change'),
  z.object({ kind: z.literal('update'), patch: bulkAssetPatchSchema }),
  /** Refused with 409 `asset_in_use` (details: `{ usages }`) while something needs an asset. */
  z.object({ kind: z.literal('delete') }),
  /**
   * A category's manual list (#37), through the categories api: `include` or `exclude` the
   * selection (replacing their current entry), or `remove` their entries. Audited as one
   * `category.update`.
   */
  z.object({
    kind: z.literal('category'),
    categoryId: uuidSchema,
    mode: z.enum(['include', 'exclude', 'remove']),
  }),
]);
export type BulkAction = z.input<typeof bulkActionSchema>;

/** `POST …/library/bulk`. Every changed asset gets its own audit row. */
export const libraryBulkSchema = z.object({
  selection: bulkSelectionSchema,
  action: bulkActionSchema,
});
export type LibraryBulk = z.input<typeof libraryBulkSchema>;

export const libraryBulkResultSchema = z.object({
  /** Assets selected. */
  matched: z.int(),
  /** Assets actually changed (a tag already there changes nothing; for `category`, entries). */
  changed: z.int(),
});
export type LibraryBulkResult = z.infer<typeof libraryBulkResultSchema>;

/**
 * Why an asset can't be deleted: an episode not aired yet, the safety playlist, the emergency
 * file, or a log item from now on. `usedBy` is that thing's id (the station's for the safety
 * selections).
 */
export const assetUsageKindSchema = z.enum([
  'episode',
  'safety_playlist',
  'emergency_file',
  'log_item',
  'segue_voice',
]);
export const assetUsageSchema = z.object({
  assetId: uuidSchema,
  kind: assetUsageKindSchema,
  usedBy: z.string(),
});
export type AssetUsage = z.infer<typeof assetUsageSchema>;

// --- Asset activity ----------------------------------------------------------------------

/** `GET …/library/assets/:assetId/activity`: airplay and engine cache, for the drawer. */
export const assetActivitySchema = z.object({
  lastPlayedAt: z.date().nullable(),
  /** Airings in the last 7 and 30 days. */
  plays7d: z.int(),
  plays30d: z.int(),
  /** Playout copy on the engine host's cache (#31): `null` when it isn't there. */
  cache: z
    .object({
      state: z.enum(['ready', 'failed']),
      error: z.string().nullable(),
      fetchedAt: z.date().nullable(),
    })
    .nullable(),
});
export type AssetActivity = z.infer<typeof assetActivitySchema>;
