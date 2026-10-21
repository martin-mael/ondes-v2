import type { AssetType, CategoryRule, MemberMode, RotationOrder } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  check,
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
import { station } from './tenancy.ts';

// Music rotation (#37): categories. Contracts: packages/shared/src/contracts/rotation.ts.
//
// Membership is never stored as a list of matches: a category keeps its smart rule (jsonb,
// validated by the contract) and its manual include/exclude entries, and @ondes/scheduling
// resolves the members against the library when asked, so tag edits apply at once. Rules
// (#38) and the new-music lifecycle (#41) add columns or tables here; clocks (#39) point at
// `category (id, org_id, station_id)`.

export const category = pgTable(
  'category',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    color: text('color'),
    assetType: text('asset_type').$type<AssetType>().notNull().default('song'),
    /** Smart rule; `null`: manual members only. */
    rule: jsonb('rule').$type<CategoryRule>(),
    rotationOrder: text('rotation_order')
      .$type<RotationOrder>()
      .notNull()
      .default('least_recently_played'),
    searchDepthPercent: integer('search_depth_percent').notNull().default(100),
    restMinutes: integer('rest_minutes').notNull().default(180),
    maxPlaysPerDay: integer('max_plays_per_day'),
    maxPlaysPerWeek: integer('max_plays_per_week'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    foreignKey({
      name: 'category_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    // Target of composite foreign keys (members here; clock slots in #39).
    unique('category_id_org_station_key').on(t.id, t.orgId, t.stationId),
    uniqueIndex('category_station_name_key').on(t.stationId, sql`lower(${t.name})`),
    check(
      'category_asset_type_check',
      sql`${t.assetType} in ('song', 'vt', 'jingle', 'bed', 'episode', 'other')`,
    ),
    check(
      'category_rotation_order_check',
      sql`${t.rotationOrder} in ('least_recently_played', 'weighted_random', 'sequential')`,
    ),
    check('category_search_depth_check', sql`${t.searchDepthPercent} between 1 and 100`),
    check('category_rest_check', sql`${t.restMinutes} >= 0`),
    check('category_max_plays_check', sql`${t.maxPlaysPerDay} > 0 and ${t.maxPlaysPerWeek} > 0`),
  ],
);

/** Manual membership: an asset added to, or kept out of, a category by hand. */
export const categoryMember = pgTable(
  'category_member',
  {
    categoryId: uuid('category_id').notNull(),
    assetId: uuid('asset_id').notNull(),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    mode: text('mode').$type<MemberMode>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'category_member_pkey', columns: [t.categoryId, t.assetId] }),
    foreignKey({
      name: 'category_member_category_fk',
      columns: [t.categoryId, t.orgId, t.stationId],
      foreignColumns: [category.id, category.orgId, category.stationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'category_member_asset_fk',
      columns: [t.assetId, t.orgId, t.stationId],
      foreignColumns: [asset.id, asset.orgId, asset.stationId],
    }).onDelete('cascade'),
    index('category_member_asset_id_idx').on(t.assetId),
    check('category_member_mode_check', sql`${t.mode} in ('include', 'exclude')`),
  ],
);
