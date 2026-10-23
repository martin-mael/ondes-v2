import type { AsRunTransition } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { station } from './tenancy.ts';

/** One engine request of a pushed entry (#57). */
export type FeederPushPart = {
  /** The engine `item_id`: a log item id, or `island:<hash>` for an island. */
  itemId: string;
  /** How long it plays inside the entry, in ms (a body ends at its island). Null: its own. */
  expectedMs: number | null;
  transition: AsRunTransition | null;
};

// Log feeder (#29, ADR 0012): what the feeder pushed to a station's engine during its current
// boot. The engine queue only reports item ids; the feeder also needs the body it pushed (a
// fingerprint) and its hard-start trim to tell a queue that matches the plan from one that
// must be re-pushed, and to predict where the item on air ends. Kept here so a feeder that
// takes over a station (lease handover, api restart) resumes instead of re-pushing the queue.

/** One entry (a log item, or a segment by its segment item id) pushed during an engine boot. */
export const feederPush = pgTable(
  'feeder_push',
  {
    stationId: uuid('station_id').notNull(),
    orgId: uuid('org_id').notNull(),
    /** The engine boot it was pushed to; a new boot starts with an empty queue. */
    bootId: text('boot_id').notNull(),
    /** Log item id, or segment item id (the engine's `segment_id`). Not a foreign key. */
    entryId: uuid('entry_id').notNull(),
    /** Hash of the push body, before any trim. */
    fingerprint: text('fingerprint').notNull(),
    trimMs: integer('trim_ms').notNull().default(0),
    /** Went on air during this boot (the feeder never pushes it again in that boot). */
    aired: boolean('aired').notNull().default(false),
    pushedAt: timestamp('pushed_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * The engine requests of an island chain or of an item carrying a voice overlay (#57), as
     * pushed: what the as-run records against each of them. Null for plain entries.
     */
    parts: jsonb('parts').$type<FeederPushPart[]>(),
  },
  (t) => [
    primaryKey({ name: 'feeder_push_pkey', columns: [t.stationId, t.bootId, t.entryId] }),
    foreignKey({
      name: 'feeder_push_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    check('feeder_push_trim_check', sql`${t.trimMs} >= 0`),
  ],
);
