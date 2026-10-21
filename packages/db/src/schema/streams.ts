import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { station } from './tenancy.ts';

// Public streams (#32). Contracts: packages/shared/src/contracts/streams.ts.
// Listener counts per Icecast mount, sampled by the api's stats poller
// (apps/api/src/modules/engine/icecast) into one-minute buckets, which are downsampled into
// one-hour buckets after a while (`downsampleListenerStats`). Counts only: no IP address,
// user agent or anything else that identifies a listener (GDPR).

export const streamListenerStat = pgTable(
  'stream_listener_stat',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    stationId: uuid('station_id')
      .notNull()
      .references(() => station.id, { onDelete: 'cascade' }),
    /** Icecast mount with its leading slash: `/vandale/mp3`. */
    mount: text('mount').notNull(),
    /** Start of the bucket (UTC). */
    bucketStart: timestamp('bucket_start', { withTimezone: true }).notNull(),
    /** 60 (minute) or 3600 (hour). */
    bucketSeconds: integer('bucket_seconds').notNull(),
    /** Samples taken during the bucket. */
    samples: integer('samples').notNull(),
    /** Sum of the sampled counts: the average is `listeners_sum / samples`. */
    listenersSum: integer('listeners_sum').notNull(),
    listenersMax: integer('listeners_max').notNull(),
    listenersMin: integer('listeners_min').notNull(),
    /** Samples where the engine was connected to the mount (the rest aired the fallback). */
    sourceSamples: integer('source_samples').notNull(),
  },
  (t) => [
    uniqueIndex('stream_listener_stat_key').on(
      t.stationId,
      t.mount,
      t.bucketSeconds,
      t.bucketStart,
    ),
    check(
      'stream_listener_stat_counts_check',
      sql`${t.bucketSeconds} in (60, 3600) and ${t.samples} > 0
        and ${t.sourceSamples} between 0 and ${t.samples}
        and ${t.listenersMin} between 0 and ${t.listenersMax}`,
    ),
  ],
);
