import type { LiveHandoverFailure, LiveHandoverStatus } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { streamer } from './live.ts';
import { user } from './tenancy.ts';

// Scheduled DJ handovers (#66, ADR 0038). Contracts: packages/shared/src/contracts/live-handover.ts.
//
// At `at`, the streamer takes the air from whoever is on, with a `fade_ms` crossfade. The row
// is claimed (`pending` → `running`) by one api replica, then ends `done` (with the session it
// opened), `failed` (with a reason) or `cancelled`. The streamer is a composite key, so a
// handover can't name another station's DJ; deleting the streamer deletes its handovers.

export const LIVE_HANDOVER_STATUSES = [
  'pending',
  'running',
  'done',
  'failed',
  'cancelled',
] as const satisfies readonly LiveHandoverStatus[];

export const liveHandover = pgTable(
  'live_handover',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    streamerId: uuid('streamer_id').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    fadeMs: integer('fade_ms').notNull(),
    status: text('status').$type<LiveHandoverStatus>().notNull().default('pending'),
    reason: text('reason').$type<LiveHandoverFailure>(),
    /** The live session it opened (no foreign key: sessions are history). */
    sessionId: uuid('session_id'),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** When a replica claimed it (`running`): a claim left too long is failed `interrupted`. */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /** When it ended: done, failed or cancelled. */
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'live_handover_streamer_fk',
      columns: [t.streamerId, t.orgId, t.stationId],
      foreignColumns: [streamer.id, streamer.orgId, streamer.stationId],
    }).onDelete('cascade'),
    index('live_handover_pending_idx').on(t.stationId, t.at).where(sql`${t.status} = 'pending'`),
    index('live_handover_station_at_idx').on(t.stationId, t.at),
    check(
      'live_handover_status_check',
      sql`${t.status} in (${sql.raw(LIVE_HANDOVER_STATUSES.map((v) => `'${v}'`).join(', '))})`,
    ),
    check('live_handover_fade_check', sql`${t.fadeMs} between 0 and 10000`),
  ],
);
