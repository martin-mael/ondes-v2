import type { LiveAdHocPolicy, LiveRequestStatus } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { show, showSlot } from './shows.ts';
import { station, user } from './tenancy.ts';

// Live streamers: DJ identities and their stream credentials (#63, ADR 0023). Contracts:
// packages/shared/src/contracts/live.ts.
//
// A streamer belongs to one station (composite key to `station (id, org_id)`), optionally to a
// user (guests have none; deleting the user turns the streamer into a guest). Usernames are
// unique per station, case-insensitively. `password_hash` is an argon2id PHC string: the
// plaintext is never stored. Allowed shows hang off the streamer with composite keys on both
// sides, so a streamer can't be allowed on another tenant's show.

export const LIVE_SESSION_TRIGGERS = ['slot', 'manual', 'ad_hoc', 'event'] as const;
/**
 * `returned`: back to automation (gate closed). `handover`: another input went on air.
 * `disconnected`: the DJ on air hung up. `revoked`: the streamer was disabled, expired or
 * deleted. `engine_restarted`: the engine came back without it.
 */
export const LIVE_SESSION_END_REASONS = [
  'returned',
  'handover',
  'disconnected',
  'revoked',
  'engine_restarted',
] as const;

const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const streamer = pgTable(
  'streamer',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'set null' }),
    displayName: text('display_name').notNull(),
    /** Stored lowercase (the contract normalizes it). */
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    enabled: boolean('enabled').notNull().default(true),
    /** Credentials refused from this instant on; null: no expiry. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Connect at any time, not only around the allowed shows' slots. */
    anyTime: boolean('any_time').notNull().default(false),
    /** Outside their slots and events (#65): ask a manager, or go on air. */
    adHoc: text('ad_hoc').$type<LiveAdHocPolicy>().notNull().default('approval'),
    lastConnectedAt: timestamp('last_connected_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'streamer_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    unique('streamer_id_org_station_key').on(t.id, t.orgId, t.stationId),
    uniqueIndex('streamer_station_username_key').on(t.stationId, sql`lower(${t.username})`),
    index('streamer_user_idx').on(t.userId),
    check('streamer_username_check', sql`${t.username} ~ '^[a-z0-9][a-z0-9._-]{1,31}$'`),
    check('streamer_ad_hoc_check', sql`${t.adHoc} in ('approval', 'allowed')`),
  ],
);

/** A show whose slots a streamer may connect for (unless it may connect any time). */
export const streamerShow = pgTable(
  'streamer_show',
  {
    streamerId: uuid('streamer_id').notNull(),
    showId: uuid('show_id').notNull(),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'streamer_show_pkey', columns: [t.streamerId, t.showId] }),
    foreignKey({
      name: 'streamer_show_streamer_fk',
      columns: [t.streamerId, t.orgId, t.stationId],
      foreignColumns: [streamer.id, streamer.orgId, streamer.stationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'streamer_show_show_fk',
      columns: [t.showId, t.orgId, t.stationId],
      foreignColumns: [show.id, show.orgId, show.stationId],
    }).onDelete('cascade'),
    index('streamer_show_show_idx').on(t.showId),
  ],
);

/**
 * Live sessions (#64, ADR 0027): one row each time Node put a DJ on air, from the gate opening
 * on a harbor input until the air went back to automation or to another input (a handover
 * closes one session and opens the next). The engine reports the session id on the live
 * as-run entries (`as_run.live_session_id`). At most one open session per station: the partial
 * unique index arbitrates between api replicas that would open one at the same time.
 */
export const liveSession = pgTable(
  'live_session',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    /** Null when the streamer was deleted since, or for the shared password. */
    streamerId: uuid('streamer_id').references(() => streamer.id, { onDelete: 'set null' }),
    /** Harbor input of the station's pool, from 1. */
    input: integer('input').notNull(),
    /** `slot`: its DJ connected during a live slot of their show. `manual`: someone chose. */
    trigger: text('trigger', { enum: LIVE_SESSION_TRIGGERS }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: text('end_reason', { enum: LIVE_SESSION_END_REASONS }),
    /** The streamer's display name when it started: history outlives a renamed DJ (#65). */
    streamerName: text('streamer_name'),
    /**
     * A live slot's session (#65): its show, occurrence (slot + original local date) and the
     * episode it airs. Plain columns, no foreign keys: a session is history, and outlives a
     * deleted slot or episode.
     */
    showId: uuid('show_id'),
    slotId: uuid('slot_id'),
    occurrenceDate: date('occurrence_date', { mode: 'string' }),
    episodeId: uuid('episode_id'),
    episodeNumber: integer('episode_number'),
    /** An event's session (#65). */
    eventId: uuid('event_id'),
    /** What it airs: the event's title, or the show's name, as they were. */
    title: text('title'),
    /** End of the slot or event it was opened for: past it, the next one may take over. */
    scheduledEndAt: timestamp('scheduled_end_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'live_session_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    uniqueIndex('live_session_open_key').on(t.stationId).where(sql`${t.endedAt} is null`),
    index('live_session_station_started_idx').on(t.stationId, t.startedAt),
    index('live_session_streamer_idx').on(t.streamerId),
    check('live_session_input_check', sql`${t.input} between 1 and 16`),
    check(
      'live_session_trigger_check',
      sql`${t.trigger} in (${sql.raw(LIVE_SESSION_TRIGGERS.map((v) => `'${v}'`).join(', '))})`,
    ),
    check('live_session_end_check', sql`(${t.endedAt} is null) = (${t.endReason} is null)`),
    check(
      'live_session_occurrence_check',
      sql`(${t.slotId} is null) = (${t.occurrenceDate} is null)`,
    ),
    index('live_session_occurrence_idx')
      .on(t.slotId, t.occurrenceDate)
      .where(sql`${t.slotId} is not null`),
  ],
);

export const LIVE_REQUEST_STATUSES = ['pending', 'approved', 'refused', 'cancelled'] as const;

/**
 * Ad-hoc requests (#65, ADR 0033): a DJ whose streamer needs approval connected outside their
 * slots and events. One per connection (`connected_at` = the streamer's `last_connected_at`
 * when it was raised): a refused DJ isn't asked about again until they log in again. The
 * unique key arbitrates between api replicas raising it at the same time.
 */
export const liveRequest = pgTable(
  'live_request',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    streamerId: uuid('streamer_id').notNull(),
    input: integer('input').notNull(),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull(),
    status: text('status').$type<LiveRequestStatus>().notNull().default('pending'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: uuid('decided_by').references(() => user.id, { onDelete: 'set null' }),
  },
  (t) => [
    foreignKey({
      name: 'live_request_streamer_fk',
      columns: [t.streamerId, t.orgId, t.stationId],
      foreignColumns: [streamer.id, streamer.orgId, streamer.stationId],
    }).onDelete('cascade'),
    uniqueIndex('live_request_connection_key').on(t.streamerId, t.input, t.connectedAt),
    index('live_request_pending_idx')
      .on(t.stationId, t.requestedAt)
      .where(sql`${t.status} = 'pending'`),
    check(
      'live_request_status_check',
      sql`${t.status} in (${sql.raw(LIVE_REQUEST_STATUSES.map((v) => `'${v}'`).join(', '))})`,
    ),
    check('live_request_decided_check', sql`(${t.status} = 'pending') = (${t.decidedAt} is null)`),
    check('live_request_input_check', sql`${t.input} between 1 and 16`),
  ],
);

/**
 * Events (#65, ADR 0033): a one-off live block with a title, not a show. Its streamers (none:
 * any of the station's) may connect from 15 min before and go on air at its start.
 */
export const liveEvent = pgTable(
  'live_event',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    title: text('title').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'live_event_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    unique('live_event_id_org_station_key').on(t.id, t.orgId, t.stationId),
    index('live_event_station_range_idx').on(t.stationId, t.endsAt, t.startsAt),
    check(
      'live_event_span_check',
      sql`${t.endsAt} > ${t.startsAt} and ${t.endsAt} <= ${t.startsAt} + interval '24 hours'`,
    ),
  ],
);

export const liveEventStreamer = pgTable(
  'live_event_streamer',
  {
    eventId: uuid('event_id').notNull(),
    streamerId: uuid('streamer_id').notNull(),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'live_event_streamer_pkey', columns: [t.eventId, t.streamerId] }),
    foreignKey({
      name: 'live_event_streamer_event_fk',
      columns: [t.eventId, t.orgId, t.stationId],
      foreignColumns: [liveEvent.id, liveEvent.orgId, liveEvent.stationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'live_event_streamer_streamer_fk',
      columns: [t.streamerId, t.orgId, t.stationId],
      foreignColumns: [streamer.id, streamer.orgId, streamer.stationId],
    }).onDelete('cascade'),
    index('live_event_streamer_streamer_idx').on(t.streamerId),
  ],
);

/**
 * A live slot occurrence nobody went on air in by its start + grace (#65, ADR 0033): which
 * step ran, once across api replicas (the primary key, then `where … is null` claims).
 * - `missed_at`: the slot was declared missed (alert raised, fallback put in the log);
 * - `closed_at`: the occurrence ended (alert resolved, the episode marked `missing` if no DJ
 *   ever went on air in it).
 */
export const liveSlotCheck = pgTable(
  'live_slot_check',
  {
    slotId: uuid('slot_id').notNull(),
    occurrenceDate: date('occurrence_date', { mode: 'string' }).notNull(),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    missedAt: timestamp('missed_at', { withTimezone: true }),
    /** What the fallback put in the log: an `EpisodeFallbackKind`, or null (nothing could). */
    fallback: text('fallback'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'live_slot_check_pkey', columns: [t.slotId, t.occurrenceDate] }),
    foreignKey({
      name: 'live_slot_check_slot_fk',
      columns: [t.slotId, t.orgId, t.stationId],
      foreignColumns: [showSlot.id, showSlot.orgId, showSlot.stationId],
    }).onDelete('cascade'),
    index('live_slot_check_open_idx').on(t.stationId, t.endsAt).where(sql`${t.closedAt} is null`),
  ],
);
