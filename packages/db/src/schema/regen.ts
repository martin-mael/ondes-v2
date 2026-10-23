import type { LogDayStatus, ScheduleArea } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { logItem } from './log.ts';
import { station } from './tenancy.ts';

// Log regeneration (#101, ADR 0030). Its own domain file: it hangs off stations and the log
// (#100) through foreign keys only.

const ms = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** A station's horizon settings. No row: the defaults (`LOG_REGEN_DEFAULT_SETTINGS`). */
export const logRegenSetting = pgTable(
  'log_regen_setting',
  {
    stationId: uuid('station_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    horizonDays: integer('horizon_days').notNull(),
    newDayStatus: text('new_day_status').$type<LogDayStatus>().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'log_regen_setting_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    check('log_regen_setting_horizon', sql`${t.horizonDays} between 1 and 56`),
    check('log_regen_setting_status', sql`${t.newDayStatus} in ('draft', 'published')`),
  ],
);

/**
 * A pending automatic regeneration (debounced, ADR 0030): one row per station while schedule
 * changes wait. Each change pushes `due_at` back (to at most `first_requested_at` plus the
 * longest wait) and widens `from_date` (null: from today). The `log-horizon` job regenerates
 * once it is due, then deletes the row if no change came in meanwhile (`last_requested_at`).
 */
export const logRegenRequest = pgTable(
  'log_regen_request',
  {
    stationId: uuid('station_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    fromDate: date('from_date', { mode: 'string' }),
    areas: text('areas').array().$type<ScheduleArea[]>().notNull(),
    firstRequestedAt: ms('first_requested_at').notNull(),
    lastRequestedAt: ms('last_requested_at').notNull(),
    dueAt: ms('due_at').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'log_regen_request_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    index('log_regen_request_due').on(t.dueAt),
  ],
);

/**
 * Where the last regeneration planned a kept item (`start`) and where retiming put it
 * (`settled_start`), so the next one plans around the same time while the item hasn't moved
 * (`@ondes/scheduling` `keptStart`). Goes with its item.
 */
export const logItemPin = pgTable(
  'log_item_pin',
  {
    logItemId: uuid('log_item_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    start: ms('start').notNull(),
    settledStart: ms('settled_start').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'log_item_pin_item_fk',
      columns: [t.logItemId],
      foreignColumns: [logItem.id],
    }).onDelete('cascade'),
    index('log_item_pin_station').on(t.stationId),
  ],
);
