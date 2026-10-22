import {
  auditDiff,
  clock,
  clockGrid,
  clockGridCell,
  clockGridOverride,
  type Db,
  daypart,
  type Executor,
  NotFoundError,
  type StationScope,
  station,
  type Tx,
  whereStation,
  withAudit,
} from '@ondes/db';
import { type ClockGrid, expandGrid, isGridComplete } from '@ondes/scheduling';
import {
  addDays,
  type ClockGridDto,
  type CreateDaypart,
  type CreateGridOverride,
  createDaypartSchema,
  createGridOverrideSchema,
  type Daypart,
  daysBetween,
  GRID_OVERRIDE_MAX_DAYS,
  type GridCell,
  type GridHours,
  type GridHoursQuery,
  type GridOverride,
  gridHoursQuerySchema,
  localDayBounds,
  type UpdateClockGrid,
  type UpdateDaypart,
  type UpdateGridOverride,
  updateClockGridSchema,
  updateDaypartSchema,
  updateGridOverrideSchema,
} from '@ondes/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';
import type { StationContext } from './repo.ts';

// Weekly clock grid (#40, ADR 0020): cells and default clock (saved whole, versioned),
// dayparts and date-range overrides (one row each). Every function takes the station scope;
// mutations run in `withAudit`. `loadClockGrid` is what the log generator (#50) and
// missing-episode alerts (#47) pass to `resolveClockAt` / `expandGrid` from @ondes/scheduling.

type DaypartRow = typeof daypart.$inferSelect;
type OverrideRow = typeof clockGridOverride.$inferSelect;

function toDaypart(row: DaypartRow): Daypart {
  return {
    id: row.id,
    name: row.name,
    weekdays: row.weekdays,
    startHour: row.startHour,
    endHour: row.endHour,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toOverride(row: OverrideRow): GridOverride {
  return {
    id: row.id,
    name: row.name,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    startHour: row.startHour,
    endHour: row.endHour,
    clockId: row.clockId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function stationTimezone(db: Executor, scope: StationScope): Promise<string> {
  const [row] = await db
    .select({ timezone: station.timezone })
    .from(station)
    .where(and(eq(station.id, scope.stationId), eq(station.orgId, scope.orgId)));
  if (!row) throw new NotFoundError('station', scope.stationId);
  return row.timezone;
}

async function loadCells(db: Executor, scope: StationScope): Promise<GridCell[]> {
  return db
    .select({
      weekday: clockGridCell.weekday,
      hour: clockGridCell.hour,
      clockId: clockGridCell.clockId,
    })
    .from(clockGridCell)
    .where(whereStation(clockGridCell, scope))
    .orderBy(asc(clockGridCell.weekday), asc(clockGridCell.hour));
}

async function loadOverrides(db: Executor, scope: StationScope): Promise<GridOverride[]> {
  const rows = await db
    .select()
    .from(clockGridOverride)
    .where(whereStation(clockGridOverride, scope))
    .orderBy(asc(clockGridOverride.startsOn), asc(clockGridOverride.id));
  return rows.map(toOverride);
}

async function loadHeader(db: Executor, scope: StationScope) {
  const [row] = await db
    .select({ defaultClockId: clockGrid.defaultClockId, version: clockGrid.version })
    .from(clockGrid)
    .where(whereStation(clockGrid, scope));
  return row ?? { defaultClockId: null, version: 0 };
}

/**
 * The station's grid as `resolveClockAt` / `expandGrid` read it: cells, default clock and
 * overrides. For the log generator (#50) and missing-episode alerts (#47).
 */
export async function loadClockGrid(db: Executor, scope: StationScope): Promise<ClockGrid> {
  const [header, cells, overrides] = await Promise.all([
    loadHeader(db, scope),
    loadCells(db, scope),
    loadOverrides(db, scope),
  ]);
  return { defaultClockId: header.defaultClockId, cells, overrides };
}

export async function getClockGrid(db: Db | Tx, scope: StationScope): Promise<ClockGridDto> {
  const [header, cells, dayparts, overrides, timezone] = await Promise.all([
    loadHeader(db, scope),
    loadCells(db, scope),
    db
      .select()
      .from(daypart)
      .where(whereStation(daypart, scope))
      .orderBy(asc(daypart.startHour), asc(daypart.name)),
    loadOverrides(db, scope),
    stationTimezone(db, scope),
  ]);
  return {
    defaultClockId: header.defaultClockId,
    cells,
    version: header.version,
    dayparts: dayparts.map(toDaypart),
    overrides,
    timezone,
  };
}

/** Grid clocks must be clocks of this station. */
async function checkClocks(tx: Tx, scope: StationScope, ids: readonly (string | null)[]) {
  const wanted = [...new Set(ids.filter((id) => id !== null))];
  if (wanted.length === 0) return;
  const found = await tx
    .select({ id: clock.id })
    .from(clock)
    .where(and(whereStation(clock, scope), inArray(clock.id, wanted)));
  const known = new Set(found.map((r) => r.id));
  const unknown = wanted.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new HttpError(400, 'unknown_clock', 'some cells name unknown clocks', {
      clockIds: unknown,
    });
  }
}

type AuditCell = { weekday: number; hour: number; clockId: string | null };

/** The hours whose clock changed, before and after (`null`: unpainted), for the audit row. */
function changedCells(before: readonly GridCell[], after: readonly GridCell[]) {
  const key = (c: { weekday: number; hour: number }) => c.weekday * 24 + c.hour;
  const was = new Map(before.map((c) => [key(c), c.clockId]));
  const now = new Map(after.map((c) => [key(c), c.clockId]));
  const from: AuditCell[] = [];
  const to: AuditCell[] = [];
  for (const k of [...new Set([...was.keys(), ...now.keys()])].sort((a, b) => a - b)) {
    const a = was.get(k) ?? null;
    const b = now.get(k) ?? null;
    if (a === b) continue;
    const at = { weekday: Math.floor(k / 24), hour: k % 24 };
    from.push({ ...at, clockId: a });
    to.push({ ...at, clockId: b });
  }
  return { from, to };
}

/**
 * `PUT …/clock-grid`: replaces the cells and the default clock. Refuses (409 `edit_conflict`)
 * an edit based on another version than the stored one, and (400 `incomplete_grid`) a grid
 * that leaves hours without a clock: no default and not all 168 hours painted.
 */
export async function updateClockGrid(
  db: Db,
  ctx: StationContext,
  input: UpdateClockGrid,
): Promise<ClockGridDto> {
  const { version, defaultClockId, cells } = updateClockGridSchema.parse(input);
  const { scope } = ctx;
  if (!isGridComplete({ defaultClockId, cells, overrides: [] })) {
    throw new HttpError(
      400,
      'incomplete_grid',
      'choose a default clock or paint every hour of the week',
      { unassigned: 7 * 24 - cells.length },
    );
  }
  await withAudit(db, ctx, async (tx, audit) => {
    // The row is created on the first save; locking it serializes concurrent saves.
    await tx
      .insert(clockGrid)
      .values({ stationId: scope.stationId, orgId: scope.orgId })
      .onConflictDoNothing();
    const [locked] = await tx
      .select()
      .from(clockGrid)
      .where(whereStation(clockGrid, scope))
      .for('update');
    if (!locked) throw new NotFoundError('station', scope.stationId);
    if (locked.version !== version) {
      throw new HttpError(409, 'edit_conflict', 'the grid was changed since this version', {
        version: locked.version,
      });
    }
    await checkClocks(tx, scope, [defaultClockId, ...cells.map((c) => c.clockId)]);
    const beforeCells = await loadCells(tx, scope);
    await tx.delete(clockGridCell).where(whereStation(clockGridCell, scope));
    if (cells.length > 0) {
      await tx
        .insert(clockGridCell)
        .values(cells.map((c) => ({ ...c, stationId: scope.stationId, orgId: scope.orgId })));
    }
    await tx
      .update(clockGrid)
      .set({ defaultClockId, version: locked.version + 1, updatedAt: new Date() })
      .where(whereStation(clockGrid, scope));
    const diff = auditDiff({ defaultClockId: locked.defaultClockId }, { defaultClockId });
    const changed = changedCells(beforeCells, cells);
    if (changed.from.length > 0) diff.cells = changed;
    await audit({
      action: 'clock_grid.update',
      entity: { type: 'clock_grid', id: scope.stationId },
      diff,
    });
  });
  return getClockGrid(db, scope);
}

/**
 * Before deleting a clock (`deleteClock`): refuses (409 `clock_in_use`) when the grid needs it
 * (the default clock, an override's clock, or a painted hour of a grid without a default,
 * which would leave that hour without a clock), and bumps the grid version when the deletion
 * removes painted hours, so an editor open on the old grid gets `edit_conflict` on save.
 */
export async function releaseClockFromGrid(tx: Tx, scope: StationScope, clockId: string) {
  const [header] = await tx
    .select()
    .from(clockGrid)
    .where(whereStation(clockGrid, scope))
    .for('update');
  const overrides = await tx
    .select({ id: clockGridOverride.id, name: clockGridOverride.name })
    .from(clockGridOverride)
    .where(and(whereStation(clockGridOverride, scope), eq(clockGridOverride.clockId, clockId)));
  const [painted] = await tx
    .select({ hour: clockGridCell.hour })
    .from(clockGridCell)
    .where(and(whereStation(clockGridCell, scope), eq(clockGridCell.clockId, clockId)))
    .limit(1);
  const isDefault = header?.defaultClockId === clockId;
  const leavesHoursEmpty = painted !== undefined && !header?.defaultClockId;
  if (isDefault || overrides.length > 0 || leavesHoursEmpty) {
    throw new HttpError(409, 'clock_in_use', 'the weekly grid uses this clock', {
      default: isDefault,
      overrides: overrides.map((o) => o.name),
      painted: leavesHoursEmpty,
    });
  }
  if (painted && header) {
    await tx
      .update(clockGrid)
      .set({ version: header.version + 1, updatedAt: new Date() })
      .where(whereStation(clockGrid, scope));
  }
}

// --- Dayparts ------------------------------------------------------------------------------

/** A unique violation of the station's daypart names. */
function isDaypartNameTaken(err: unknown): boolean {
  let current: unknown = err;
  while (current && typeof current === 'object') {
    const pg = current as { code?: string; constraint_name?: string };
    if (pg.code === '23505' && pg.constraint_name === 'daypart_station_name_key') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function mutateDaypart<T>(
  db: Db,
  ctx: StationContext,
  fn: Parameters<typeof withAudit<T>>[2],
) {
  try {
    return await withAudit(db, ctx, fn);
  } catch (error) {
    if (isDaypartNameTaken(error)) {
      throw new HttpError(409, 'daypart_name_taken', 'a daypart of this station has this name');
    }
    throw error;
  }
}

async function loadDaypart(db: Executor, scope: StationScope, id: string): Promise<DaypartRow> {
  const [row] = await db
    .select()
    .from(daypart)
    .where(and(eq(daypart.id, id), whereStation(daypart, scope)));
  if (!row) throw new NotFoundError('daypart', id);
  return row;
}

export async function createDaypart(
  db: Db,
  ctx: StationContext,
  input: CreateDaypart,
): Promise<Daypart> {
  const fields = createDaypartSchema.parse(input);
  return mutateDaypart(db, ctx, async (tx, audit) => {
    const [row] = await tx
      .insert(daypart)
      .values({ ...fields, stationId: ctx.scope.stationId, orgId: ctx.scope.orgId })
      .returning();
    const created = toDaypart(row as DaypartRow);
    await audit({
      action: 'daypart.create',
      entity: { type: 'daypart', id: created.id },
      diff: auditDiff(null, created),
    });
    return created;
  });
}

export async function updateDaypart(
  db: Db,
  ctx: StationContext,
  id: string,
  input: UpdateDaypart,
): Promise<Daypart> {
  const patch = updateDaypartSchema.parse(input);
  return mutateDaypart(db, ctx, async (tx, audit) => {
    const before = toDaypart(await loadDaypart(tx, ctx.scope, id));
    const [row] = await tx
      .update(daypart)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(daypart.id, id), whereStation(daypart, ctx.scope)))
      .returning();
    const after = toDaypart(row as DaypartRow);
    await audit({
      action: 'daypart.update',
      entity: { type: 'daypart', id },
      diff: auditDiff(before, after),
    });
    return after;
  });
}

export async function deleteDaypart(db: Db, ctx: StationContext, id: string): Promise<void> {
  await withAudit(db, ctx, async (tx, audit) => {
    const before = toDaypart(await loadDaypart(tx, ctx.scope, id));
    await tx.delete(daypart).where(and(eq(daypart.id, id), whereStation(daypart, ctx.scope)));
    await audit({
      action: 'daypart.delete',
      entity: { type: 'daypart', id },
      diff: auditDiff(before, null),
    });
  });
}

// --- Overrides -----------------------------------------------------------------------------

async function loadOverride(db: Executor, scope: StationScope, id: string): Promise<OverrideRow> {
  const [row] = await db
    .select()
    .from(clockGridOverride)
    .where(and(eq(clockGridOverride.id, id), whereStation(clockGridOverride, scope)));
  if (!row) throw new NotFoundError('clock_grid_override', id);
  return row;
}

/** The whole range, as stored after the edit. */
function checkOverrideRange(o: {
  startsOn: string;
  endsOn: string;
  startHour: number;
  endHour: number;
}) {
  if (o.endsOn < o.startsOn || o.startHour >= o.endHour) {
    throw new HttpError(400, 'invalid_range', 'the override ends before it starts');
  }
  if (daysBetween(o.startsOn, o.endsOn) + 1 > GRID_OVERRIDE_MAX_DAYS) {
    throw new HttpError(
      400,
      'invalid_range',
      `an override lasts at most ${GRID_OVERRIDE_MAX_DAYS} days`,
    );
  }
}

export async function createGridOverride(
  db: Db,
  ctx: StationContext,
  input: CreateGridOverride,
): Promise<GridOverride> {
  const fields = createGridOverrideSchema.parse(input);
  checkOverrideRange(fields);
  return withAudit(db, ctx, async (tx, audit) => {
    await checkClocks(tx, ctx.scope, [fields.clockId]);
    const [row] = await tx
      .insert(clockGridOverride)
      .values({ ...fields, stationId: ctx.scope.stationId, orgId: ctx.scope.orgId })
      .returning();
    const created = toOverride(row as OverrideRow);
    await audit({
      action: 'clock_grid_override.create',
      entity: { type: 'clock_grid_override', id: created.id },
      diff: auditDiff(null, created),
    });
    return created;
  });
}

export async function updateGridOverride(
  db: Db,
  ctx: StationContext,
  id: string,
  input: UpdateGridOverride,
): Promise<GridOverride> {
  const patch = updateGridOverrideSchema.parse(input);
  return withAudit(db, ctx, async (tx, audit) => {
    const before = toOverride(await loadOverride(tx, ctx.scope, id));
    checkOverrideRange({ ...before, ...patch });
    if (patch.clockId !== undefined) await checkClocks(tx, ctx.scope, [patch.clockId]);
    const [row] = await tx
      .update(clockGridOverride)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(clockGridOverride.id, id), whereStation(clockGridOverride, ctx.scope)))
      .returning();
    const after = toOverride(row as OverrideRow);
    await audit({
      action: 'clock_grid_override.update',
      entity: { type: 'clock_grid_override', id },
      diff: auditDiff(before, after),
    });
    return after;
  });
}

export async function deleteGridOverride(db: Db, ctx: StationContext, id: string): Promise<void> {
  await withAudit(db, ctx, async (tx, audit) => {
    const before = toOverride(await loadOverride(tx, ctx.scope, id));
    await tx
      .delete(clockGridOverride)
      .where(and(eq(clockGridOverride.id, id), whereStation(clockGridOverride, ctx.scope)));
    await audit({
      action: 'clock_grid_override.delete',
      entity: { type: 'clock_grid_override', id },
      diff: auditDiff(before, null),
    });
  });
}

// --- Resolved hours ------------------------------------------------------------------------

/** `GET …/clock-grid/hours`: every real hour of `days` station-local dates, resolved. */
export async function gridHours(
  db: Db,
  scope: StationScope,
  query: GridHoursQuery,
): Promise<GridHours> {
  const { from, days } = gridHoursQuerySchema.parse(query);
  const [grid, timezone] = await Promise.all([
    loadClockGrid(db, scope),
    stationTimezone(db, scope),
  ]);
  const range = {
    from: localDayBounds(from, timezone).startsAt,
    to: localDayBounds(addDays(from, days - 1), timezone).endsAt,
  };
  return { items: expandGrid(grid, range, timezone) };
}
