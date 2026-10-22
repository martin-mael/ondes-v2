import type { EpisodeCheckStep, EpisodeFallbackKind } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { logItem } from './log.ts';
import { showSlot } from './shows.ts';

// Missing-episode alerts and fallbacks (#47, ADR 0022). Its own domain file: it hangs off
// shows (#44) and the log (#100) through foreign keys only.

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/**
 * One step of the missing-episode check for one occurrence: an alert (`t48h`, `t6h`) or the
 * fallback. The worker's `episode-check` job inserts it when it is due and the episode has no
 * audio; the unique key makes that idempotent per occurrence and step. The api works it off
 * (an outbox): it claims pending rows (`claimed_at`, `SKIP LOCKED`) whose `retry_at` has come,
 * raises the alert, emails whoever isn't in `notified` yet, applies the fallback, and sets
 * `processed_at`. A failure counts in `attempts` and backs off through `retry_at`.
 */
export const episodeCheck = pgTable(
  'episode_check',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    showId: uuid('show_id').notNull(),
    slotId: uuid('slot_id').notNull(),
    occurrenceDate: date('occurrence_date', { mode: 'string' }).notNull(),
    step: text('step').$type<EpisodeCheckStep>().notNull(),
    /** The occurrence as the worker saw it (UTC). */
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    /** The premiere planned for the occurrence then, if any (still without audio). */
    episodeId: uuid('episode_id'),
    /** Emails already sent for this step: a retry skips them. */
    notified: text('notified').array().notNull().default(sql`'{}'::text[]`),
    /** Failed runs so far; given up after a few. */
    attempts: smallint('attempts').notNull().default(0),
    /** Not claimed again before this (a backoff after a failure, or a wait for the log). */
    retryAt: timestamp('retry_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    /** What the api did: `alerted`, `fallback_applied`, `no_fallback`, `episode_ready`, … */
    result: text('result'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'episode_check_slot_fk',
      columns: [t.slotId, t.orgId, t.stationId],
      foreignColumns: [showSlot.id, showSlot.orgId, showSlot.stationId],
    }).onDelete('cascade'),
    unique('episode_check_occurrence_step_key').on(t.slotId, t.occurrenceDate, t.step),
    index('episode_check_pending_idx').on(t.startsAt).where(sql`${t.processedAt} is null`),
    check('episode_check_step_check', sql`${t.step} in ('t48h', 't6h', 'fallback')`),
  ],
);

/**
 * A log item that airs a fallback in place of a missing episode. The as-run copies `kind` onto
 * the entry when the item airs (`asrun_entry.fallback`), but only while the item still plays
 * `asset_id`, the asset the fallback put there: an operator who swaps the item takes it out of
 * the fallback. Deleted when the episode's audio arrived in time and the item was put back.
 */
export const logItemFallback = pgTable(
  'log_item_fallback',
  {
    logItemId: uuid('log_item_id')
      .primaryKey()
      .references(() => logItem.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    slotId: uuid('slot_id').notNull(),
    occurrenceDate: date('occurrence_date', { mode: 'string' }).notNull(),
    kind: text('kind').$type<EpisodeFallbackKind>().notNull(),
    /** What the fallback put in the item. */
    assetId: uuid('asset_id').notNull(),
    /** The episode that airs again (`latest_episode`, `episode`). */
    episodeId: uuid('episode_id'),
    /** The premiere that was missing, if one was planned. */
    missingEpisodeId: uuid('missing_episode_id'),
    /** Failed attempts to put the premiere back; given up after a few. */
    restoreAttempts: smallint('restore_attempts').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'log_item_fallback_slot_fk',
      columns: [t.slotId, t.orgId, t.stationId],
      foreignColumns: [showSlot.id, showSlot.orgId, showSlot.stationId],
    }).onDelete('cascade'),
    index('log_item_fallback_station_idx').on(t.stationId, t.slotId, t.occurrenceDate),
    check(
      'log_item_fallback_kind_check',
      sql`${t.kind} in ('latest_episode', 'episode', 'clock_music')`,
    ),
  ],
);
