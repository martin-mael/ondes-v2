import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { show } from './shows.ts';
import { station, user } from './tenancy.ts';

// Live streamers: DJ identities and their stream credentials (#63, ADR 0023). Contracts:
// packages/shared/src/contracts/live.ts.
//
// A streamer belongs to one station (composite key to `station (id, org_id)`), optionally to a
// user (guests have none; deleting the user turns the streamer into a guest). Usernames are
// unique per station, case-insensitively. `password_hash` is an argon2id PHC string: the
// plaintext is never stored. Allowed shows hang off the streamer with composite keys on both
// sides, so a streamer can't be allowed on another tenant's show.

export const LIVE_SESSION_TRIGGERS = ['slot', 'manual'] as const;
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
  ],
);
