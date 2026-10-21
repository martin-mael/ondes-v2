import type {
  CueOverrides,
  LogDayStatus,
  LogItemKind,
  LogItemTiming,
  RelaxedRule,
} from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { asset } from './library.ts';
import { station } from './tenancy.ts';

// Log (#100). Contracts: packages/shared/src/contracts/log.ts.
//
// Times are `timestamptz(3)` and durations integer milliseconds: exact to the millisecond, so
// planned starts add up without drift and a hard start is planned to the 20 ms frame
// (ADR 0003). Cue overrides keep sample positions (jsonb, at their own sample rate).
//
// `log_item` points at its day with a composite foreign key on (log_day_id, org_id,
// station_id), so an item can't land in another tenant's day. Asset, episode and live slot
// references are checked against the scope by the repository: the asset foreign key is
// `on delete set null` (a deleted asset leaves a "missing" item, not a hole in the day), and
// episodes and live slots have no table yet.

const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const ms = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** One station-local day of the log. `starts_at`/`ends_at` are its bounds in UTC (23–25 h). */
export const logDay = pgTable(
  'log_day',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    localDate: date('local_date', { mode: 'string' }).notNull(),
    startsAt: ms('starts_at').notNull(),
    endsAt: ms('ends_at').notNull(),
    status: text('status').$type<LogDayStatus>().notNull().default('draft'),
    /** Bumped on every change to the day or its items. */
    version: integer('version').notNull().default(1),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    seed: text('seed'),
    generatorVersion: text('generator_version'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'log_day_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    unique('log_day_station_date_key').on(t.stationId, t.localDate),
    unique('log_day_id_org_station_key').on(t.id, t.orgId, t.stationId),
    index('log_day_station_range_idx').on(t.stationId, t.startsAt),
    check('log_day_status_check', sql`${t.status} in ('draft', 'published')`),
    check('log_day_range_check', sql`${t.endsAt} > ${t.startsAt}`),
    check('log_day_version_check', sql`${t.version} >= 1`),
  ],
);

/**
 * One item of a day, in `position` order. Island segments are a `segment` item followed by
 * its parts, each with `segment_id` pointing at it (deleting the segment deletes its parts).
 */
export const logItem = pgTable(
  'log_item',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    logDayId: uuid('log_day_id').notNull(),
    position: integer('position').notNull(),
    kind: text('kind').$type<LogItemKind>().notNull(),
    plannedStart: ms('planned_start').notNull(),
    plannedDurationMs: integer('planned_duration_ms').notNull(),
    assetId: uuid('asset_id').references(() => asset.id, { onDelete: 'set null' }),
    episodeId: uuid('episode_id'),
    liveSlotId: uuid('live_slot_id'),
    title: text('title'),
    cueOverrides: jsonb('cue_overrides').$type<CueOverrides>(),
    timing: text('timing').$type<LogItemTiming>().notNull().default('flow'),
    anchorAt: ms('anchor_at'),
    capMs: integer('cap_ms'),
    originType: text('origin_type').$type<'clock' | 'show' | 'manual'>().notNull(),
    originClockId: uuid('origin_clock_id'),
    originSlotIndex: integer('origin_slot_index'),
    originShowSlotId: uuid('origin_show_slot_id'),
    locked: boolean('locked').notNull().default(false),
    relaxedRules: jsonb('relaxed_rules').$type<RelaxedRule[]>().notNull().default([]),
    segmentId: uuid('segment_id').references((): AnyPgColumn => logItem.id, {
      onDelete: 'cascade',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'log_item_day_fk',
      columns: [t.logDayId, t.orgId, t.stationId],
      foreignColumns: [logDay.id, logDay.orgId, logDay.stationId],
    }).onDelete('cascade'),
    // Not deferrable: the repository renumbers through negative positions.
    unique('log_item_day_position_key').on(t.logDayId, t.position),
    index('log_item_station_start_idx').on(t.stationId, t.plannedStart),
    index('log_item_segment_idx').on(t.segmentId),
    index('log_item_asset_idx').on(t.assetId),
    check(
      'log_item_kind_check',
      sql`${t.kind} in ('song', 'vt', 'jingle', 'bed', 'episode', 'live_slot', 'marker', 'fill', 'segment')`,
    ),
    check('log_item_duration_check', sql`${t.plannedDurationMs} >= 0`),
    check(
      'log_item_marker_duration_check',
      sql`${t.kind} <> 'marker' or ${t.plannedDurationMs} = 0`,
    ),
    check(
      'log_item_timing_check',
      sql`${t.timing} in ('flow', 'hard', 'soft', 'not_before')
        and (${t.timing} = 'flow') = (${t.anchorAt} is null)
        and (${t.capMs} is null or (${t.timing} = 'soft' and ${t.capMs} >= 0))`,
    ),
    check('log_item_origin_check', sql`${t.originType} in ('clock', 'show', 'manual')`),
    check('log_item_segment_part_check', sql`${t.segmentId} is null or ${t.kind} <> 'segment'`),
  ],
);
