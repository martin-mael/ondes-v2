import { z } from 'zod';
import { localDateSchema } from './log.ts';
import { uuidSchema } from './tenancy.ts';

// Weekly clock grid (#40, ADR 0020): which clock airs in each station-local hour of the week.
// Mirrors the grid tables in packages/db/src/schema/clocks.ts. Resolution (override, then the
// weekly cell, then the default clock) is `resolveClockAt` / `expandGrid` in
// @ondes/scheduling; the log generator (#50) reads the grid through them.
//
// Hours are station-local wall-clock hours: `weekday` is ISO (1 = Monday … 7 = Sunday), `hour`
// 0–23. What happens to the hour that doesn't exist or happens twice on DST nights is decided by
// `expandGrid` (ADR 0020), not stored.

export const GRID_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const GRID_HOURS_PER_DAY = 24;

export const gridWeekdaySchema = z.int().min(1).max(7);
export const gridHourSchema = z.int().min(0).max(23);
/** End of an hour range, exclusive: 24 is midnight at the end of the day. */
export const gridEndHourSchema = z.int().min(1).max(24);

/** One painted hour of the week. Hours without a cell air the default clock. */
export const gridCellSchema = z.object({
  weekday: gridWeekdaySchema,
  hour: gridHourSchema,
  clockId: uuidSchema,
});
export type GridCell = z.infer<typeof gridCellSchema>;

const nameSchema = z.string().trim().min(1).max(100);

// --- Dayparts ------------------------------------------------------------------------------

/**
 * A named range of hours on some weekdays ("Morning", weekdays 06–10), used to paint the grid
 * in bulk. It doesn't schedule anything itself. `endHour <= startHour` runs past midnight: the
 * hours after midnight belong to the next day (Monday 22–06 covers Monday 22:00 to Tuesday
 * 06:00).
 */
export const daypartSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  weekdays: z.array(gridWeekdaySchema),
  startHour: gridHourSchema,
  endHour: gridEndHourSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Daypart = z.infer<typeof daypartSchema>;

const daypartFields = {
  name: nameSchema,
  /** Distinct weekdays, at least one. */
  weekdays: z
    .array(gridWeekdaySchema)
    .min(1)
    .max(7)
    .refine((days) => new Set(days).size === days.length, 'duplicate weekday')
    .transform((days) => [...days].sort((a, b) => a - b)),
  startHour: gridHourSchema,
  endHour: gridEndHourSchema,
};

export const createDaypartSchema = z.object(daypartFields);
export type CreateDaypart = z.input<typeof createDaypartSchema>;

export const updateDaypartSchema = z
  .object(daypartFields)
  .partial()
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), 'empty update');
export type UpdateDaypart = z.input<typeof updateDaypartSchema>;

/**
 * The weekly hours a daypart covers, in order. A range past midnight spills into the next
 * weekday (Sunday spills into Monday). A range with `startHour === endHour` covers the whole
 * day (`0–24` is how the editor writes it).
 */
export function daypartCells(daypart: {
  weekdays: readonly number[];
  startHour: number;
  endHour: number;
}): { weekday: number; hour: number }[] {
  const length = (daypart.endHour - daypart.startHour + 24) % 24 || 24;
  const seen = new Set<string>();
  const out: { weekday: number; hour: number }[] = [];
  for (const weekday of daypart.weekdays) {
    for (let i = 0; i < length; i++) {
      const h = daypart.startHour + i;
      const cell = { weekday: ((weekday - 1 + Math.floor(h / 24)) % 7) + 1, hour: h % 24 };
      const key = `${cell.weekday}:${cell.hour}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cell);
    }
  }
  return out.sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);
}

// --- Overrides -----------------------------------------------------------------------------

/**
 * A date-range exception to the weekly grid (a holiday, a special week): on every station-local
 * date from `startsOn` to `endsOn` (inclusive), the hours `[startHour, endHour)` air `clockId`
 * (a clock used by an override can't be deleted). When overrides overlap, the one with the fewest days wins, then the one
 * that starts later, then the one created last (ADR 0020).
 */
export const gridOverrideSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  startsOn: localDateSchema,
  endsOn: localDateSchema,
  startHour: gridHourSchema,
  endHour: gridEndHourSchema,
  clockId: uuidSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type GridOverride = z.infer<typeof gridOverrideSchema>;

/** Longest override: a year and a day. */
export const GRID_OVERRIDE_MAX_DAYS = 366;

const overrideFields = {
  name: nameSchema,
  startsOn: localDateSchema,
  endsOn: localDateSchema,
  startHour: gridHourSchema,
  endHour: gridEndHourSchema,
  clockId: uuidSchema,
};

const overrideRange = (o: {
  startsOn?: string;
  endsOn?: string;
  startHour?: number;
  endHour?: number;
}) =>
  (o.startsOn === undefined || o.endsOn === undefined || o.startsOn <= o.endsOn) &&
  (o.startHour === undefined || o.endHour === undefined || o.startHour < o.endHour);

export const createGridOverrideSchema = z
  .object({
    ...overrideFields,
    startHour: overrideFields.startHour.default(0),
    endHour: overrideFields.endHour.default(24),
  })
  .refine(overrideRange, 'empty range');
export type CreateGridOverride = z.input<typeof createGridOverrideSchema>;

/** Both ends of a range are checked together by the api against the stored row. */
export const updateGridOverrideSchema = z
  .object(overrideFields)
  .partial()
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), 'empty update')
  .refine(overrideRange, 'empty range');
export type UpdateGridOverride = z.input<typeof updateGridOverrideSchema>;

// --- Grid ----------------------------------------------------------------------------------

/** `GET …/clock-grid`: the station's whole grid, its dayparts and overrides. */
export const clockGridSchema = z.object({
  /** Airs in every hour without a cell (and without an override). `null`: none chosen yet. */
  defaultClockId: uuidSchema.nullable(),
  /** Painted hours, sorted by weekday then hour. */
  cells: z.array(gridCellSchema),
  /** Bumped on every save of the cells or the default; `PUT` sends the version it edited. */
  version: z.int().min(0),
  dayparts: z.array(daypartSchema),
  /** Sorted by `startsOn`. */
  overrides: z.array(gridOverrideSchema),
  /** The station's timezone: every hour above is a wall-clock hour there. */
  timezone: z.string(),
});
export type ClockGridDto = z.infer<typeof clockGridSchema>;

/**
 * `PUT …/clock-grid`: replaces the cells and the default clock. `version` is the grid version
 * the edit is based on; when the grid changed since, the api answers 409 `edit_conflict`. A
 * grid without a default clock must paint all 168 hours, or the api answers 400
 * `incomplete_grid`: a saved grid gives every hour exactly one clock (ADR 0020).
 */
export const updateClockGridSchema = z.object({
  version: z.int().min(0),
  defaultClockId: uuidSchema.nullable(),
  cells: z
    .array(gridCellSchema)
    .max(7 * GRID_HOURS_PER_DAY)
    .refine(
      (cells) => new Set(cells.map((c) => `${c.weekday}:${c.hour}`)).size === cells.length,
      'one clock per hour',
    ),
});
export type UpdateClockGrid = z.input<typeof updateClockGridSchema>;

// --- Resolved hours ------------------------------------------------------------------------

export const gridHourSourceSchema = z.enum(['override', 'grid', 'default', 'none']);
export type GridHourSource = z.infer<typeof gridHourSourceSchema>;

/** One real hour of the station's time, as `expandGrid` resolves it. */
export const resolvedGridHourSchema = z.object({
  date: localDateSchema,
  hour: gridHourSchema,
  startsAt: z.date(),
  endsAt: z.date(),
  /** The second run of an hour that happens twice (the night the clocks go back). */
  repeated: z.boolean(),
  clockId: uuidSchema.nullable(),
  source: gridHourSourceSchema,
  overrideId: uuidSchema.nullable(),
});
export type ResolvedGridHour = z.infer<typeof resolvedGridHourSchema>;

/** `GET …/clock-grid/hours?from=YYYY-MM-DD&days=7`: the resolved hours of station-local dates. */
export const gridHoursQuerySchema = z.object({
  from: localDateSchema,
  days: z.coerce.number().int().min(1).max(31).default(7),
});
export type GridHoursQuery = z.input<typeof gridHoursQuerySchema>;

export const gridHoursSchema = z.object({ items: z.array(resolvedGridHourSchema) });
export type GridHours = z.infer<typeof gridHoursSchema>;
