import {
  addDays,
  daysBetween,
  type GridHourSource,
  isoWeekday,
  type LocalDate,
  localDateOf,
  zonedInstant,
  zonedParts,
} from '@ondes/shared';

// Weekly clock grid resolution (#40, ADR 0020): pure, station-local and DST-safe. The log
// generator (#50) asks which clock airs in each hour; the grid editor and missing-episode
// alerts (#47) ask the same question. No I/O: callers load the grid (the api's
// `loadClockGrid`) and pass it in.
//
// Order: an override covering the local date and hour, then the hour's weekly cell, then the
// station's default clock. With a default clock every hour resolves to exactly one clock;
// without one, unpainted hours resolve to `none`.
//
// DST (Europe/Paris, last Sundays of March and October): the grid is wall-clock time, so
// - the hour that doesn't exist (02:00–03:00 the night clocks go forward) is skipped: its cell
//   doesn't air that night, and the day has 23 hours. 01:00 runs until 03:00 on the wall
//   clock, which is one real hour, then the 03 cell starts.
// - the hour that happens twice (02:00–03:00 the night clocks go back) airs its cell's clock
//   twice, once in summer time and once, `repeated`, in winter time: the day has 25 hours.
// `resolveClock` itself is a lookup by wall-clock hour and knows nothing of either night;
// `expandGrid` and `resolveClockAt`, which work on real instants, apply the two rules.

/** One painted hour: ISO weekday (1 = Monday) and wall-clock hour (0–23). */
export interface ClockGridCell {
  weekday: number;
  hour: number;
  clockId: string;
}

/**
 * Dates `startsOn`–`endsOn` (inclusive), hours `[startHour, endHour)` each day. `clockId` null
 * (its clock was deleted): the override is ignored. `id` breaks ties between overlapping
 * overrides: uuidv7 ids sort by creation.
 */
export interface ClockGridOverride {
  id: string;
  startsOn: LocalDate;
  endsOn: LocalDate;
  startHour: number;
  endHour: number;
  clockId: string | null;
}

/** What resolution needs from a station's grid. The api's `ClockGridDto` fits. */
export interface ClockGrid {
  defaultClockId: string | null;
  cells: readonly ClockGridCell[];
  overrides: readonly ClockGridOverride[];
}

/** A station-local wall-clock hour. */
export interface LocalHour {
  date: LocalDate;
  /** 0–23. */
  hour: number;
}

export interface ClockResolution {
  /** `null` only when `source` is `none`: no cell, no override and no default clock. */
  clockId: string | null;
  source: GridHourSource;
  /** The winning override, when `source` is `override`. */
  overrideId: string | null;
}

/** One real hour of station time, resolved. */
export interface GridHour extends LocalHour, ClockResolution {
  startsAt: Date;
  endsAt: Date;
  /** The second run of the hour that happens twice, the night the clocks go back. */
  repeated: boolean;
}

const cellKey = (weekday: number, hour: number) => weekday * 24 + hour;

const overrideDays = (o: ClockGridOverride) => daysBetween(o.startsOn, o.endsOn) + 1;

/**
 * Overlapping overrides: the one with the fewest days wins (a one-day special inside a
 * holiday week), then the one that starts later, then the one created last.
 */
function beats(a: ClockGridOverride, b: ClockGridOverride): boolean {
  const days = overrideDays(a) - overrideDays(b);
  if (days !== 0) return days < 0;
  if (a.startsOn !== b.startsOn) return a.startsOn > b.startsOn;
  return a.id > b.id;
}

/** A grid indexed for repeated lookups. */
function compile(grid: ClockGrid): (local: LocalHour) => ClockResolution {
  const cells = new Map<number, string>();
  for (const cell of grid.cells) cells.set(cellKey(cell.weekday, cell.hour), cell.clockId);
  const overrides = grid.overrides.filter((o) => o.clockId !== null);
  return ({ date, hour }) => {
    let winner: ClockGridOverride | null = null;
    for (const o of overrides) {
      if (date < o.startsOn || date > o.endsOn || hour < o.startHour || hour >= o.endHour) {
        continue;
      }
      if (!winner || beats(o, winner)) winner = o;
    }
    if (winner) return { clockId: winner.clockId, source: 'override', overrideId: winner.id };
    const clockId = cells.get(cellKey(isoWeekday(date), hour));
    if (clockId) return { clockId, source: 'grid', overrideId: null };
    if (grid.defaultClockId) {
      return { clockId: grid.defaultClockId, source: 'default', overrideId: null };
    }
    return { clockId: null, source: 'none', overrideId: null };
  };
}

/**
 * The clock of a station-local wall-clock hour: override, then weekly cell, then default.
 * A pure lookup: on DST nights use `expandGrid` or `resolveClockAt`, which know that 02:00
 * is skipped in March and runs twice in October.
 */
export function resolveClock(grid: ClockGrid, local: LocalHour): ClockResolution {
  return compile(grid)(local);
}

const HOUR_MS = 3600 * 1000;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The real starts of a wall-clock hour: none in the spring-forward gap, two in the fall-back
 * overlap (an hour or, in zones like Australia/Lord_Howe, half an hour apart), one otherwise.
 */
function hourStarts(date: LocalDate, hour: number, timeZone: string): Date[] {
  const time = `${pad(hour)}:00`;
  const first = zonedInstant(date, time, timeZone);
  const isThisHour = (t: Date) => {
    const parts = zonedParts(t, timeZone);
    return parts.date === date && parts.time === time;
  };
  if (!isThisHour(first)) return [];
  for (const shift of [HOUR_MS, HOUR_MS / 2]) {
    const again = new Date(first.getTime() + shift);
    if (isThisHour(again)) return [first, again];
  }
  return [first];
}

/**
 * Every real hour of station time that overlaps the UTC range `[from, to)`, in order, each
 * with its clock. Hours are station-local: a spring-forward day has 23, a fall-back day 25
 * (ADR 0020). An hour runs until the next one starts, so the hours tile the range.
 */
export function expandGrid(
  grid: ClockGrid,
  range: { from: Date; to: Date },
  timeZone: string,
): GridHour[] {
  if (range.to <= range.from) return [];
  const resolve = compile(grid);
  const firstDate = addDays(localDateOf(range.from, timeZone), -1);
  const lastDate = addDays(localDateOf(range.to, timeZone), 1);
  const starts: { date: LocalDate; hour: number; startsAt: Date; repeated: boolean }[] = [];
  for (let date = firstDate; date <= lastDate; date = addDays(date, 1)) {
    for (let hour = 0; hour < 24; hour++) {
      hourStarts(date, hour, timeZone).forEach((startsAt, i) => {
        starts.push({ date, hour, startsAt, repeated: i > 0 });
      });
    }
  }
  starts.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const out: GridHour[] = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const start = starts[i] as (typeof starts)[number];
    const endsAt = (starts[i + 1] as (typeof starts)[number]).startsAt;
    if (endsAt <= range.from || start.startsAt >= range.to) continue;
    out.push({ ...start, endsAt, ...resolve(start) });
  }
  return out;
}

/** The hour `instant` falls in, resolved: what is (or was, or will be) on air then. */
export function resolveClockAt(grid: ClockGrid, instant: Date, timeZone: string): GridHour {
  const [hour] = expandGrid(grid, { from: instant, to: new Date(instant.getTime() + 1) }, timeZone);
  if (!hour) throw new Error(`no station hour at ${instant.toISOString()} in ${timeZone}`);
  return hour;
}

/**
 * The weekly hours with no clock: neither a cell nor a default. Empty once a default clock is
 * set. Overrides don't count: they only cover some dates.
 */
export function unassignedHours(grid: ClockGrid): { weekday: number; hour: number }[] {
  if (grid.defaultClockId) return [];
  const painted = new Set(grid.cells.map((c) => cellKey(c.weekday, c.hour)));
  const out: { weekday: number; hour: number }[] = [];
  for (let weekday = 1; weekday <= 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      if (!painted.has(cellKey(weekday, hour))) out.push({ weekday, hour });
    }
  }
  return out;
}
