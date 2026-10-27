import { z } from 'zod';
import { zonedFields } from '../time/index.ts';
import {
  daypartCells,
  gridEndHourSchema,
  gridHourSchema,
  gridWeekdaySchema,
} from './clock-grid.ts';
import { assetTypeSchema, dateInputSchema } from './library.ts';
import { localDateSchema } from './log.ts';
import { uuidSchema } from './tenancy.ts';

// Promo VTs and VT pools (#60, ADR 0032). Mirrors packages/db/src/schema/promos.ts.
//
// A promo is a `vt` asset with airing rules: its validity is the asset's own `startAt`/`killAt`
// (never airs outside it), an optional link to a show or an event, a weight, a cap of plays per
// station-local day and dayparts. Promos are grouped in VT pools; a clock's `vt` slot in `promo`
// mode with a `poolId` asks the log generator for one promo of the pool there. The generator
// voices it over the transition between the song before the slot and the song after it, as a
// default segue (`defaultPromoLanes`, packages/shared/src/segues/promo.ts) that the segue editor
// can change later. Every placement is a `promo_placement` row: what is planned, what aired.

export const PROMO_MAX_WEIGHT = 100;
export const PROMO_MAX_PLAYS_PER_DAY = 1000;
export const PROMO_MAX_DAYPARTS = 21;
export const PROMO_MAX_POOLS = 50;

const nameSchema = z.string().trim().min(1).max(100);
const colorSchema = z.string().regex(/^#[0-9a-f]{6}$/, 'color like #a1b2c3');

// --- Dayparts ------------------------------------------------------------------------------

/**
 * When a promo may air, in station-local hours: like a grid daypart (ADR 0020) without a name.
 * `endHour <= startHour` runs past midnight into the next weekday; `startHour === endHour`
 * (or 0–24) is the whole day. No daypart: any time.
 */
export const promoDaypartSchema = z.object({
  /** ISO weekdays, sorted, distinct. */
  weekdays: z.array(gridWeekdaySchema),
  startHour: gridHourSchema,
  endHour: gridEndHourSchema,
});
/** A daypart as written: weekdays distinct (stored sorted), at least one. */
export const promoDaypartInputSchema = z.object({
  weekdays: z
    .array(gridWeekdaySchema)
    .min(1)
    .max(7)
    .refine((days) => new Set(days).size === days.length, 'duplicate weekday')
    .transform((days) => [...days].sort((a, b) => a - b)),
  startHour: gridHourSchema,
  endHour: gridEndHourSchema,
});
export type PromoDaypart = z.infer<typeof promoDaypartSchema>;

/**
 * Whether `at` falls in one of `dayparts`, read on the station's wall clock: the local weekday
 * and hour of the instant (so on DST nights the repeated hour counts twice, the skipped one
 * never). An empty list is any time.
 */
export function inDayparts(dayparts: readonly PromoDaypart[], at: Date, timeZone: string): boolean {
  if (dayparts.length === 0) return true;
  const f = zonedFields(at, timeZone);
  const weekday = ((new Date(Date.UTC(f.year, f.month - 1, f.day)).getUTCDay() + 6) % 7) + 1;
  return dayparts.some((d) =>
    daypartCells(d).some((cell) => cell.weekday === weekday && cell.hour === f.hour),
  );
}

/** Whether an asset's validity window `[startAt, killAt)` holds all of `[from, to)`. */
export function validThroughout(
  window: { startAt: Date | null; killAt: Date | null },
  from: Date,
  to: Date = from,
): boolean {
  if (window.startAt && from.getTime() < window.startAt.getTime()) return false;
  if (window.killAt && to.getTime() >= window.killAt.getTime()) return false;
  return true;
}

/**
 * How far from its transition (A's end) a promo's voice may start, either way. The default
 * segue keeps it there (`defaultPromoLanes`); a check that doesn't know the segue's own lanes
 * yet (the generator, a placement without its segue) assumes the voice anywhere within it.
 */
export const PROMO_MAX_LEAD_MS = 30_000;

/**
 * When a promo's voice is on air around a transition at `transitionAt`: exactly, from
 * `voiceStartMs` (its start on the segue axis, ms, 0 = A's end), or, without it, every time the
 * default segue could put it ({@link PROMO_MAX_LEAD_MS} either side, plus its length). The one
 * window the generator, the api's re-check and the feeder test validity against (ADR 0032).
 */
export function promoAirWindow(
  transitionAt: Date,
  voiceMs: number,
  voiceStartMs?: number,
): { from: Date; to: Date } {
  const t = transitionAt.getTime();
  if (voiceStartMs !== undefined) {
    return { from: new Date(t + voiceStartMs), to: new Date(t + voiceStartMs + voiceMs) };
  }
  return { from: new Date(t - PROMO_MAX_LEAD_MS), to: new Date(t + PROMO_MAX_LEAD_MS + voiceMs) };
}

/** Whether a promo with this validity may air over a transition at `transitionAt`. */
export function promoValidOnAir(
  validity: { startAt: Date | null; killAt: Date | null },
  transitionAt: Date,
  voiceMs: number,
  voiceStartMs?: number,
): boolean {
  const { from, to } = promoAirWindow(transitionAt, voiceMs, voiceStartMs);
  return validThroughout(validity, from, to);
}

/**
 * A voice's play length in ms: its cues (cue-out − cue-in, at the cues' rate), else the asset's
 * length, else 30 s. The same for every check.
 */
export function promoVoiceMs(asset: {
  durationMs: number | null;
  sampleRate: number | null;
  cueIn: number | null;
  cueOut: number | null;
}): number {
  if (asset.sampleRate && asset.cueOut !== null) {
    const length = asset.cueOut - (asset.cueIn ?? 0);
    if (length > 0) return Math.round((length * 1000) / asset.sampleRate);
  }
  return asset.durationMs ?? 30_000;
}

// --- VT pools ------------------------------------------------------------------------------

export const vtPoolSchema = z.object({
  id: uuidSchema,
  stationId: uuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  /** Promos in the pool (any status). */
  promoCount: z.int().min(0),
  /** Promos of the pool that can air now (enabled, within validity). */
  activeCount: z.int().min(0),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type VtPool = z.infer<typeof vtPoolSchema>;

export const vtPoolListSchema = z.object({ items: z.array(vtPoolSchema) });
export type VtPoolList = z.infer<typeof vtPoolListSchema>;

export const createVtPoolSchema = z.object({
  name: nameSchema,
  description: z.string().trim().max(2000).nullable().default(null),
  color: colorSchema.nullable().default(null),
});
export type CreateVtPool = z.input<typeof createVtPoolSchema>;

export const updateVtPoolSchema = z
  .object({
    name: nameSchema,
    description: z.string().trim().max(2000).nullable(),
    color: colorSchema.nullable(),
  })
  .partial()
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), 'empty update');
export type UpdateVtPool = z.input<typeof updateVtPoolSchema>;

// --- Promos --------------------------------------------------------------------------------

/**
 * Derived from now: `scheduled` (before `startAt`), `active`, `expired` (from `killAt` on),
 * `disabled` (switched off, whatever its dates).
 */
export const promoStatusSchema = z.enum(['scheduled', 'active', 'expired', 'disabled']);
export type PromoStatus = z.infer<typeof promoStatusSchema>;

export function promoStatus(
  promo: { enabled: boolean; startAt: Date | null; killAt: Date | null },
  now: Date,
): PromoStatus {
  if (!promo.enabled) return 'disabled';
  if (promo.killAt && now.getTime() >= promo.killAt.getTime()) return 'expired';
  if (promo.startAt && now.getTime() < promo.startAt.getTime()) return 'scheduled';
  return 'active';
}

/** Play counts. `planned` counts placements whose transition hasn't aired yet. */
export const promoPlayCountsSchema = z.object({
  /** Aired today (station-local day). */
  airedToday: z.int().min(0),
  /** Aired in the last 7 days. */
  aired7d: z.int().min(0),
  airedTotal: z.int().min(0),
  /** Planned from now on, in the generated log. */
  planned: z.int().min(0),
  lastAiredAt: z.date().nullable(),
});
export type PromoPlayCounts = z.infer<typeof promoPlayCountsSchema>;

export const promoSchema = z.object({
  id: uuidSchema,
  stationId: uuidSchema,
  assetId: uuidSchema,
  /** The asset, as the list shows it. */
  title: z.string(),
  assetType: assetTypeSchema,
  durationMs: z.int().nullable(),
  /** The asset's validity (`asset.start_at` / `asset.kill_at`). */
  startAt: z.date().nullable(),
  killAt: z.date().nullable(),
  showId: uuidSchema.nullable(),
  showName: z.string().nullable(),
  eventName: z.string().nullable(),
  eventAt: z.date().nullable(),
  weight: z.int().min(1).max(PROMO_MAX_WEIGHT),
  maxPlaysPerDay: z.int().min(1).max(PROMO_MAX_PLAYS_PER_DAY).nullable(),
  dayparts: z.array(promoDaypartSchema),
  poolIds: z.array(uuidSchema),
  enabled: z.boolean(),
  status: promoStatusSchema,
  plays: promoPlayCountsSchema,
  /** Bumped on every save; send it back on `PATCH` to refuse overwriting a newer edit. */
  version: z.int().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Promo = z.infer<typeof promoSchema>;

export const promoListSchema = z.object({ items: z.array(promoSchema) });
export type PromoList = z.infer<typeof promoListSchema>;

export const listPromosQuerySchema = z.object({
  poolId: uuidSchema.optional(),
  status: promoStatusSchema.optional(),
});
export type ListPromosQuery = z.input<typeof listPromosQuerySchema>;

const promoFields = {
  showId: uuidSchema.nullable(),
  eventName: z.string().trim().min(1).max(200).nullable(),
  eventAt: dateInputSchema.nullable(),
  weight: z.int().min(1).max(PROMO_MAX_WEIGHT),
  maxPlaysPerDay: z.int().min(1).max(PROMO_MAX_PLAYS_PER_DAY).nullable(),
  dayparts: z.array(promoDaypartInputSchema).max(PROMO_MAX_DAYPARTS),
  poolIds: z
    .array(uuidSchema)
    .max(PROMO_MAX_POOLS)
    .refine((ids) => new Set(ids).size === ids.length, 'duplicate pool'),
  enabled: z.boolean(),
  /** Written to the asset (`startAt` / `killAt`): a promo's validity is its asset's. */
  startAt: dateInputSchema.nullable(),
  killAt: dateInputSchema.nullable(),
};

function killAfterStart(p: { startAt?: Date | null; killAt?: Date | null }): boolean {
  return !p.startAt || !p.killAt || p.killAt > p.startAt;
}

/** `POST …/promos`: makes a `vt` asset of the station a promo (one promo per asset). */
export const createPromoSchema = z
  .object({
    assetId: uuidSchema,
    showId: promoFields.showId.default(null),
    eventName: promoFields.eventName.default(null),
    eventAt: promoFields.eventAt.default(null),
    weight: promoFields.weight.default(1),
    maxPlaysPerDay: promoFields.maxPlaysPerDay.default(null),
    dayparts: promoFields.dayparts.default([]),
    poolIds: promoFields.poolIds.default([]),
    enabled: promoFields.enabled.default(true),
    startAt: promoFields.startAt.optional(),
    killAt: promoFields.killAt.optional(),
  })
  .refine(killAfterStart, { message: 'killAt must be after startAt', path: ['killAt'] });
export type CreatePromo = z.input<typeof createPromoSchema>;

/** `PATCH …/promos/:promoId`. With `version`, a save over a newer version is a 409. */
export const updatePromoSchema = z
  .object({ ...promoFields, version: z.int().min(1) })
  .partial()
  .refine(killAfterStart, { message: 'killAt must be after startAt', path: ['killAt'] })
  .refine(
    (patch) => Object.entries(patch).some(([k, v]) => k !== 'version' && v !== undefined),
    'empty update',
  );
export type UpdatePromo = z.input<typeof updatePromoSchema>;

// --- Placements and plays ------------------------------------------------------------------

/**
 * A promo the generator placed (`promo_placement`):
 * - `pending`: written with the day, its default segue not created yet;
 * - `placed`: its segue exists (the segue editor can change it);
 * - `dropped`: it will not air: its transition went away (regenerated, edited) or the promo
 *   expired, was disabled or left the pool before its segue was made.
 */
export const promoPlacementStatusSchema = z.enum(['pending', 'placed', 'dropped']);
export type PromoPlacementStatus = z.infer<typeof promoPlacementStatusSchema>;

/** One play of a promo: planned (a placement) or aired (an as-run entry). */
export const promoPlaySchema = z.object({
  kind: z.enum(['planned', 'aired']),
  /** Planned: the transition's planned time; aired: when the voice went on air. */
  playedAt: z.date(),
  /** The station-local date it belongs to (the log day, for a planned one). */
  localDate: localDateSchema,
  placementId: uuidSchema.nullable(),
  placementStatus: promoPlacementStatusSchema.nullable(),
  /** The songs around it (A, B), while still in the log: the segue editor's transition. */
  fromItemId: uuidSchema.nullable(),
  toItemId: uuidSchema.nullable(),
  segueId: uuidSchema.nullable(),
  asRunEntryId: uuidSchema.nullable(),
  /** Why a placement was dropped. */
  detail: z.string().nullable(),
});
export type PromoPlay = z.infer<typeof promoPlaySchema>;

/** The longest range `GET …/promos/:id/plays` answers, in days. */
export const PROMO_PLAYS_MAX_DAYS = 92;

export const promoPlaysQuerySchema = z.object({
  /**
   * Station-local dates, inclusive, at most {@link PROMO_PLAYS_MAX_DAYS} days. Default: the last
   * 7 days to 7 days ahead.
   */
  from: localDateSchema.optional(),
  to: localDateSchema.optional(),
});
export type PromoPlaysQuery = z.input<typeof promoPlaysQuerySchema>;

export const promoPlaysSchema = z.object({
  promoId: uuidSchema,
  from: localDateSchema,
  to: localDateSchema,
  items: z.array(promoPlaySchema),
  /** Aired plays per station-local date. */
  airedByDay: z.array(z.object({ date: localDateSchema, count: z.int().min(0) })),
});
export type PromoPlays = z.infer<typeof promoPlaysSchema>;
