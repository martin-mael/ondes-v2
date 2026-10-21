import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { station } from './tenancy.ts';

// Public streams (#32). Contracts: packages/shared/src/contracts/streams.ts.
// Listener counts per Icecast mount, sampled by the api's stats poller
// (apps/api/src/modules/engine/icecast) and rolled up per minute. Counts only: no IP address,
// user agent or anything else that identifies a listener (GDPR).

export const streamListenerMinute = pgTable(
  'stream_listener_minute',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    stationId: uuid('station_id')
      .notNull()
      .references(() => station.id, { onDelete: 'cascade' }),
    /** Icecast mount with its leading slash: `/vandale/mp3`. */
    mount: text('mount').notNull(),
    /** Start of the minute (UTC, seconds zeroed). */
    minute: timestamp('minute', { withTimezone: true }).notNull(),
    /** Samples taken during the minute. */
    samples: integer('samples').notNull(),
    /** Sum of the sampled counts: the average is `listeners_sum / samples`. */
    listenersSum: integer('listeners_sum').notNull(),
    listenersMax: integer('listeners_max').notNull(),
    listenersMin: integer('listeners_min').notNull(),
    /** Samples where the engine was connected to the mount (the rest aired the fallback). */
    sourceSamples: integer('source_samples').notNull(),
  },
  (t) => [
    uniqueIndex('stream_listener_minute_key').on(t.stationId, t.mount, t.minute),
    check(
      'stream_listener_minute_counts_check',
      sql`${t.samples} > 0 and ${t.sourceSamples} between 0 and ${t.samples}
        and ${t.listenersMin} between 0 and ${t.listenersMax}`,
    ),
  ],
);
