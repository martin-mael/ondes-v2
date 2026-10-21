import type { AlertDetails, AlertSeverity, SilenceAction } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { station, user } from './tenancy.ts';

// Alerts (#33). Contracts: packages/shared/src/contracts/alerts.ts. Queries live in
// apps/api/src/modules/alerts/repo.ts.

const severityCheck = (column: unknown) => sql`${column} in ('info', 'warning', 'critical')`;

/**
 * One problem on one station, from raise to resolve. `status` is derived: open while
 * `resolved_at` is null. The partial unique index keeps at most one open alert per
 * (station, dedupe key), which is what makes concurrent raises (two api replicas, a
 * redelivered event) collapse into one alert.
 */
export const alert = pgTable(
  'alert',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    type: text('type').notNull(),
    severity: text('severity').$type<AlertSeverity>().notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    title: text('title').notNull(),
    message: text('message'),
    details: jsonb('details').$type<AlertDetails>().notNull().default({}),
    occurrences: integer('occurrences').notNull().default(1),
    raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    escalateAt: timestamp('escalate_at', { withTimezone: true }),
    escalateTo: text('escalate_to').$type<AlertSeverity>(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedBy: uuid('acknowledged_by').references(() => user.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolution: text('resolution'),
  },
  (t) => [
    foreignKey({
      name: 'alert_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    uniqueIndex('alert_station_dedupe_open_key')
      .on(t.stationId, t.dedupeKey)
      .where(sql`${t.resolvedAt} is null`),
    // Listing: newest first per station (ids are UUIDv7, so id order is raise order).
    index('alert_station_id_idx').on(t.stationId, t.id),
    // The escalation sweep.
    index('alert_escalate_at_idx')
      .on(t.escalateAt)
      .where(sql`${t.resolvedAt} is null and ${t.escalateAt} is not null`),
    check('alert_severity_check', severityCheck(t.severity)),
    check(
      'alert_escalate_to_check',
      sql`${t.escalateTo} is null or ${severityCheck(t.escalateTo)}`,
    ),
    check('alert_occurrences_check', sql`${t.occurrences} >= 1`),
  ],
);

/**
 * Silence detection settings, one row per station (defaults apply without a row).
 * `max_seconds` / `threshold_db` feed the engine template's `blank.detect`.
 */
export const silenceSetting = pgTable(
  'silence_setting',
  {
    stationId: uuid('station_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    maxSeconds: real('max_seconds').notNull(),
    thresholdDb: real('threshold_db').notNull(),
    action: text('action').$type<SilenceAction>().notNull(),
    escalateAfterSeconds: integer('escalate_after_seconds').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    foreignKey({
      name: 'silence_setting_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    check('silence_setting_action_check', sql`${t.action} in ('skip', 'safety', 'none')`),
  ],
);
