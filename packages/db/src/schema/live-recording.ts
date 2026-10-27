import type { LiveRecordingPartStatus, LiveRecordingStatus } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { station } from './tenancy.ts';

// Live recording (#67, ADR 0039). Contracts: packages/shared/src/contracts/live-recording.ts.
//
// Its own domain file: it hangs off live sessions and episodes through plain columns only
// (like `live_session`, ADR 0033: a recording is history, and its row outlives a deleted
// episode, whose audio asset then goes with it).
//
// - `live_recording_settings`: one row per station, absent = the defaults.
// - `live_recording_part`: one engine file (one live session on air), unique per station and
//   file name, inserted by the api from the engine's `live.recording.*` events.
// - `live_recording`: what the parts are joined into: one per episode, or one per session
//   that airs no episode (ad hoc, events). `version` counts the parts closed into it, so the
//   worker builds each version once.

export const LIVE_RECORDING_STATUSES = [
  'recording',
  'pending',
  'processing',
  'ready',
  'failed',
  'expired',
  'skipped',
] as const satisfies readonly LiveRecordingStatus[];

export const LIVE_RECORDING_PART_STATUSES = [
  'recording',
  'closed',
  'interrupted',
  'deleted',
] as const satisfies readonly LiveRecordingPartStatus[];

const inList = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v}'`).join(', '));

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const liveRecordingSettings = pgTable(
  'live_recording_settings',
  {
    stationId: uuid('station_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Null: kept for good. */
    retentionDays: integer('retention_days'),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'live_recording_settings_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    check(
      'live_recording_settings_retention_check',
      sql`${t.retentionDays} is null or ${t.retentionDays} between 1 and 3650`,
    ),
  ],
);

export const liveRecording = pgTable(
  'live_recording',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    /** The episode whose audio it is; null for a session that airs no episode. */
    episodeId: uuid('episode_id'),
    showId: uuid('show_id'),
    /** For a recording without episode: its one session. */
    sessionId: uuid('session_id'),
    /** The show's name or the event's title, as it aired (for the library asset's title). */
    title: text('title'),
    status: text('status').$type<LiveRecordingStatus>().notNull().default('recording'),
    version: integer('version').notNull().default(0),
    /** The version the asset was built from. */
    builtVersion: integer('built_version'),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    /** The upload the build went through, and the asset it made. Plain columns. */
    uploadId: uuid('upload_id'),
    assetId: uuid('asset_id'),
    error: text('error'),
    builtAt: timestamp('built_at', { withTimezone: true }),
    buildMs: integer('build_ms'),
    /** End of the last part: what the retention counts from. */
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'live_recording_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    uniqueIndex('live_recording_episode_key')
      .on(t.stationId, t.episodeId)
      .where(sql`${t.episodeId} is not null`),
    uniqueIndex('live_recording_session_key')
      .on(t.stationId, t.sessionId)
      .where(sql`${t.episodeId} is null`),
    check('live_recording_owner_check', sql`${t.episodeId} is not null or ${t.sessionId} is not null`),
    check('live_recording_status_check', sql`${t.status} in (${inList(LIVE_RECORDING_STATUSES)})`),
    check('live_recording_version_check', sql`${t.version} >= 0`),
    // The retention sweep, across tenants.
    index('live_recording_status_ended_idx').on(t.status, t.endedAt),
  ],
);

export const liveRecordingPart = pgTable(
  'live_recording_part',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    /** Bare file name in the station's recordings directory. */
    file: text('file').notNull(),
    sessionId: uuid('session_id').notNull(),
    /** Set once the part is assigned to a recording (when it closes). */
    recordingId: uuid('recording_id').references(() => liveRecording.id, { onDelete: 'set null' }),
    /** The engine boot that wrote it: a later boot interrupts it. */
    bootId: text('boot_id').notNull(),
    status: text('status').$type<LiveRecordingPartStatus>().notNull().default('recording'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'live_recording_part_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    unique('live_recording_part_file_key').on(t.stationId, t.file),
    index('live_recording_part_recording_idx').on(t.recordingId, t.startedAt),
    index('live_recording_part_session_idx').on(t.stationId, t.sessionId),
    index('live_recording_part_status_idx').on(t.status, t.updatedAt),
    check(
      'live_recording_part_status_check',
      sql`${t.status} in (${inList(LIVE_RECORDING_PART_STATUSES)})`,
    ),
  ],
);
