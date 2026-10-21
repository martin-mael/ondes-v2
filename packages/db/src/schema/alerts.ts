import type { AlertDetails, AlertSeverity, SilenceAction } from '@ondes/shared';

/** Stored shape of `alert.action` (contract: `alertActionSchema`, with an ISO time). */
export type StoredAlertAction = {
  name: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  error: string | null;
  updatedAt: string;
};

import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
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
    /** Automatic action (e.g. `engine.skip`), claimed and run once; null if none. */
    action: jsonb('action').$type<StoredAlertAction>(),
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
    // Reopening (flapping): the latest alert per key.
    index('alert_station_dedupe_idx').on(t.stationId, t.dedupeKey, t.id),
    // Actions waiting for a replica that can run them.
    index('alert_action_pending_idx')
      .on(t.stationId)
      .where(sql`${t.resolvedAt} is null and ${t.action} ->> 'state' = 'pending'`),
  ],
);

/**
 * Events the alert consumer already applied, by event id (engine events have deterministic
 * ids): a redelivered event changes nothing. Pruned after a day by the sweep.
 */
export const alertEventSeen = pgTable(
  'alert_event_seen',
  {
    eventId: uuid('event_id').primaryKey(),
    stationId: uuid('station_id').notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('alert_event_seen_seen_at_idx').on(t.seenAt)],
);

/**
 * The newest engine boot the alert consumer saw per station: engine events of an older boot
 * that arrive after it (a late delivery) are stale and ignored.
 */
export const alertEngineBoot = pgTable(
  'alert_engine_boot',
  {
    stationId: uuid('station_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    bootId: text('boot_id').notNull(),
    bootedAt: timestamp('booted_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'alert_engine_boot_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
  ],
);

/**
 * Alert emails, one row per (alert, severity, recipient): retries of the email job skip who
 * already got it, and the per-(station, type) cooldown reads it. `suppressed` = not sent
 * (cooldown, acknowledged).
 */
export const alertNotification = pgTable(
  'alert_notification',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    alertId: uuid('alert_id')
      .notNull()
      .references(() => alert.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    type: text('type').notNull(),
    severity: text('severity').$type<AlertSeverity>().notNull(),
    /** Empty for a suppressed notification (nobody was emailed). */
    email: text('email').notNull(),
    status: text('status').$type<'sent' | 'suppressed'>().notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'alert_notification_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    uniqueIndex('alert_notification_alert_severity_email_key').on(t.alertId, t.severity, t.email),
    index('alert_notification_station_type_idx').on(t.stationId, t.type, t.createdAt),
    check('alert_notification_status_check', sql`${t.status} in ('sent', 'suppressed')`),
  ],
);

/**
 * What the app does on silence, one row per station (defaults apply without a row). The
 * detection itself (threshold, duration) is `station.engine_settings.blank`, rendered into the
 * engine template's `blank.detect`.
 */
export const silenceSetting = pgTable(
  'silence_setting',
  {
    stationId: uuid('station_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
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
