import type { AsRunOutcome, AsRunSource, EpisodeFallbackKind, LogItemKind } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
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

// As-run (#30, ADR 0015). Contracts: packages/shared/src/contracts/asrun.ts.
//
// Append-only: a row is inserted when an item takes the air; afterwards its end is set once,
// in one update: `ended_at`, `duration_ms`, `outcome`, and `end_seq` (the `track.ended` that
// closed it; null when a restart closed it). The log item, asset and file are snapshots, with
// no foreign keys: history must outlive a regenerated log day or a deleted asset. Only the
// station cascades (deleting a station deletes its history).
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
    /** The engine's `item_id` as received (matches `track.ended`; may be no log item of ours). */
    engineItemId: text('engine_item_id'),
    /** Set only when it is a log item of this station. */
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
    /** The item aired as the fallback of a missing episode (#47): what stood in for it. */
    fallback: text('fallback').$type<EpisodeFallbackKind>(),
    /**
     * The show episode it aired (#48), a snapshot like the rest (no foreign key): id, show and
     * number as they were, and whether it aired again (now playing's "rerun" flag).
     */
    episodeId: uuid('episode_id'),
    showId: uuid('show_id'),
    episodeNumber: integer('episode_number'),
    rerun: boolean('rerun').notNull().default(false),
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
    check(
      'asrun_entry_episode_check',
      sql`(${t.episodeId} is null) = (${t.episodeNumber} is null)
        and (${t.episodeId} is null) = (${t.showId} is null)
        and (${t.episodeId} is not null or not ${t.rerun})`,
    ),
    check(
      'asrun_entry_fallback_check',
      sql`${t.fallback} is null or ${t.fallback} in ('latest_episode', 'episode', 'clock_music')`,
    ),
  ],
);
