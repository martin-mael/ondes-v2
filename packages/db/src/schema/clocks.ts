import type { ClockSlotKind, MarkerTiming, VtSlotMode } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  check,
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
