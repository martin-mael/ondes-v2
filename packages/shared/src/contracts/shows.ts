import { z } from 'zod';
import { dateInputSchema } from './library.ts';
import { localDateSchema } from './log.ts';
import { uuidSchema } from './tenancy.ts';

// Shows, slots and episodes (#44, ADR 0012). Mirrors packages/db/src/schema/shows.ts.
//
// A show airs in slots: recurring (weekly, every N weeks) or one-off, at a station-local time,
// with per-occurrence exceptions. Each airing of a show is an episode, numbered per show
// (live and pre-recorded share the numbering). `@ondes/scheduling` expands slots into
// occurrences; the api serves them with the episode planned for each and the conflicts.
//
// Built on by: reruns (#48, slot type `rerun`), missing-episode alerts (#47, episode `status`),
// live slots (#65, slot type `live`), live recording (#67, a live episode's `assetId`), the
// public schedule and ICS (#75), the shows UI (#45) and the log generator (#50).

/** Same as tenancy's: optional fields, but an update must change something. */
function patchOf<S extends z.ZodObject>(schema: S) {
  return schema
    .partial()
    .refine((patch) => Object.values(patch).some((v) => v !== undefined), 'empty update');
}

/** Station-local wall-clock time, `HH:MM` (24 h). */
export const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time like 20:30');
export type LocalTime = z.infer<typeof localTimeSchema>;

export const weekdaySchema = z.enum(['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su']);
export type Weekday = z.infer<typeof weekdaySchema>;

/** Longest slot or episode: 24 h. Shortest slot: 1 min. */
export const SHOW_MAX_DURATION_MS = 24 * 3600 * 1000;
export const showDurationSchema = z.int().min(60_000).max(SHOW_MAX_DURATION_MS);

/**
 * - `prerecorded`: an episode file, hard-started on time.
 * - `live`: a presenter connects (BUTT); automation takes over if nobody does (#65).
 * - `rerun`: a previous episode airs again (#48 adds the strategy).
 */
export const slotTypeSchema = z.enum(['prerecorded', 'live', 'rerun']);
export type SlotType = z.infer<typeof slotTypeSchema>;

/** What a show's new slots default to. A show can't default to reruns. */
export const defaultSlotTypeSchema = z.enum(['prerecorded', 'live']);

// --- Recurrence (ADR 0012) ---------------------------------------------------------------

/** Longest gap a weekly rule may have between airings: a year. */
export const MAX_SLOT_INTERVAL_WEEKS = 52;

/**
 * When a slot airs, on the station's wall clock: a structured subset of RFC 5545 RRULE.
 * - `once`: on `date` at `time`.
 * - `weekly`: every `interval` weeks (counted from `startDate`'s week, weeks start Monday) on
 *   the `byDay` weekdays at `time`, from `startDate` to `until` (inclusive; null: no end).
 * A time in the spring-forward gap airs right after it (02:30 → 03:30); a time that happens
 * twice on the fall-back night airs at the first one.
 */
export const slotRuleSchema = z.discriminatedUnion('freq', [
  z.object({ freq: z.literal('once'), date: localDateSchema, time: localTimeSchema }),
  z
    .object({
      freq: z.literal('weekly'),
      startDate: localDateSchema,
      until: localDateSchema.nullable(),
      interval: z.int().min(1).max(MAX_SLOT_INTERVAL_WEEKS),
      byDay: z
        .array(weekdaySchema)
        .min(1)
        .max(7)
        .refine((days) => new Set(days).size === days.length, 'duplicate weekday'),
      time: localTimeSchema,
    })
    .refine((r) => r.until === null || r.until >= r.startDate, {
      message: 'until must not be before startDate',
      path: ['until'],
    }),
]);
export type SlotRule = z.infer<typeof slotRuleSchema>;

/** How far a moved occurrence may land from its original date, in days. */
export const SLOT_MAX_MOVE_DAYS = 7;

/**
 * A change to one occurrence, keyed by its original local `date` (its identity, kept when it
 * moves): cancelled, or moved to a new local start (at most `SLOT_MAX_MOVE_DAYS` away) with an
 * optional new duration (null: the slot's).
 */
export const slotExceptionSchema = z.discriminatedUnion('kind', [
  z.object({ date: localDateSchema, kind: z.literal('cancelled') }),
  z.object({
    date: localDateSchema,
    kind: z.literal('moved'),
    startDate: localDateSchema,
    startTime: localTimeSchema,
    durationMs: showDurationSchema.nullable(),
  }),
]);
export type SlotException = z.infer<typeof slotExceptionSchema>;

/** `PUT …/slots/:slotId/exceptions/:date`: body (the date is the path's). */
export const putSlotExceptionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cancelled') }),
  z.object({
    kind: z.literal('moved'),
    startDate: localDateSchema,
    startTime: localTimeSchema,
    durationMs: showDurationSchema.nullable().default(null),
  }),
]);
export type PutSlotException = z.input<typeof putSlotExceptionSchema>;

// --- Show --------------------------------------------------------------------------------

export const showHostSchema = z.object({ userId: uuidSchema, name: z.string() });
export type ShowHost = z.infer<typeof showHostSchema>;

const colourSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'colour like #1e90ff')
  .transform((c) => c.toLowerCase());
const showTagSchema = z.string().trim().min(1).max(50);

export const showSchema = z.object({
  id: uuidSchema,
  stationId: uuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  /** Square image, https. Uploading it to storage comes with the shows UI (#45). */
  artworkUrl: z.string().nullable(),
  /** `#rrggbb`, for the grid. */
  colour: z.string().nullable(),
  /** What new slots last when they don't say. */
  defaultDurationMs: z.int().nullable(),
  defaultSlotType: defaultSlotTypeSchema,
  tags: z.array(z.string()),
  /** Station or org members; presenters with `show:write_own` may edit the shows they host. */
  hosts: z.array(showHostSchema),
  /** What a new episode is numbered when it doesn't say: highest number + 1. */
  nextEpisodeNumber: z.int().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Show = z.infer<typeof showSchema>;

const showFields = {
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).nullable(),
  artworkUrl: z
    .url({ protocol: /^https$/ })
    .max(2000)
    .nullable(),
  colour: colourSchema.nullable(),
  defaultDurationMs: showDurationSchema.nullable(),
  defaultSlotType: defaultSlotTypeSchema,
  tags: z
    .array(showTagSchema)
    .max(50)
    .transform((tags) => [...new Set(tags)]),
  hostUserIds: z
    .array(uuidSchema)
    .max(20)
    .transform((ids) => [...new Set(ids)]),
};

export const createShowSchema = z.object({
  name: showFields.name,
  description: showFields.description.default(null),
  artworkUrl: showFields.artworkUrl.default(null),
  colour: showFields.colour.default(null),
  defaultDurationMs: showFields.defaultDurationMs.default(null),
  defaultSlotType: showFields.defaultSlotType.default('prerecorded'),
  tags: showFields.tags.default([]),
  hostUserIds: showFields.hostUserIds.default([]),
});
export type CreateShow = z.input<typeof createShowSchema>;

/** Hosts (`hostUserIds`) need `show:write`; the other fields `show:write_own` on a hosted show. */
export const updateShowSchema = patchOf(z.object(showFields));
export type UpdateShow = z.input<typeof updateShowSchema>;

export const showListSchema = z.object({ items: z.array(showSchema) });
export type ShowList = z.infer<typeof showListSchema>;

// --- Slot --------------------------------------------------------------------------------

export const showSlotSchema = z.object({
  id: uuidSchema,
  showId: uuidSchema,
  type: slotTypeSchema,
  rule: slotRuleSchema,
  /** Elapsed time: a 2 h slot airs 2 h even across a DST change (ADR 0012). */
  durationMs: z.int(),
  /** Ordered by date. */
  exceptions: z.array(slotExceptionSchema),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ShowSlot = z.infer<typeof showSlotSchema>;

/** `type` defaults to the show's `defaultSlotType`, `durationMs` to its `defaultDurationMs`. */
export const createShowSlotSchema = z.object({
  type: slotTypeSchema.optional(),
  rule: slotRuleSchema,
  durationMs: showDurationSchema.optional(),
});
export type CreateShowSlot = z.input<typeof createShowSlotSchema>;

/** Exceptions on dates the new rule no longer has are dropped. */
export const updateShowSlotSchema = patchOf(
  z.object({ type: slotTypeSchema, rule: slotRuleSchema, durationMs: showDurationSchema }),
);
export type UpdateShowSlot = z.input<typeof updateShowSlotSchema>;

export const showSlotListSchema = z.object({ items: z.array(showSlotSchema) });

// --- Episode -----------------------------------------------------------------------------

/**
 * - `planned`: expected, no audio yet (a live episode stays `planned` until it airs).
 * - `ready`: pre-recorded audio attached. Set automatically when an asset is attached.
 * - `aired`: went out (as-run, #30, sets it with `airedAt`).
 * - `missing`: its slot came and the audio wasn't there (#47).
 */
export const episodeStatusSchema = z.enum(['planned', 'ready', 'aired', 'missing']);
export type EpisodeStatus = z.infer<typeof episodeStatusSchema>;

/** `prerecorded`: plays an asset. `live`: made on air; its recording (#67) may become the asset. */
export const episodeKindSchema = z.enum(['prerecorded', 'live']);
export type EpisodeKind = z.infer<typeof episodeKindSchema>;

export const tracklistEntrySchema = z.object({
  artist: z.string().trim().max(500),
  title: z.string().trim().min(1).max(500),
  /** Offset into the episode, when known. */
  offsetMs: z.int().min(0).max(SHOW_MAX_DURATION_MS).nullable().default(null),
});
export type TracklistEntry = z.infer<typeof tracklistEntrySchema>;

export const episodeSchema = z.object({
  id: uuidSchema,
  showId: uuidSchema,
  /** Per show, from 1, unique; shared by live and pre-recorded episodes. */
  number: z.int().min(1),
  title: z.string().nullable(),
  description: z.string().nullable(),
  tracklist: z.array(tracklistEntrySchema),
  kind: episodeKindSchema,
  /** An `episode` asset of the station. Null while missing, or after the asset was deleted. */
  assetId: uuidSchema.nullable(),
  status: episodeStatusSchema,
  airedAt: z.date().nullable(),
  /**
   * The occurrence it premieres in: a slot of its show and the occurrence's original local
   * date. At most one episode per occurrence. `slotId` becomes null if the slot is deleted.
   */
  slotId: uuidSchema.nullable(),
  occurrenceDate: localDateSchema.nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Episode = z.infer<typeof episodeSchema>;

const occurrenceRef = {
  slotId: uuidSchema.nullable(),
  occurrenceDate: localDateSchema.nullable(),
};
const bothOrNeither = (e: { slotId?: string | null; occurrenceDate?: string | null }) =>
  (e.slotId === undefined) === (e.occurrenceDate === undefined) &&
  (e.slotId === null) === (e.occurrenceDate === null);
const bothOrNeitherIssue = {
  message: 'slotId and occurrenceDate go together',
  path: ['occurrenceDate'],
};

const episodeFields = {
  number: z.int().min(1).max(1_000_000),
  title: z.string().trim().min(1).max(500).nullable(),
  description: z.string().max(10_000).nullable(),
  tracklist: z.array(tracklistEntrySchema).max(500),
  kind: episodeKindSchema,
  assetId: uuidSchema.nullable(),
  status: episodeStatusSchema,
  airedAt: dateInputSchema.nullable(),
  ...occurrenceRef,
};

/**
 * `number` defaults to the show's next one. `kind` defaults to `live` for a live slot's
 * occurrence, else `prerecorded`. `status` defaults to `ready` with an asset, else `planned`.
 */
export const createEpisodeSchema = z
  .object({
    number: episodeFields.number.optional(),
    title: episodeFields.title.default(null),
    description: episodeFields.description.default(null),
    tracklist: episodeFields.tracklist.default([]),
    kind: episodeFields.kind.optional(),
    assetId: episodeFields.assetId.default(null),
    status: episodeFields.status.optional(),
    airedAt: episodeFields.airedAt.default(null),
    slotId: occurrenceRef.slotId.default(null),
    occurrenceDate: occurrenceRef.occurrenceDate.default(null),
  })
  .refine(bothOrNeither, bothOrNeitherIssue);
export type CreateEpisode = z.input<typeof createEpisodeSchema>;

/** Attaching or detaching the asset moves `planned` ↔ `ready` unless `status` is given. */
export const updateEpisodeSchema = patchOf(z.object(episodeFields)).refine(
  bothOrNeither,
  bothOrNeitherIssue,
);
export type UpdateEpisode = z.input<typeof updateEpisodeSchema>;

export const listEpisodesQuerySchema = z.object({ status: episodeStatusSchema.optional() });

/** Newest number first. */
export const episodeListSchema = z.object({ items: z.array(episodeSchema) });
export type EpisodeList = z.infer<typeof episodeListSchema>;

// --- Occurrences -------------------------------------------------------------------------

export const SHOW_OCCURRENCES_MAX_DAYS = 92;

/** `GET …/show-occurrences?from&to[&showId]`: at most 92 days. */
export const showOccurrencesQuerySchema = z
  .object({ from: dateInputSchema, to: dateInputSchema, showId: uuidSchema.optional() })
  .refine((q) => q.to > q.from, { message: 'to must be after from', path: ['to'] })
  .refine(
    (q) => q.to.getTime() - q.from.getTime() <= SHOW_OCCURRENCES_MAX_DAYS * 24 * 3600 * 1000,
    { message: 'range is longer than 92 days', path: ['to'] },
  );
export type ShowOccurrencesQuery = z.input<typeof showOccurrencesQuerySchema>;

export const occurrenceEpisodeSchema = episodeSchema.pick({
  id: true,
  number: true,
  title: true,
  kind: true,
  assetId: true,
  status: true,
});

export const showOccurrenceSchema = z.object({
  slotId: uuidSchema,
  /** The original local date: with `slotId`, the occurrence's identity. */
  date: localDateSchema,
  show: z.object({ id: uuidSchema, name: z.string(), colour: z.string().nullable() }),
  type: slotTypeSchema,
  startsAt: z.date(),
  endsAt: z.date(),
  durationMs: z.int(),
  /** Moved by an exception. */
  moved: z.boolean(),
  /** The episode planned for this occurrence, if any. */
  episode: occurrenceEpisodeSchema.nullable(),
});
export type ShowOccurrence = z.infer<typeof showOccurrenceSchema>;

const occurrenceKey = z.object({ slotId: uuidSchema, date: localDateSchema });

/** Two occurrences that share air time: `a` starts first. Overlaps are allowed, not hidden. */
export const showConflictSchema = z.object({
  a: occurrenceKey,
  b: occurrenceKey,
  startsAt: z.date(),
  endsAt: z.date(),
  overlapMs: z.int().positive(),
});
export type ShowConflict = z.infer<typeof showConflictSchema>;

export const showOccurrencesResponseSchema = z.object({
  timezone: z.string(),
  /** Ordered by start. */
  occurrences: z.array(showOccurrenceSchema),
  conflicts: z.array(showConflictSchema),
});
export type ShowOccurrencesResponse = z.infer<typeof showOccurrencesResponseSchema>;
