import type { AsRunOutcome, AsRunSource, LogItemKind } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { station } from './tenancy.ts';

// As-run (#30). Contracts: packages/shared/src/contracts/asrun.ts.
//
// Append-only: a row is inserted when an item takes the air and only its end fields
// (`ended_at`, `end_seq`, `duration_ms`, `outcome`) are set afterwards, once. The log item,
// asset and file are snapshots, with no foreign keys: history must outlive a regenerated log
// day or a deleted asset. Only the station cascades (deleting a station deletes its history).
//
// Idempotent on the engine event: `event_id` is the deterministic id of the `track.started`
// event (station, boot, seq), so a redelivery inserts nothing.

const ms = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

export const asRunEntry = pgTable(
  'asrun_entry',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    /** Id of the engine event that recorded it (deduplication). */
    eventId: uuid('event_id').notNull(),
    bootId: text('boot_id').notNull(),
    seq: integer('seq').notNull(),
    /** Liquidsoap request id; null for live. */
    rid: text('rid'),
    source: text('source').$type<AsRunSource>().notNull(),
    logItemId: uuid('log_item_id'),
    segmentId: uuid('segment_id'),
    kind: text('kind').$type<LogItemKind>(),
    assetId: uuid('asset_id'),
    fileSha256: text('file_sha256'),
    title: text('title'),
    artist: text('artist'),
    artists: text('artists').array().notNull().default(sql`'{}'::text[]`),
    liveSessionId: uuid('live_session_id'),
    /** Engine clock, UTC. */
    startedAt: ms('started_at').notNull(),
    endedAt: ms('ended_at'),
    endSeq: integer('end_seq'),
    durationMs: integer('duration_ms'),
    outcome: text('outcome').$type<AsRunOutcome>(),
    plannedStart: ms('planned_start'),
    plannedDurationMs: integer('planned_duration_ms'),
    /** The api's clock when it was recorded. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'asrun_entry_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    unique('asrun_entry_event_key').on(t.eventId),
    unique('asrun_entry_station_boot_seq_key').on(t.stationId, t.bootId, t.seq),
    // History, now playing, log vs as-run (#53).
    index('asrun_entry_station_started_idx').on(t.stationId, t.startedAt),
    // "When did this asset last air" (#38), per-asset analytics (#42).
    index('asrun_entry_station_asset_idx').on(t.stationId, t.assetId, t.startedAt),
    // "When did this artist last air" (#38): `artists @> array[…]` within a time window.
    index('asrun_entry_artists_idx').using('gin', t.artists),
    index('asrun_entry_log_item_idx').on(t.logItemId),
    // Entries still on air, closed by the next boot.
    index('asrun_entry_open_idx').on(t.stationId, t.bootId).where(sql`${t.endedAt} is null`),
    check(
      'asrun_entry_source_check',
      sql`${t.source} in ('log', 'safety', 'emergency', 'live', 'unknown')`,
    ),
    check(
      'asrun_entry_end_check',
      sql`(${t.endedAt} is null) = (${t.outcome} is null)
        and (${t.endedAt} is null or ${t.endedAt} >= ${t.startedAt})
        and (${t.outcome} is null or ${t.outcome} in ('complete', 'cut', 'skipped', 'interrupted'))
        and (${t.durationMs} is null or ${t.durationMs} >= 0)`,
    ),
    check('asrun_entry_seq_check', sql`${t.seq} > 0`),
  ],
);
