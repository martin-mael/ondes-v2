import { z } from 'zod';
import { PLAYOUT_FLAC_BLOCK_SIZE, PLAYOUT_SAMPLE_RATE, sha256HexSchema } from './library.ts';
import { logRangeQuerySchema } from './log.ts';
import { uuidSchema } from './tenancy.ts';

// Segues and islands (#55, ADR 0017). A segue is the transition between two consecutive log
// items, A (outgoing) and B (incoming), with voice tracks over it. An island is the audio the
// renderer (#56) mixes from it: the stretch where playback deviates from "A, then B", rendered
// into one FLAC and played by the engine as `A body → island → B body`, one merged segment
// (#57, ADR 0002, spike #12). Islands are derived, never edited: `deriveIslands`
// (`segues/island.ts`) turns a chain of segues into island specs, and a spec's hash keys the
// rendered file.
//
// Every position is an integer sample at `PLAYOUT_SAMPLE_RATE` on the segue's own axis:
// **0 is A's end** (its effective cue-out), negative is before it. A plays `[A.cueIn − A.cueOut,
// 0)`, B starts at `in.start`, a voice lane at its `start`. Gains are dB, relative to the
// asset's playout gain (what the engine applies as `liq_amplify`).

/** Version of the island spec and of its derivation rules. Bump it to re-render every island. */
export const ISLAND_SPEC_VERSION = 1;

/**
 * Normal playback kept on each side of an island: the island starts this many samples before
 * the first deviation and ends this many after B plays alone at full volume (10 ms, spike #12).
 */
export const ISLAND_HANDLE_SAMPLES = 441;

/**
 * Shortest body of an item between two islands, or before/after one. Shorter, and the item is
 * rendered whole into the island instead (overlapping islands merge, e.g.
 * `A > VT1 > B(short) > VT2 > C` is one island): one second.
 */
export const ISLAND_MIN_BODY_SAMPLES = PLAYOUT_SAMPLE_RATE;

/** At or below this gain an envelope is silent (amplitude 0, not 10^(−90/20)). */
export const ENVELOPE_SILENCE_DB = -90;
export const ENVELOPE_MAX_DB = 12;
export const ENVELOPE_MAX_POINTS = 64;
export const SEGUE_MAX_VOICES = 4;
/** Offsets stay within ±10 minutes of A's end. */
export const SEGUE_MAX_OFFSET_SAMPLES = 600 * PLAYOUT_SAMPLE_RATE;

/** Position on the segue axis, in samples (0 = A's end). */
export const segueOffsetSchema = z
  .int()
  .min(-SEGUE_MAX_OFFSET_SAMPLES)
  .max(SEGUE_MAX_OFFSET_SAMPLES);

const samples = z.int().min(0);

/** A gain point: at `at` the lane plays at `gainDb`. */
export const envelopePointSchema = z.object({
  at: z.int(),
  gainDb: z.number().min(ENVELOPE_SILENCE_DB).max(ENVELOPE_MAX_DB),
});
export type EnvelopePoint = z.infer<typeof envelopePointSchema>;

/**
 * A gain envelope, points in strictly increasing `at`. Between two points the gain moves
 * linearly **in amplitude** (10^(dB/20)), so a ramp to {@link ENVELOPE_SILENCE_DB} is a linear
 * fade-out. Before the first point and after the last one it holds. Empty: 0 dB throughout.
 * Ducking, fades and cuts are all envelopes (`envelopeGainAt` is the reference).
 */
export const envelopeSchema = z
  .array(envelopePointSchema)
  .max(ENVELOPE_MAX_POINTS)
  .refine(
    (points) => points.every((p, i) => i === 0 || p.at > (points[i - 1] as EnvelopePoint).at),
    {
      message: 'envelope points must be in strictly increasing time',
    },
  );
export type Envelope = z.infer<typeof envelopeSchema>;

const segueEnvelope = envelopeSchema.refine(
  (points) => points.every((p) => Math.abs(p.at) <= SEGUE_MAX_OFFSET_SAMPLES),
  { message: 'envelope points must stay within 10 minutes of the transition' },
);

/** A's lane: its ducking and fade-out. Normal playback is 0 dB. */
export const segueOutLaneSchema = z.object({ envelope: segueEnvelope.default([]) });
export type SegueOutLane = z.infer<typeof segueOutLaneSchema>;

/**
 * B's lane: `start` is where B's cue-in plays (the "next start": negative overlaps A's end,
 * positive leaves a gap after it). Its envelope ducks B under the voice and brings it up; B
 * "plays alone" once the envelope holds at 0 dB and every voice has ended.
 */
export const segueInLaneSchema = z.object({
  start: segueOffsetSchema,
  envelope: segueEnvelope.default([]),
});
export type SegueInLane = z.infer<typeof segueInLaneSchema>;

/**
 * A voice lane: a voice track (#59) or a promo (#60), any library asset with a playout copy.
 * Its `cueIn`/`cueOut` (samples in the asset) trim it, defaulting to the asset's cues; it plays
 * from `start` on the segue axis, at its playout gain plus `gainDb`, shaped by its envelope.
 */
export const segueVoiceLaneSchema = z
  .object({
    assetId: uuidSchema,
    start: segueOffsetSchema,
    cueIn: samples.optional(),
    cueOut: samples.optional(),
    gainDb: z.number().min(-60).max(24).default(0),
    envelope: segueEnvelope.default([]),
  })
  .refine((v) => v.cueIn === undefined || v.cueOut === undefined || v.cueOut > v.cueIn, {
    message: 'cueOut must be after cueIn',
    path: ['cueOut'],
  });
export type SegueVoiceLane = z.infer<typeof segueVoiceLaneSchema>;

/**
 * - `ready`: valid; its island is derived (see the island's own render status).
 * - `waiting`: an asset has no playout copy yet (a voice still ingesting). Synced on ingest.
 * - `detached`: A or B was deleted, they are no longer consecutive, or one of them now plays
 *   another asset. The lanes are kept; saving the segue again (`PUT`) re-attaches it.
 * - `invalid`: the lanes don't fit the media as it is now (B starting before A, a voice
 *   outlasting B, …). Edit it.
 * Only `ready` segues have an island; the others air as a plain crossfade.
 */
export const segueStatusSchema = z.enum(['ready', 'waiting', 'detached', 'invalid']);
export type SegueStatus = z.infer<typeof segueStatusSchema>;

export const segueProblemCodeSchema = z.enum([
  'item_deleted',
  'not_consecutive',
  'asset_changed',
  'unsupported_item',
  'missing_media',
  'unsupported_media',
  'out_of_range',
]);
export type SegueProblemCode = z.infer<typeof segueProblemCodeSchema>;

export const segueProblemSchema = z.object({
  code: segueProblemCodeSchema,
  message: z.string(),
});
export type SegueProblem = z.infer<typeof segueProblemSchema>;

/** `manual`: placed by a person. `auto`: placed by smart defaults (#61), which may move it. */
export const segueOriginSchema = z.enum(['manual', 'auto']);
export type SegueOrigin = z.infer<typeof segueOriginSchema>;

// --- Islands -----------------------------------------------------------------------------

/** What the renderer writes. Fixed: the playout copies' format (ADR 0004, spike #12). */
export const islandFormatSchema = z.object({
  codec: z.literal('flac'),
  sampleRate: z.literal(PLAYOUT_SAMPLE_RATE),
  channels: z.literal(2),
  bitDepth: z.literal(24),
  blockSize: z.literal(PLAYOUT_FLAC_BLOCK_SIZE),
});
export type IslandFormat = z.infer<typeof islandFormatSchema>;

export const ISLAND_FORMAT: IslandFormat = {
  codec: 'flac',
  sampleRate: PLAYOUT_SAMPLE_RATE,
  channels: 2,
  bitDepth: 24,
  blockSize: PLAYOUT_FLAC_BLOCK_SIZE,
};

/**
 * One piece of audio in an island: samples `[from, to)` of the playout copy with hash `sha256`,
 * placed at island sample `at`, scaled by `gainDb` (as `liq_amplify` does: 10^(dB/20)) and by
 * the product of its `envelopes` (positions in island samples). Where to read the file is in the
 * island's `files`, outside the hashed spec.
 */
export const islandSourceSchema = z
  .object({
    /** The playout copy's hash: the file is content-addressed, so this pins the audio. */
    sha256: sha256HexSchema,
    from: samples,
    to: samples,
    at: samples,
    gainDb: z.number(),
    envelopes: z.array(envelopeSchema),
  })
  .refine((s) => s.to > s.from, { message: 'empty source', path: ['to'] });
export type IslandSource = z.infer<typeof islandSourceSchema>;

/**
 * Everything that decides the rendered audio, and nothing else: no asset, item or segue ids
 * and no storage keys, so equal audio has an equal spec (and one render), whichever assets or
 * transitions it comes from. Mix every source into `lengthSamples` of silence, write `format`.
 * Its {@link islandHash} keys the file ({@link islandStorageKey}).
 */
export const islandSpecSchema = z.object({
  version: z.literal(ISLAND_SPEC_VERSION),
  format: islandFormatSchema,
  lengthSamples: z.int().positive(),
  sources: z.array(islandSourceSchema).min(1),
});
export type IslandSpec = z.infer<typeof islandSpecSchema>;

/** Where the renderer reads each source: playout copy hash → its storage key and asset. Not hashed. */
export const islandFilesSchema = z.record(
  sha256HexSchema,
  z.object({ storageKey: z.string().min(1), assetId: uuidSchema }),
);
export type IslandFiles = z.infer<typeof islandFilesSchema>;

/**
 * Where an island joins the log. `head`: the island starts at `joinSample` of the first item's
 * playout copy, whose body plays `[cueIn, joinSample)` before it (no body when `joinSample` is
 * its cue-in). `tail`: the last item's body resumes at `joinSample`, on its FLAC block grid so
 * the engine's seek is sample-exact (no body when it is its cue-out). The engine (#57) sends
 * the joins with the half-sample bias of ADR 0002.
 */
export const islandJoinSchema = z.object({
  itemId: uuidSchema,
  assetId: uuidSchema,
  joinSample: samples,
  /** The item still plays a body outside the island. */
  hasBody: z.boolean(),
});
export type IslandJoin = z.infer<typeof islandJoinSchema>;

/**
 * - `pending`: to render (new or changed spec). The renderer picks these up (`island.updated`).
 * - `rendering`: claimed by a render job.
 * - `ready`: the file at `storageKey` matches `hash`.
 * - `failed`: the render failed (`error`). A transient failure is retried by the queue, then by
 *   the renderer's sweep with a backoff (up to a cap of attempts); bad input waits for the spec
 *   to change (ADR 0018).
 */
export const islandStatusSchema = z.enum(['pending', 'rendering', 'ready', 'failed']);
export type IslandStatus = z.infer<typeof islandStatusSchema>;

/**
 * A rendered island file, set with `ready`. The engine plays it from the playout cache like any
 * playout copy, addressed by the file's own hash (`playoutPath({ sha256, ext: 'flac' })`).
 */
export const islandFileSchema = z.object({
  sha256: sha256HexSchema,
  sizeBytes: z.int().positive(),
});
export type IslandFile = z.infer<typeof islandFileSchema>;

export const islandSummarySchema = z.object({
  id: uuidSchema,
  stationId: uuidSchema,
  hash: sha256HexSchema,
  status: islandStatusSchema,
  head: islandJoinSchema,
  tail: islandJoinSchema,
  /** The segues it renders, in play order (more than one when islands merged). */
  segueIds: z.array(uuidSchema).min(1),
  /** The log items it covers, in play order: head, …, tail. */
  itemIds: z.array(uuidSchema).min(2),
  lengthSamples: z.int().positive(),
  storageKey: z.string().nullable(),
  /** SHA-256 and size of the rendered FLAC file (not the spec hash): its playout cache key. */
  file: islandFileSchema.nullable(),
  error: z.string().nullable(),
  renderedAt: z.date().nullable(),
  updatedAt: z.date(),
});
export type IslandSummary = z.infer<typeof islandSummarySchema>;

export const islandSchema = islandSummarySchema.extend({
  spec: islandSpecSchema,
  files: islandFilesSchema,
});
export type Island = z.infer<typeof islandSchema>;

/** Storage key of a rendered island: `org/<orgId>/islands/v<version>/<hash>.flac`. */
export function islandStorageKey(
  orgId: string,
  hash: string,
  specVersion: number = ISLAND_SPEC_VERSION,
): string {
  return `org/${orgId}/islands/v${specVersion}/${hash}.flac`;
}

// --- `island-render` job (#56) -----------------------------------------------------------

export const ISLAND_RENDER_JOB = 'island-render';

/**
 * Renders the station's islands whose spec has this hash (ADR 0018). High lane. Enqueued by the
 * api after every sync that leaves an island `pending`, and by the worker's sweep. No explicit
 * key: concurrent requests collapse on the payload (`in_flight`), and a hash that comes back
 * later renders again; the render state is a compare-and-set on the hash, so extra runs do
 * nothing.
 */
export const islandRenderJobPayloadSchema = z.object({
  orgId: uuidSchema,
  stationId: uuidSchema,
  hash: sha256HexSchema,
});
export type IslandRenderJobPayload = z.infer<typeof islandRenderJobPayloadSchema>;

// --- Segue DTOs --------------------------------------------------------------------------

export const segueSchema = z.object({
  id: uuidSchema,
  stationId: uuidSchema,
  /** A. Null once the item is deleted (the segue is then `detached`). */
  fromItemId: uuidSchema.nullable(),
  /** B. Null once the item is deleted. */
  toItemId: uuidSchema.nullable(),
  /** The assets A and B played when the segue was last saved: another one detaches it. */
  fromAssetId: uuidSchema.nullable(),
  toAssetId: uuidSchema.nullable(),
  out: segueOutLaneSchema,
  in: segueInLaneSchema,
  voices: z.array(segueVoiceLaneSchema),
  origin: segueOriginSchema,
  status: segueStatusSchema,
  problem: segueProblemSchema.nullable(),
  island: islandSummarySchema.nullable(),
  /** Bumped on every save; send it back on `PUT` to refuse overwriting someone else's edit. */
  version: z.int().min(1),
  createdBy: uuidSchema.nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Segue = z.infer<typeof segueSchema>;

export const segueListSchema = z.object({ items: z.array(segueSchema) });
export type SegueList = z.infer<typeof segueListSchema>;

const segueLanesInput = {
  out: segueOutLaneSchema.default({ envelope: [] }),
  in: segueInLaneSchema,
  voices: z.array(segueVoiceLaneSchema).max(SEGUE_MAX_VOICES).default([]),
};

/**
 * `POST …/segues`. A and B must be consecutive top-level items of the same log day (B right
 * after A in play order), each playing an asset (song, vt, jingle, bed, fill). One segue per
 * transition: 409 if A already has an outgoing one or B an incoming one.
 */
export const createSegueSchema = z.object({
  fromItemId: uuidSchema,
  toItemId: uuidSchema,
  ...segueLanesInput,
  origin: segueOriginSchema.default('manual'),
});
export type CreateSegue = z.input<typeof createSegueSchema>;

/**
 * `PUT …/segues/:segueId`: replaces the lanes (and optionally the items). Saving re-reads A's
 * and B's assets, which re-attaches a segue detached by `asset_changed`. With `version`, a
 * save over a newer version is a 409.
 */
export const updateSegueSchema = z.object({
  fromItemId: uuidSchema.optional(),
  toItemId: uuidSchema.optional(),
  ...segueLanesInput,
  origin: segueOriginSchema.optional(),
  version: z.int().min(1).optional(),
});
export type UpdateSegue = z.input<typeof updateSegueSchema>;

/**
 * `GET …/segues`: the ones touching `itemId`, the ones in a status (`detached` lists the voice
 * work that lost its place, latest first), or the ones whose A is planned in `[from, to)`.
 */
export const listSeguesQuerySchema = z.union([
  z.object({ itemId: uuidSchema }),
  z.object({ status: segueStatusSchema }),
  logRangeQuerySchema,
]);
export type ListSeguesQuery = z.input<typeof listSeguesQuerySchema>;

/** `GET …/islands?status=`: for render sweeps and the dashboard. */
export const listIslandsQuerySchema = z.object({
  status: islandStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListIslandsQuery = z.input<typeof listIslandsQuerySchema>;

export const islandListSchema = z.object({ items: z.array(islandSummarySchema) });
export type IslandList = z.infer<typeof islandListSchema>;

// --- Events ------------------------------------------------------------------------------

export const segueChangeSchema = z.enum(['created', 'updated', 'deleted', 'synced']);
export type SegueChange = z.infer<typeof segueChangeSchema>;
