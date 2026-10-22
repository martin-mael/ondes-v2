import type { ClockSlotKind, MarkerTiming, VtSlotMode } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { asset } from './library.ts';
import { category } from './rotation.ts';
import { station } from './tenancy.ts';

// Clocks (#39): hour templates. Contracts: packages/shared/src/contracts/clocks.ts.
//
// A clock's slots are rows of `clock_slot`, keyed by (clock_id, position); the api replaces
// the whole list on every save, so `position` is the slot index the log's `origin.slotIndex`
// points at. Slots belong to their clock's tenant through the composite foreign key. Their
// category and asset references are plain foreign keys with `on delete set null` (a composite
// key can't `set null` without nulling the tenant columns too): deleting a category or an
// asset leaves the slot in place, without its reference, and the clock shows a
// `missing_reference` warning. The repository checks references are in scope on write.

export const clock = pgTable(
  'clock',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    color: text('color'),
    targetDurationMs: integer('target_duration_ms').notNull().default(3_600_000),
    /** Bumped on every save: the api refuses an edit based on an older version. */
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    foreignKey({
      name: 'clock_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    // Target of composite foreign keys (slots here; the weekly grid in #40).
    unique('clock_id_org_station_key').on(t.id, t.orgId, t.stationId),
    uniqueIndex('clock_station_name_key').on(t.stationId, sql`lower(${t.name})`),
    check('clock_target_check', sql`${t.targetDurationMs} between 60000 and 21600000`),
    check('clock_version_check', sql`${t.version} >= 1`),
  ],
);

export const clockSlot = pgTable(
  'clock_slot',
  {
    clockId: uuid('clock_id').notNull(),
    position: integer('position').notNull(),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    kind: text('kind').$type<ClockSlotKind>().notNull(),
    label: text('label'),
    /** Nominal length; `null`: estimated from the category or asset. */
    durationMs: integer('duration_ms'),
    categoryId: uuid('category_id').references(() => category.id, { onDelete: 'set null' }),
    assetId: uuid('asset_id').references(() => asset.id, { onDelete: 'set null' }),
    /** `vt` slots only. */
    vtMode: text('vt_mode').$type<VtSlotMode>(),
    /** `marker` slots only. */
    timing: text('timing').$type<MarkerTiming>(),
    offsetMs: integer('offset_ms'),
    capMs: integer('cap_ms'),
  },
  (t) => [
    primaryKey({ name: 'clock_slot_pkey', columns: [t.clockId, t.position] }),
    foreignKey({
      name: 'clock_slot_clock_fk',
      columns: [t.clockId, t.orgId, t.stationId],
      foreignColumns: [clock.id, clock.orgId, clock.stationId],
    }).onDelete('cascade'),
    index('clock_slot_category_id_idx').on(t.categoryId),
    index('clock_slot_asset_id_idx').on(t.assetId),
    check(
      'clock_slot_kind_check',
      sql`${t.kind} in ('category', 'asset', 'vt', 'jingle', 'marker', 'fill', 'live')`,
    ),
    check('clock_slot_position_check', sql`${t.position} >= 0`),
    check('clock_slot_duration_check', sql`${t.durationMs} >= 0`),
    check(
      'clock_slot_vt_check',
      sql`(${t.kind} = 'vt') = (${t.vtMode} is not null) and ${t.vtMode} in ('promo', 'placeholder')`,
    ),
    check(
      'clock_slot_marker_check',
      sql`(${t.kind} = 'marker') = (${t.timing} is not null and ${t.offsetMs} is not null)
        and ${t.timing} in ('hard', 'soft', 'not_before') and ${t.offsetMs} >= 0 and ${t.capMs} >= 0`,
    ),
  ],
);

// Weekly clock grid (#40, ADR 0020). Contracts: packages/shared/src/contracts/clock-grid.ts.
// Resolution (override, then weekly cell, then default) is `resolveClockAt` / `expandGrid` in
// @ondes/scheduling; these tables only store what the programmer painted.
//
// - `clock_grid`: one row per station, created on the first save: the default clock and the
//   version `PUT …/clock-grid` checks. No row reads as version 0 without a default.
// - `clock_grid_cell`: one row per painted station-local hour of the week. Deleting a clock
//   deletes its cells (composite foreign key, so a cell can't point at another tenant's
//   clock): those hours fall back to the default clock.
// - `daypart`: named hour ranges used to paint in bulk. They schedule nothing themselves.
// - `clock_grid_override`: date-range exceptions.
// The default clock and the overrides' clocks are composite foreign keys like the cells', with
// no cascade: the clocks api refuses (409 `clock_in_use`) to delete a clock that is the
// default, used by an override, or painted on a grid without a default, so a saved grid stays
// complete (ADR 0020). Deleting a clock that only has cells (with a default to fall back on)
// removes them and bumps `clock_grid.version`.

export const clockGrid = pgTable(
  'clock_grid',
  {
    stationId: uuid('station_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    defaultClockId: uuid('default_clock_id'),
    version: integer('version').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    foreignKey({
      name: 'clock_grid_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    // Composite: a null default isn't checked (MATCH SIMPLE).
    foreignKey({
      name: 'clock_grid_default_clock_fk',
      columns: [t.defaultClockId, t.orgId, t.stationId],
      foreignColumns: [clock.id, clock.orgId, clock.stationId],
    }),
    index('clock_grid_default_clock_id_idx').on(t.defaultClockId),
    check('clock_grid_version_check', sql`${t.version} >= 0`),
  ],
);

export const clockGridCell = pgTable(
  'clock_grid_cell',
  {
    stationId: uuid('station_id').notNull(),
    orgId: uuid('org_id').notNull(),
    /** ISO weekday: 1 = Monday … 7 = Sunday. */
    weekday: integer('weekday').notNull(),
    /** Station-local wall-clock hour, 0–23. */
    hour: integer('hour').notNull(),
    clockId: uuid('clock_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'clock_grid_cell_pkey', columns: [t.stationId, t.weekday, t.hour] }),
    foreignKey({
      name: 'clock_grid_cell_clock_fk',
      columns: [t.clockId, t.orgId, t.stationId],
      foreignColumns: [clock.id, clock.orgId, clock.stationId],
    }).onDelete('cascade'),
    index('clock_grid_cell_clock_id_idx').on(t.clockId),
    check('clock_grid_cell_weekday_check', sql`${t.weekday} between 1 and 7`),
    check('clock_grid_cell_hour_check', sql`${t.hour} between 0 and 23`),
  ],
);

export const daypart = pgTable(
  'daypart',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    name: text('name').notNull(),
    /** ISO weekdays, sorted, distinct. */
    weekdays: integer('weekdays').array().notNull(),
    startHour: integer('start_hour').notNull(),
    /** Exclusive; `<= start_hour` runs past midnight into the next day. */
    endHour: integer('end_hour').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    foreignKey({
      name: 'daypart_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    uniqueIndex('daypart_station_name_key').on(t.stationId, sql`lower(${t.name})`),
    check(
      'daypart_weekdays_check',
      sql`cardinality(${t.weekdays}) between 1 and 7 and ${t.weekdays} <@ '{1,2,3,4,5,6,7}'::integer[]`,
    ),
    check(
      'daypart_hours_check',
      sql`${t.startHour} between 0 and 23 and ${t.endHour} between 1 and 24`,
    ),
  ],
);

export const clockGridOverride = pgTable(
  'clock_grid_override',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    name: text('name').notNull(),
    /** Station-local dates, both inclusive. */
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    startHour: integer('start_hour').notNull(),
    endHour: integer('end_hour').notNull(),
    clockId: uuid('clock_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    foreignKey({
      name: 'clock_grid_override_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'clock_grid_override_clock_fk',
      columns: [t.clockId, t.orgId, t.stationId],
      foreignColumns: [clock.id, clock.orgId, clock.stationId],
    }),
    index('clock_grid_override_station_range_idx').on(t.stationId, t.startsOn, t.endsOn),
    index('clock_grid_override_clock_id_idx').on(t.clockId),
    check('clock_grid_override_range_check', sql`${t.endsOn} >= ${t.startsOn}`),
    check(
      'clock_grid_override_hours_check',
      sql`${t.startHour} between 0 and 23 and ${t.endHour} between 1 and 24 and ${t.startHour} < ${t.endHour}`,
    ),
  ],
);
