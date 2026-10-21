import type { CacheFileError, CacheFileState } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { station } from './tenancy.ts';

// Playout cache (#31, ADR 0004). Contracts: packages/shared/src/contracts/cache.ts.
//
// The worker owns each station's cache directory; these tables mirror it for the api and the
// feeder (#29). A `ready` row is written only after the file was renamed into place, and every
// pass reconciles the rows with its disk scan, so a row can't claim a missing file for longer
// than one pass (the engine's 422 catches the rest).

const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** One file of a station's cache: on disk (`ready`) or whose last fetch failed. */
export const playoutCacheFile = pgTable(
  'playout_cache_file',
  {
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    sha256: text('sha256').notNull(),
    ext: text('ext').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    state: text('state').$type<CacheFileState>().notNull(),
    error: text('error').$type<CacheFileError>(),
    /** Last error message, for the logs and the UI. */
    errorMessage: text('error_message'),
    /** Failed attempts since the last success. */
    attempts: integer('attempts').notNull().default(0),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    /** Last planned air time of the items that use it (the LRU stamp, also the file's mtime). */
    lastNeededAt: timestamp('last_needed_at', { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'playout_cache_file_pkey', columns: [t.stationId, t.sha256] }),
    foreignKey({
      name: 'playout_cache_file_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    index('playout_cache_file_station_state_idx').on(t.stationId, t.state),
    check('playout_cache_file_state_check', sql`${t.state} in ('ready', 'failed')`),
    check(
      'playout_cache_file_error_check',
      sql`(${t.state} = 'failed') = (${t.error} is not null)
        and (${t.error} is null or ${t.error} in ('source_missing', 'checksum_mismatch', 'io'))`,
    ),
    check('playout_cache_file_size_check', sql`${t.sizeBytes} >= 0`),
  ],
);

/**
 * Per-station cache settings and the outcome of the last pass. Settings left null use the
 * worker's defaults (40 GB budget, 48 h horizon, no bandwidth cap).
 */
export const stationCache = pgTable(
  'station_cache',
  {
    stationId: uuid('station_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    budgetBytes: bigint('budget_bytes', { mode: 'number' }),
    horizonHours: integer('horizon_hours'),
    /** Shared download cap for the station, bytes per second. */
    bytesPerSec: bigint('bytes_per_sec', { mode: 'number' }),
    /** Last pass: bytes on disk, bytes the horizon needs, files that didn't fit the budget. */
    usedBytes: bigint('used_bytes', { mode: 'number' }).notNull().default(0),
    horizonBytes: bigint('horizon_bytes', { mode: 'number' }).notNull().default(0),
    /** Hashes deferred by the budget, in air-time order (bounded). */
    deferred: text('deferred').array().notNull().default(sql`'{}'::text[]`),
    /** Fetching paused: the host filesystem is under its free-space reserve. */
    diskLow: boolean('disk_low').notNull().default(false),
    /** Last pass that ran to the end. */
    lastPassAt: timestamp('last_pass_at', { withTimezone: true }),
    /** Last pass that failed (disk, database, configuration), and why. */
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    lastError: text('last_error'),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'station_cache_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    check(
      'station_cache_settings_check',
      sql`(${t.budgetBytes} is null or ${t.budgetBytes} > 0)
        and (${t.horizonHours} is null or ${t.horizonHours} between 1 and 168)
        and (${t.bytesPerSec} is null or ${t.bytesPerSec} > 0)`,
    ),
  ],
);
