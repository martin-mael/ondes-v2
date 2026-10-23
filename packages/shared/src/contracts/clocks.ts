import { z } from 'zod';
import { type AssetType, assetTypeSchema } from './library.ts';
import type { LogItemKind } from './log.ts';
import { uuidSchema } from './tenancy.ts';

// Clocks (#39): the template of an hour (or part of one), as an ordered list of slots with
// nominal durations. Mirrors packages/db/src/schema/clocks.ts. The weekly grid (#40) places
// clocks; the log generator (#50) expands each slot into log items (`logKindForSlot`), with
// `origin: { type: 'clock', clockId, slotIndex }`, `slotIndex` being the slot's position.
//
// Timing is in integer milliseconds from the clock's start. `estimateClock` is the one place
// that turns slots into a timeline: the api uses it with category averages, the preview with
// the picked assets, the editor with the same numbers as the api. New slot kinds are added to
// the union; existing ones keep their shape.

/** Default length: an hour clock. */
export const CLOCK_DEFAULT_DURATION_MS = 3_600_000;
/** A clock covers at least a minute and at most six hours (partial clocks are shorter). */
export const CLOCK_MIN_DURATION_MS = 60_000;
export const CLOCK_MAX_DURATION_MS = 6 * 3_600_000;
export const CLOCK_MAX_SLOTS = 200;
/** Over- or under-filled by more than this, the clock gets a warning. */
export const CLOCK_TOLERANCE_MS = 30_000;
/** Nominal length of a "record later" voice-track placeholder without a duration. */
export const VT_PLACEHOLDER_MS = 30_000;

/**
 * What a slot schedules.
 * - `category`: a pick from a music category.
 * - `asset`: one specific asset (a fixed item: a sponsor message, a programme intro…).
 * - `vt`: a voice track, either picked from a promo VT category (`promo`) or recorded later
 *   by a presenter (`placeholder`, #54).
 * - `jingle`: a station ID or jingle, picked from a category of jingles.
 * - `marker`: a zero-length timing point at `offsetMs` from the clock's start (top of the
 *   hour, "news at :30"), with the log's timing semantics (`hard`, `soft`, `not_before`).
 * - `fill`: elastic filler. Without a duration, it stretches to the next marker (or the end
 *   of the clock); the generator back-times it (#46), from its category if it has one.
 * - `live`: a window handed to a live presenter.
 */
export const clockSlotKindSchema = z.enum([
  'category',
  'asset',
  'vt',
  'jingle',
  'marker',
  'fill',
  'live',
]);
export type ClockSlotKind = z.infer<typeof clockSlotKindSchema>;

export const vtSlotModeSchema = z.enum(['promo', 'placeholder']);
export type VtSlotMode = z.infer<typeof vtSlotModeSchema>;

/** The log's anchored timings (`flow` is every other slot). */
export const markerTimingSchema = z.enum(['hard', 'soft', 'not_before']);
export type MarkerTiming = z.infer<typeof markerTimingSchema>;

const offsetMs = z.int().min(0).max(CLOCK_MAX_DURATION_MS);

/**
 * Fields every slot has. `durationMs` is the nominal length; `null` lets the estimate use the
 * category's average (or the asset's length). References (`categoryId`, `assetId`) may be
 * `null`: not chosen yet, or the category or asset was deleted since. The clock then carries
 * a `missing_reference` warning instead of failing.
 */
const slotBase = {
  /** A free note shown in the editor and the log ("Morning news", "Sponsor"). */
  label: z.string().trim().max(200).nullable().default(null),
  durationMs: z.int().min(0).max(CLOCK_MAX_DURATION_MS).nullable().default(null),
};
const ref = uuidSchema.nullable().default(null);

export const categorySlotSchema = z.object({
  kind: z.literal('category'),
  ...slotBase,
  categoryId: ref,
});
export const assetSlotSchema = z.object({ kind: z.literal('asset'), ...slotBase, assetId: ref });
export const vtSlotSchema = z.object({
  kind: z.literal('vt'),
  ...slotBase,
  mode: vtSlotModeSchema.default('placeholder'),
  /** `promo` only, without `poolId`: a category of `vt` assets, picked like music. */
  categoryId: ref,
  /**
   * `promo` only: the VT pool (#60) whose promos the generator voices over the transition
   * between the songs around the slot. Takes precedence over `categoryId`. Absent (or null):
   * none.
   */
  poolId: uuidSchema.nullable().optional(),
});
export const jingleSlotSchema = z.object({
  kind: z.literal('jingle'),
  ...slotBase,
  categoryId: ref,
});
export const markerSlotSchema = z.object({
  kind: z.literal('marker'),
  ...slotBase,
  timing: markerTimingSchema.default('hard'),
  /** From the clock's start: `0` is the top of the hour, `1_800_000` half past. */
  offsetMs,
  /** `soft` only: how late after `offsetMs` the next item may start. */
  capMs: z.int().min(0).max(3_600_000).nullable().default(null),
});
export const fillSlotSchema = z.object({ kind: z.literal('fill'), ...slotBase, categoryId: ref });
export const liveSlotSchema = z.object({ kind: z.literal('live'), ...slotBase });

export const clockSlotSchema = z.discriminatedUnion('kind', [
  categorySlotSchema,
  assetSlotSchema,
  vtSlotSchema,
  jingleSlotSchema,
  markerSlotSchema,
  fillSlotSchema,
  liveSlotSchema,
]);
export type ClockSlot = z.infer<typeof clockSlotSchema>;
export type ClockSlotInput = z.input<typeof clockSlotSchema>;

/**
 * The category a slot picks from, if its kind picks from one. The only category a slot keeps:
 * a placeholder VT's `categoryId` is dropped when stored.
 */
export function slotCategoryId(slot: ClockSlot): string | null {
  switch (slot.kind) {
    case 'category':
    case 'jingle':
    case 'fill':
      return slot.categoryId;
    case 'vt':
      return slot.mode === 'promo' && !slot.poolId ? slot.categoryId : null;
    default:
      return null;
  }
}

/** The VT pool a `promo` slot draws from (#60), if any. */
export function slotPoolId(slot: ClockSlot): string | null {
  return slot.kind === 'vt' && slot.mode === 'promo' ? (slot.poolId ?? null) : null;
}

/** The asset type a slot's category should hold; `null` when any type goes. */
export function expectedAssetType(slot: ClockSlot): AssetType | null {
  switch (slot.kind) {
    case 'jingle':
      return 'jingle';
    case 'vt':
      return 'vt';
    default:
      return null;
  }
}

/**
 * The log item kind a slot becomes (#50). Slots that pick an asset (`category`, `asset`)
 * follow the asset's type; `null` when that type has no log kind of its own (`other`).
 */
export function logKindForSlot(kind: ClockSlotKind, assetType?: AssetType): LogItemKind | null {
  switch (kind) {
    case 'vt':
      return 'vt';
    case 'jingle':
      return 'jingle';
    case 'marker':
      return 'marker';
    case 'fill':
      return 'fill';
    case 'live':
      return 'live_slot';
    case 'category':
    case 'asset':
      return assetType && assetType !== 'other' ? assetType : null;
  }
}

// --- Clock ---------------------------------------------------------------------------------

const nameSchema = z.string().trim().min(1).max(100);
const colorSchema = z.string().regex(/^#[0-9a-f]{6}$/, 'color like #a1b2c3');
const targetSchema = z.int().min(CLOCK_MIN_DURATION_MS).max(CLOCK_MAX_DURATION_MS);
const slotsSchema = z.array(clockSlotSchema).max(CLOCK_MAX_SLOTS);

// --- Estimate ------------------------------------------------------------------------------

/**
 * Where a slot's estimated length comes from: its `nominal` duration, its category's
 * `average`, the `asset`'s length, a `default` (VT placeholder), a `fill` stretched to the
 * next anchor, a `marker` (always 0), or `unknown` (counted as 0, with a warning).
 */
export const slotDurationSourceSchema = z.enum([
  'nominal',
  'average',
  'asset',
  'default',
  'fill',
  'marker',
  'unknown',
]);
export type SlotDurationSource = z.infer<typeof slotDurationSourceSchema>;

export const slotEstimateSchema = z.object({
  startMs: z.int(),
  durationMs: z.int().min(0),
  source: slotDurationSourceSchema,
});
export type SlotEstimate = z.infer<typeof slotEstimateSchema>;

/**
 * A problem with a clock. None blocks saving: a programmer builds a clock step by step.
 * - `over_target` / `under_target`: the slots end `ms` after or before the target length
 *   (beyond `CLOCK_TOLERANCE_MS`).
 * - `overrun`: the slots before a `hard` or `soft` marker end `ms` after it (after its cap).
 * - `gap`: they end `ms` before a marker and no fill takes up the slack.
 * - `marker_order`: a marker is earlier than a marker before it.
 * - `marker_beyond_target`: a marker is after the end of the clock.
 * - `missing_reference`: no category or asset chosen, or it was deleted.
 * - `wrong_asset_type`: a jingle or promo VT slot points at a category of another type.
 * - `unknown_duration`: no length to go by (empty category, asset or live slot without one).
 * - `unsupported_asset_type`: a category or asset slot holds `other` assets, which have no log
 *   item kind (`logKindForSlot`): the generator can't place them.
 */
export const clockWarningCodeSchema = z.enum([
  'over_target',
  'under_target',
  'overrun',
  'gap',
  'marker_order',
  'marker_beyond_target',
  'missing_reference',
  'wrong_asset_type',
  'unknown_duration',
  'unsupported_asset_type',
]);
export type ClockWarningCode = z.infer<typeof clockWarningCodeSchema>;

export const clockWarningSchema = z.object({
  code: clockWarningCodeSchema,
  /** The slot concerned; absent for whole-clock warnings. */
  slotIndex: z.int().min(0).optional(),
  ms: z.int().positive().optional(),
});
export type ClockWarning = z.infer<typeof clockWarningSchema>;

export const clockEstimateSchema = z.object({
  /** One per slot, in order. */
  slots: z.array(slotEstimateSchema),
  /** When the last slot ends. */
  totalMs: z.int().min(0),
  targetMs: z.int(),
  warnings: z.array(clockWarningSchema),
});
export type ClockEstimate = z.infer<typeof clockEstimateSchema>;

/** What the estimate needs to know about a slot's category or asset. */
export interface SlotReference {
  /** The category or asset exists in the station. */
  exists: boolean;
  /** Average member length (category) or length (asset); `null` if unknown. */
  durationMs: number | null;
  /** The category's asset type (or the asset's). */
  assetType: AssetType | null;
}

/**
 * The clock's timeline: when each slot starts and how long it lasts, plus its warnings. Pure.
 * `refs(slot, index)` describes the slot's category or asset (`undefined` for slots without
 * one). Markers anchor the timeline like the log does: `hard` jumps to its offset, `soft`
 * waits for it (late up to its cap), `not_before` waits for it but is never an overrun.
 * Unsized fills share the slack before the next marker, or before the end of the clock.
 */
export function estimateClock(
  clock: { targetDurationMs: number; slots: readonly ClockSlot[] },
  refs: (slot: ClockSlot, index: number) => SlotReference | undefined,
): ClockEstimate {
  const { slots, targetDurationMs: target } = clock;
  const warnings: ClockWarning[] = [];
  const base: { durationMs: number; source: SlotDurationSource }[] = slots.map((slot, i) => {
    if (slot.kind === 'marker') return { durationMs: 0, source: 'marker' };
    const ref = slot.kind === 'live' ? undefined : refs(slot, i);
    const wantsRef =
      slot.kind === 'category' ||
      slot.kind === 'asset' ||
      slot.kind === 'jingle' ||
      (slot.kind === 'fill' && slot.categoryId !== null) ||
      (slot.kind === 'vt' && slot.mode === 'promo');
    if (wantsRef && !ref?.exists) warnings.push({ code: 'missing_reference', slotIndex: i });
    const expected = expectedAssetType(slot);
    if (ref?.exists && expected && ref.assetType !== expected) {
      warnings.push({ code: 'wrong_asset_type', slotIndex: i });
    }
    if (
      ref?.exists &&
      (slot.kind === 'category' || slot.kind === 'asset') &&
      logKindForSlot(slot.kind, ref.assetType ?? undefined) === null
    ) {
      warnings.push({ code: 'unsupported_asset_type', slotIndex: i });
    }
    if (slot.durationMs !== null) return { durationMs: slot.durationMs, source: 'nominal' };
    if (slot.kind === 'fill') return { durationMs: 0, source: 'fill' };
    if (slot.kind === 'vt' && slot.mode === 'placeholder') {
      return { durationMs: VT_PLACEHOLDER_MS, source: 'default' };
    }
    // A pool's promo is voiced over a transition (#60): it takes no time of its own.
    if (slotPoolId(slot) !== null) return { durationMs: 0, source: 'default' };
    if (ref?.exists && ref.durationMs !== null) {
      return {
        durationMs: Math.round(ref.durationMs),
        source: slot.kind === 'asset' ? 'asset' : 'average',
      };
    }
    if (!wantsRef || ref?.exists) warnings.push({ code: 'unknown_duration', slotIndex: i });
    return { durationMs: 0, source: 'unknown' };
  });

  const out: SlotEstimate[] = [];
  let cursor = 0;
  let lastMarkerOffset = -1;
  let sectionStart = 0;
  while (sectionStart <= slots.length) {
    // A section runs up to the next marker (or the end of the clock), which is its anchor.
    let end = sectionStart;
    while (end < slots.length && slots[end]?.kind !== 'marker') end++;
    const marker = slots[end];
    const anchor = marker?.kind === 'marker' ? marker.offsetMs : target;
    const section = base.slice(sectionStart, end);
    const fixed = section.reduce((sum, s) => sum + s.durationMs, 0);
    const fills = section.filter((s) => s.source === 'fill').length;
    const slack = Math.max(0, anchor - cursor - fixed);
    const share = fills > 0 ? Math.floor(slack / fills) : 0;
    let spare = fills > 0 ? slack - share * fills : 0;
    for (let i = sectionStart; i < end; i++) {
      const s = base[i] as (typeof base)[number];
      let durationMs = s.durationMs;
      if (s.source === 'fill') {
        durationMs = share + spare;
        spare = 0;
      }
      out.push({ startMs: cursor, durationMs, source: s.source });
      cursor += durationMs;
    }
    if (marker?.kind !== 'marker') break;

    if (marker.offsetMs < lastMarkerOffset) warnings.push({ code: 'marker_order', slotIndex: end });
    if (marker.offsetMs > target) {
      warnings.push({ code: 'marker_beyond_target', slotIndex: end });
    }
    lastMarkerOffset = Math.max(lastMarkerOffset, marker.offsetMs);
    const arrive = cursor;
    const late = arrive - marker.offsetMs;
    if (late < 0) {
      warnings.push({ code: 'gap', slotIndex: end, ms: -late });
      cursor = marker.offsetMs;
    } else if (marker.timing === 'hard') {
      if (late > 0) warnings.push({ code: 'overrun', slotIndex: end, ms: late });
      cursor = marker.offsetMs;
    } else if (marker.timing === 'soft') {
      const over = late - (marker.capMs ?? 0);
      if (over > 0) warnings.push({ code: 'overrun', slotIndex: end, ms: over });
    }
    out.push({ startMs: cursor, durationMs: 0, source: 'marker' });
    sectionStart = end + 1;
  }

  const diff = cursor - target;
  if (diff > CLOCK_TOLERANCE_MS) warnings.push({ code: 'over_target', ms: diff });
  if (diff < -CLOCK_TOLERANCE_MS) warnings.push({ code: 'under_target', ms: -diff });
  warnings.sort((a, b) => (a.slotIndex ?? -1) - (b.slotIndex ?? -1));
  return { slots: out, totalMs: cursor, targetMs: target, warnings };
}

// --- Clock DTOs ----------------------------------------------------------------------------

export const clockSchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  stationId: uuidSchema,
  /** Unique in the station, case-insensitively. */
  name: z.string(),
  description: z.string().nullable(),
  /** Shown on the weekly grid. Slots take their category's colour. */
  color: z.string().nullable(),
  /** How long the clock should last: an hour, or less for a partial clock. */
  targetDurationMs: z.int(),
  slots: z.array(clockSlotSchema),
  /** Bumped on every save; `PATCH` sends the version it edited (optimistic concurrency). */
  version: z.int().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Clock = z.infer<typeof clockSchema>;

/** A clock with its timeline estimated from category averages and asset lengths. */
export const clockDetailSchema = clockSchema.extend({ estimate: clockEstimateSchema });
export type ClockDetail = z.infer<typeof clockDetailSchema>;

export const clockListSchema = z.object({ items: z.array(clockDetailSchema) });
export type ClockList = z.infer<typeof clockListSchema>;

const clockFields = {
  name: nameSchema,
  description: z.string().trim().max(2000).nullable(),
  color: colorSchema.nullable(),
  targetDurationMs: targetSchema,
  /** Replaces the slot list; order is play order. */
  slots: slotsSchema,
};

export const createClockSchema = z.object({
  name: clockFields.name,
  description: clockFields.description.optional(),
  color: clockFields.color.optional(),
  targetDurationMs: clockFields.targetDurationMs.default(CLOCK_DEFAULT_DURATION_MS),
  slots: clockFields.slots.default([]),
});
export type CreateClock = z.input<typeof createClockSchema>;

/**
 * `PATCH …/clocks/:id`. `version` is the clock's version the edit is based on; when the clock
 * changed since, the api answers 409 `edit_conflict` and saves nothing.
 */
export const updateClockSchema = z
  .object({ version: z.int().min(1), ...clockFields })
  .partial({
    name: true,
    description: true,
    color: true,
    targetDurationMs: true,
    slots: true,
  })
  .refine(
    ({ version: _, ...patch }) => Object.values(patch).some((v) => v !== undefined),
    'empty update',
  );
export type UpdateClock = z.input<typeof updateClockSchema>;

/** `POST …/clocks/:id/duplicate`. Without a name, the copy is named after the original. */
export const duplicateClockSchema = z.object({ name: nameSchema.optional() });
export type DuplicateClock = z.input<typeof duplicateClockSchema>;

// --- Preview -------------------------------------------------------------------------------

/**
 * Who filled a preview item: #38's `rules` picker, a `random` member of the category (before
 * the picker exists, or without one), or `fixed` (the slot names its asset).
 */
export const previewPickSourceSchema = z.enum(['rules', 'random', 'fixed']);
export type PreviewPickSource = z.infer<typeof previewPickSourceSchema>;

export const clockPreviewAssetSchema = z.object({
  id: uuidSchema,
  type: assetTypeSchema,
  title: z.string(),
  artists: z.array(z.string()),
  durationMs: z.int().nullable(),
});
export type ClockPreviewAsset = z.infer<typeof clockPreviewAssetSchema>;

export const clockPreviewItemSchema = z.object({
  slotIndex: z.int().min(0),
  kind: clockSlotKindSchema,
  startMs: z.int(),
  durationMs: z.int().min(0),
  /** The picked asset; `null` for slots without media, or when nothing could be picked. */
  asset: clockPreviewAssetSchema.nullable(),
  source: previewPickSourceSchema.nullable(),
  /** `empty_category`: the slot's category had nothing schedulable left to pick. */
  problem: z.enum(['empty_category']).nullable(),
  /** Scheduling rules #38's picker relaxed to fill this item. */
  relaxedRules: z.array(z.string()),
});
export type ClockPreviewItem = z.infer<typeof clockPreviewItemSchema>;

export const clockPreviewSchema = z.object({
  items: z.array(clockPreviewItemSchema),
  /** The sample hour's timing, from the picked assets' real lengths. */
  estimate: clockEstimateSchema,
  /** When the sample hour would air: what the picks were made for (windows, rules). */
  airsAt: z.date(),
  seed: z.string(),
});
export type ClockPreview = z.infer<typeof clockPreviewSchema>;

const previewOptions = {
  /** When the sample hour would air; defaults to now. */
  at: z.coerce.date().optional(),
  /** Same seed, same library: same random picks. Defaults to a fresh one. */
  seed: z.string().trim().min(1).max(64).optional(),
};

/** `GET …/clocks/:id/preview` query string. */
export const clockPreviewQuerySchema = z.object(previewOptions);
export type ClockPreviewQuery = z.input<typeof clockPreviewQuerySchema>;

/** `POST …/clocks/preview`: an unsaved clock (the editor's preview). */
export const draftClockPreviewSchema = z.object({
  targetDurationMs: clockFields.targetDurationMs.default(CLOCK_DEFAULT_DURATION_MS),
  slots: clockFields.slots,
  ...previewOptions,
});
export type DraftClockPreview = z.input<typeof draftClockPreviewSchema>;

/** `POST …/clocks/estimate`: the editor's live timeline for an unsaved clock. */
export const draftClockEstimateSchema = z.object({
  targetDurationMs: clockFields.targetDurationMs.default(CLOCK_DEFAULT_DURATION_MS),
  slots: clockFields.slots,
});
export type DraftClockEstimate = z.input<typeof draftClockEstimateSchema>;
