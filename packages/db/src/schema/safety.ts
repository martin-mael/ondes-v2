import type { CacheFileError, EngineSource, FallbackKind } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { asset } from './library.ts';
import { station } from './tenancy.ts';

// Safety playlist and emergency file (#34). Contracts: packages/shared/src/contracts/safety.ts.
//
// The selection points at library assets with the library's composite foreign key on
// (asset_id, org_id, station_id), so it can't name another tenant's asset, and deleting an
// asset drops it from the selection. The worker's cache-sync pass (#31) mirrors what it put in
// the engine's cache into `station_fallback_file`.

const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** One asset of a station's safety playlist. */
export const stationSafetyAsset = pgTable(
  'station_safety_asset',
  {
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    assetId: uuid('asset_id').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'station_safety_asset_pkey', columns: [t.stationId, t.assetId] }),
    foreignKey({
      name: 'station_safety_asset_asset_fk',
      columns: [t.assetId, t.orgId, t.stationId],
      foreignColumns: [asset.id, asset.orgId, asset.stationId],
    }).onDelete('cascade'),
    index('station_safety_asset_asset_idx').on(t.assetId),
  ],
);

/** A station's emergency file: one asset, looped by the engine when nothing else plays. */
export const stationEmergencyAsset = pgTable(
  'station_emergency_asset',
  {
    stationId: uuid('station_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    assetId: uuid('asset_id').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'station_emergency_asset_asset_fk',
      columns: [t.assetId, t.orgId, t.stationId],
      foreignColumns: [asset.id, asset.orgId, asset.stationId],
    }).onDelete('cascade'),
    index('station_emergency_asset_asset_idx').on(t.assetId),
  ],
);

/**
 * A fallback file the worker put in the station's cache (`ready`), or failed to (`failed`).
 * Replaced as a whole by each sync: a selected file without a row is pending.
 */
export const stationFallbackFile = pgTable(
  'station_fallback_file',
  {
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    kind: text('kind').$type<FallbackKind>().notNull(),
    sha256: text('sha256').notNull(),
    state: text('state').$type<'ready' | 'failed'>().notNull(),
    error: text('error').$type<CacheFileError>(),
    errorMessage: text('error_message'),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: 'station_fallback_file_pkey',
      columns: [t.stationId, t.kind, t.sha256],
    }),
    foreignKey({
      name: 'station_fallback_file_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    check('station_fallback_file_kind_check', sql`${t.kind} in ('safety', 'emergency')`),
    check(
      'station_fallback_file_state_check',
      sql`${t.state} in ('ready', 'failed') and (${t.state} = 'failed') = (${t.error} is not null)`,
    ),
  ],
);

/**
 * Per-station fallback state: when the worker last synced the files, and what the engine has
 * on air (from `engine.track.started`), for "safety mode".
 */
export const stationFallbackState = pgTable(
  'station_fallback_state',
  {
    stationId: uuid('station_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    onAirSource: text('on_air_source').$type<EngineSource>(),
    /** When the engine switched to `on_air_source` (consecutive tracks of one source keep it). */
    onAirSince: timestamp('on_air_since', { withTimezone: true }),
    /** Time of the last engine event applied, so a late one can't overwrite a newer state. */
    onAirEventAt: timestamp('on_air_event_at', { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'station_fallback_state_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    check(
      'station_fallback_state_source_check',
      sql`${t.onAirSource} is null or ${t.onAirSource} in ('live', 'queue', 'safety', 'emergency', 'unknown')`,
    ),
  ],
);
