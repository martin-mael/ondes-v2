import type { EpisodeKind, EpisodeStatus, SlotRule, SlotType, TracklistEntry } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
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
import { station, user } from './tenancy.ts';

// Shows, slots and episodes (#44, ADR 0012). Contracts: packages/shared/src/contracts/shows.ts.
//
// Every table carries `org_id` and `station_id`; children point at their show with a composite
// foreign key on (show_id, org_id, station_id), so a slot, host or episode can't hang off
// another tenant's show. A slot's recurrence is the contract's `SlotRule` (jsonb), with
// `starts_on`/`ends_on` derived from it so range reads skip slots that can't reach the range.
// Episodes point at their asset and premiere slot with plain `on delete set null` keys (a
// composite key would null the tenant columns too); the repository checks both are in scope.

const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const orgId = () => uuid('org_id').notNull();
const stationId = () => uuid('station_id').notNull();
const showId = () => uuid('show_id').notNull();

const showFk = (
  name: string,
  t: {
    showId: AnyPgColumn;
    orgId: AnyPgColumn;
    stationId: AnyPgColumn;
  },
) =>
  foreignKey({
    name,
    columns: [t.showId, t.orgId, t.stationId],
    foreignColumns: [show.id, show.orgId, show.stationId],
  }).onDelete('cascade');

export const show = pgTable(
  'show',
  {
    id: id(),
    orgId: orgId(),
    stationId: stationId(),
    name: text('name').notNull(),
    description: text('description'),
    artworkUrl: text('artwork_url'),
    colour: text('colour'),
    defaultDurationMs: integer('default_duration_ms'),
    defaultSlotType: text('default_slot_type')
      .$type<Exclude<SlotType, 'rerun'>>()
      .notNull()
      .default('prerecorded'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'show_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    unique('show_id_org_station_key').on(t.id, t.orgId, t.stationId),
    index('show_station_name_idx').on(t.stationId, t.name),
    check('show_default_slot_type_check', sql`${t.defaultSlotType} in ('prerecorded', 'live')`),
    check('show_colour_check', sql`${t.colour} ~ '^#[0-9a-f]{6}$'`),
    check('show_default_duration_check', sql`${t.defaultDurationMs} between 60000 and 86400000`),
  ],
);

/** A user who presents a show. Hosts with `show:write_own` may edit it and its episodes. */
export const showHost = pgTable(
  'show_host',
  {
    showId: showId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    orgId: orgId(),
    stationId: stationId(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'show_host_pkey', columns: [t.showId, t.userId] }),
    showFk('show_host_show_fk', t),
    index('show_host_user_idx').on(t.userId, t.stationId),
  ],
);

export const showSlot = pgTable(
  'show_slot',
  {
    id: id(),
    orgId: orgId(),
    stationId: stationId(),
    showId: showId(),
    type: text('type').$type<SlotType>().notNull(),
    rule: jsonb('rule').$type<SlotRule>().notNull(),
    /** First local date the rule can air on. */
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    /** Last local date it can air on; null: no end. */
    endsOn: date('ends_on', { mode: 'string' }),
    durationMs: integer('duration_ms').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    showFk('show_slot_show_fk', t),
    unique('show_slot_id_org_station_key').on(t.id, t.orgId, t.stationId),
    index('show_slot_show_idx').on(t.showId),
    index('show_slot_station_range_idx').on(t.stationId, t.startsOn, t.endsOn),
    check('show_slot_type_check', sql`${t.type} in ('prerecorded', 'live', 'rerun')`),
    check('show_slot_duration_check', sql`${t.durationMs} between 60000 and 86400000`),
    check('show_slot_range_check', sql`${t.endsOn} >= ${t.startsOn}`),
  ],
);

/** One cancelled or moved occurrence of a slot, keyed by its original local date. */
export const showSlotException = pgTable(
  'show_slot_exception',
  {
    slotId: uuid('slot_id').notNull(),
    orgId: orgId(),
    stationId: stationId(),
    date: date('date', { mode: 'string' }).notNull(),
    kind: text('kind').$type<'cancelled' | 'moved'>().notNull(),
    startDate: date('start_date', { mode: 'string' }),
    startTime: text('start_time'),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'show_slot_exception_pkey', columns: [t.slotId, t.date] }),
    foreignKey({
      name: 'show_slot_exception_slot_fk',
      columns: [t.slotId, t.orgId, t.stationId],
      foreignColumns: [showSlot.id, showSlot.orgId, showSlot.stationId],
    }).onDelete('cascade'),
    check(
      'show_slot_exception_kind_check',
      sql`(${t.kind} = 'cancelled' and ${t.startDate} is null and ${t.startTime} is null and ${t.durationMs} is null)
        or (${t.kind} = 'moved' and ${t.startDate} is not null and ${t.startTime} is not null)`,
    ),
    check(
      'show_slot_exception_move_check',
      sql`${t.startDate} between ${t.date} - 7 and ${t.date} + 7`,
    ),
    check('show_slot_exception_duration_check', sql`${t.durationMs} between 60000 and 86400000`),
  ],
);

export const episode = pgTable(
  'episode',
  {
    id: id(),
    orgId: orgId(),
    stationId: stationId(),
    showId: showId(),
    number: integer('number').notNull(),
    title: text('title'),
    description: text('description'),
    tracklist: jsonb('tracklist').$type<TracklistEntry[]>().notNull().default([]),
    kind: text('kind').$type<EpisodeKind>().notNull(),
    assetId: uuid('asset_id').references(() => asset.id, { onDelete: 'set null' }),
    status: text('status').$type<EpisodeStatus>().notNull().default('planned'),
    airedAt: timestamp('aired_at', { withTimezone: true }),
    slotId: uuid('slot_id').references(() => showSlot.id, { onDelete: 'set null' }),
    occurrenceDate: date('occurrence_date', { mode: 'string' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    showFk('episode_show_fk', t),
    unique('episode_show_number_key').on(t.showId, t.number),
    // One premiere per occurrence.
    uniqueIndex('episode_occurrence_key')
      .on(t.slotId, t.occurrenceDate)
      .where(sql`${t.slotId} is not null`),
    index('episode_station_status_idx').on(t.stationId, t.status),
    index('episode_asset_idx').on(t.assetId),
    check('episode_number_check', sql`${t.number} >= 1`),
    check('episode_kind_check', sql`${t.kind} in ('prerecorded', 'live')`),
    check('episode_status_check', sql`${t.status} in ('planned', 'ready', 'aired', 'missing')`),
  ],
);
