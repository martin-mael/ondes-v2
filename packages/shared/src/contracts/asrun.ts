import { z } from 'zod';
import { localDateSchema, logItemKindSchema } from './log.ts';
import { episodeFallbackKindSchema } from './shows.ts';
import { uuidSchema } from './tenancy.ts';

// As-run (#30): what actually aired, one entry per item that took the air. Recorded from the
// engine's `track.started` / `track.ended` events (ADR 0002), append-only: an entry is written
// when the item starts and only its end fields are set afterwards.

const isoTime = z.iso.datetime({ offset: true });

/**
 * Where the audio came from: `log` (pushed by the feeder, usually with its log item), the
 * station's `safety` playlist, the `emergency` file, a `live` DJ, or `unknown`.
 */
export const asRunSourceSchema = z.enum(['log', 'safety', 'emergency', 'live', 'unknown']);
export type AsRunSource = z.infer<typeof asRunSourceSchema>;

/**
 * How the entry left the air, set with `endedAt`:
 * - `complete`: it played its planned length (within `AS_RUN_TOLERANCE_MS`), or it had none
 *   (live, safety without a known length);
 * - `cut`: it left the air early (a skip, a hard start, a live takeover);
 * - `skipped`: it left within `AS_RUN_SKIP_MS` of starting, while it should have played longer;
 * - `interrupted`: the engine restarted while it was on air (no `track.ended` came): the end is
 *   the new boot's time, an upper bound.
 */
export const asRunOutcomeSchema = z.enum(['complete', 'cut', 'skipped', 'interrupted']);
export type AsRunOutcome = z.infer<typeof asRunOutcomeSchema>;

/** Shorter than planned by more than this is a `cut`. Two frames of slack on top of crossfade jitter. */
export const AS_RUN_TOLERANCE_MS = 2000;
/** Left the air within this many ms of starting: `skipped`. */
export const AS_RUN_SKIP_MS = 5000;

/**
 * The outcome of an entry that played `playedMs`, planned for `expectedMs` (null when no
 * length is known).
 */
export function asRunOutcome(playedMs: number, expectedMs: number | null): AsRunOutcome {
  if (expectedMs === null || playedMs >= expectedMs - AS_RUN_TOLERANCE_MS) return 'complete';
  return playedMs < AS_RUN_SKIP_MS ? 'skipped' : 'cut';
}

/** A voice of a transition (a VT, a promo) as it was pushed to air (#57). */
export const asRunVoiceSchema = z.object({
  assetId: uuidSchema.nullable(),
  title: z.string().nullable(),
  /** Where it starts, in ms after the entry carrying the transition went on air. */
  offsetMs: z.int().nonnegative(),
  durationMs: z.int().nonnegative(),
});
export type AsRunVoice = z.infer<typeof asRunVoiceSchema>;

/**
 * The segue transition an entry carries (#57, ADR 0024), as the feeder pushed it:
 * - `rendered: true`: the entry is the island itself (spliced between A's body and B's body);
 * - `rendered: false`: the island wasn't ready, the entry is the item before the transition and
 *   the voices were laid over its crossfade into the next one (degraded mode).
 * Whether a voice really aired follows from the entry's end: one that starts after the entry
 * left the air early didn't.
 */
export const asRunTransitionSchema = z.object({
  rendered: z.boolean(),
  /** Null when no rendered island exists (degraded mode). */
  islandId: uuidSchema.nullable(),
  /** The island spec's hash (ADR 0017). */
  hash: z.string(),
  segueIds: z.array(uuidSchema),
  voices: z.array(asRunVoiceSchema),
});
export type AsRunTransition = z.infer<typeof asRunTransitionSchema>;

/**
 * One engine request of an entry the feeder pushed (#57), as `feeder_push.parts` keeps it: what
 * the as-run records against that request when it starts.
 */
export const feederPushPartSchema = z.object({
  /** The engine `item_id`: a log item id, or `island:<hash>` for an island. */
  itemId: z.string().min(1),
  /** How long it plays inside the entry, in ms (a body ends at its island). Null: its own. */
  expectedMs: z.int().nonnegative().nullable(),
  transition: asRunTransitionSchema.nullable(),
});
export type FeederPushPart = z.infer<typeof feederPushPartSchema>;
export const feederPushPartsSchema = z.array(feederPushPartSchema);

export const asRunEntrySchema = z.object({
  id: uuidSchema,
  stationId: uuidSchema,
  source: asRunSourceSchema,
  /** The log item that aired; null for safety, emergency, live and unplanned pushes. */
  logItemId: uuidSchema.nullable(),
  /** The island segment (its `segment` log item) this item is part of. */
  segmentId: uuidSchema.nullable(),
  /** The log item's kind when it aired. */
  kind: logItemKindSchema.nullable(),
  assetId: uuidSchema.nullable(),
  /** sha256 of the file that played (the playout file). */
  fileSha256: z.string().nullable(),
  /** As aired: the engine's metadata, else the asset's. */
  title: z.string().nullable(),
  artist: z.string().nullable(),
  /** The asset's artists when it aired (rotation rules, analytics). */
  artists: z.array(z.string()),
  liveSessionId: uuidSchema.nullable(),
  /** On the engine's clock, UTC. */
  startedAt: isoTime,
  endedAt: isoTime.nullable(),
  /** How long it was the on-air item (the engine's `played`). Null while on air. */
  durationMs: z.int().nonnegative().nullable(),
  outcome: asRunOutcomeSchema.nullable(),
  /** The log's plan for it when it aired. */
  plannedStart: isoTime.nullable(),
  plannedDurationMs: z.int().nonnegative().nullable(),
  /** `startedAt − plannedStart` in ms: positive is late. Null without a plan. */
  driftMs: z.int().nullable(),
  /**
   * Set when the item aired as the fallback of a missing episode (#47): what stood in for it.
   * Optional so older api versions' payloads still parse.
   */
  fallback: episodeFallbackKindSchema.nullable().optional(),
  /**
   * The segue transition this entry carries (#57): the island it is, or the voices laid over
   * its crossfade out. Optional so older api versions' payloads still parse.
   */
  transition: asRunTransitionSchema.nullable().optional(),
  /** Engine boot and event sequence of the start, for tracing. */
  bootId: z.string(),
  seq: z.int().positive(),
  /** When the api recorded it (its own clock). */
  recordedAt: isoTime,
});
export type AsRunEntry = z.infer<typeof asRunEntrySchema>;

/** Longest range one request may cover. */
export const AS_RUN_RANGE_MAX_MS = 31 * 24 * 3600 * 1000;

/**
 * `GET …/asrun`: entries that started in `[from, to)`, or on the station-local `date`
 * (23–25 h around DST changes). One of the two is required.
 */
export const listAsRunQuerySchema = z
  .object({
    from: isoTime.optional(),
    to: isoTime.optional(),
    date: localDateSchema.optional(),
    assetId: uuidSchema.optional(),
    source: asRunSourceSchema.optional(),
    /** `asc` (default) is air order; `desc` is newest first (now playing, recent history). */
    order: z.enum(['asc', 'desc']).default('asc'),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    /** `nextCursor` from the previous page. */
    cursor: z.string().max(200).optional(),
  })
  .refine((q) => (q.date === undefined) !== (q.from === undefined && q.to === undefined), {
    message: 'pass either date, or from and to',
    path: ['from'],
  })
  .refine((q) => q.date !== undefined || (q.from !== undefined && q.to !== undefined), {
    message: 'from and to go together',
    path: ['to'],
  })
  .refine((q) => !q.from || !q.to || Date.parse(q.to) > Date.parse(q.from), {
    message: 'to must be after from',
    path: ['to'],
  })
  .refine((q) => !q.from || !q.to || Date.parse(q.to) - Date.parse(q.from) <= AS_RUN_RANGE_MAX_MS, {
    message: 'range is longer than 31 days',
    path: ['to'],
  });
export type ListAsRunQuery = z.input<typeof listAsRunQuerySchema>;

export const asRunListSchema = z.object({
  /** The range covered (for `date`: the station-local day in UTC). */
  from: isoTime,
  to: isoTime,
  items: z.array(asRunEntrySchema),
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: z.string().nullable(),
});
export type AsRunList = z.infer<typeof asRunListSchema>;
