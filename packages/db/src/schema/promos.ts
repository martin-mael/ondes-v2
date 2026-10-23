import type { PromoDaypart, PromoPlacementStatus } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { asset } from './library.ts';
import { logDay, logItem } from './log.ts';
import { segue } from './segues.ts';
import { show } from './shows.ts';
import { station } from './tenancy.ts';

// Promo VTs and VT pools (#60, ADR 0032). Contracts: packages/shared/src/contracts/promos.ts.
//
// - `promo`: a `vt` asset with airing rules. Its validity is the asset's `start_at`/`kill_at`
//   (one source of truth), so a promo row has no dates of its own. One promo per asset.
// - `vt_pool`: a named group of promos, drawn from by clock `vt` slots (`clock_slot.pool_id`).
// - `vt_pool_member`: which promos are in which pool.
// - `promo_placement`: one row per promo the generator placed over a transition: the day it
//   belongs to, the songs around it (A, B), the segue made for it. It is the ledger of planned
//   plays (max plays per day, the plays the UI shows); aired plays come from the as-run.
//   Regenerating the day replaces the placements whose items it replaced.

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const vtPool = pgTable(
  'vt_pool',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    color: text('color'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'vt_pool_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    unique('vt_pool_id_org_station_key').on(t.id, t.orgId, t.stationId),
    uniqueIndex('vt_pool_station_name_key').on(t.stationId, sql`lower(${t.name})`),
  ],
);

export const promo = pgTable(
  'promo',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    assetId: uuid('asset_id').notNull(),
    /** The show it promotes, if any. */
    showId: uuid('show_id').references(() => show.id, { onDelete: 'set null' }),
    /** The event it promotes, if any ("Concert at the Marché Gare"). */
    eventName: text('event_name'),
    eventAt: timestamp('event_at', { withTimezone: true }),
    /** Relative share of its pools' plays. */
    weight: integer('weight').notNull().default(1),
    /** Per station-local day; null: no cap. */
    maxPlaysPerDay: integer('max_plays_per_day'),
    /** Station-local hours it may air; empty: any time. */
    dayparts: jsonb('dayparts').$type<PromoDaypart[]>().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'promo_asset_fk',
      columns: [t.assetId, t.orgId, t.stationId],
      foreignColumns: [asset.id, asset.orgId, asset.stationId],
    }).onDelete('cascade'),
    unique('promo_asset_key').on(t.assetId),
    unique('promo_id_org_station_key').on(t.id, t.orgId, t.stationId),
    index('promo_station_idx').on(t.stationId),
    index('promo_show_idx').on(t.showId),
    check('promo_weight_check', sql`${t.weight} between 1 and 100`),
    check('promo_max_plays_check', sql`${t.maxPlaysPerDay} between 1 and 1000`),
    check('promo_version_check', sql`${t.version} >= 1`),
  ],
);

export const vtPoolMember = pgTable(
  'vt_pool_member',
  {
    poolId: uuid('pool_id').notNull(),
    promoId: uuid('promo_id').notNull(),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'vt_pool_member_pkey', columns: [t.poolId, t.promoId] }),
    foreignKey({
      name: 'vt_pool_member_pool_fk',
      columns: [t.poolId, t.orgId, t.stationId],
      foreignColumns: [vtPool.id, vtPool.orgId, vtPool.stationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'vt_pool_member_promo_fk',
      columns: [t.promoId, t.orgId, t.stationId],
      foreignColumns: [promo.id, promo.orgId, promo.stationId],
    }).onDelete('cascade'),
    index('vt_pool_member_promo_idx').on(t.promoId),
  ],
);

export const promoPlacement = pgTable(
  'promo_placement',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    promoId: uuid('promo_id').notNull(),
    assetId: uuid('asset_id').notNull(),
    poolId: uuid('pool_id').references(() => vtPool.id, { onDelete: 'set null' }),
    logDayId: uuid('log_day_id').notNull(),
    /** The day's station-local date, for the per-day cap. */
    localDate: date('local_date', { mode: 'string' }).notNull(),
    /** A, the song before the promo; null once the item is gone. */
    fromItemId: uuid('from_item_id').references(() => logItem.id, { onDelete: 'set null' }),
    /** B, the song after it. */
    toItemId: uuid('to_item_id').references(() => logItem.id, { onDelete: 'set null' }),
    /** The clock slot that asked for it. */
    clockId: uuid('clock_id'),
    slotIndex: integer('slot_index'),
    /** The transition's planned time (A's planned end). */
    plannedAt: timestamp('planned_at', { withTimezone: true, precision: 3 }).notNull(),
    segueId: uuid('segue_id').references(() => segue.id, { onDelete: 'set null' }),
    status: text('status').$type<PromoPlacementStatus>().notNull().default('pending'),
    /** Why it was dropped. */
    detail: text('detail'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'promo_placement_promo_fk',
      columns: [t.promoId, t.orgId, t.stationId],
      foreignColumns: [promo.id, promo.orgId, promo.stationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'promo_placement_day_fk',
      columns: [t.logDayId, t.orgId, t.stationId],
      foreignColumns: [logDay.id, logDay.orgId, logDay.stationId],
    }).onDelete('cascade'),
    index('promo_placement_promo_idx').on(t.promoId, t.plannedAt),
    index('promo_placement_day_idx').on(t.logDayId),
    index('promo_placement_station_date_idx').on(t.stationId, t.localDate),
    index('promo_placement_segue_idx').on(t.segueId),
    index('promo_placement_from_item_idx').on(t.fromItemId),
    index('promo_placement_to_item_idx').on(t.toItemId),
    check('promo_placement_status_check', sql`${t.status} in ('pending', 'placed', 'dropped')`),
  ],
);
