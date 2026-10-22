import type {
  IslandFiles,
  IslandSpec,
  IslandStatus,
  SegueInLane,
  SegueOrigin,
  SegueOutLane,
  SegueProblemCode,
  SegueStatus,
  SegueVoiceLane,
} from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { asset } from './library.ts';
import { logItem } from './log.ts';
import { station, user } from './tenancy.ts';

// Segues and islands (#55, ADR 0017). Contracts: packages/shared/src/contracts/segues.ts.
//
// A `segue` joins two log items, A → B; its lanes are jsonb (positions are samples on the
// segue's axis, 0 = A's end). Item references are `on delete set null`: deleting A or B keeps
// the recorded voice work and detaches the segue. Like the log's asset references, the scope of
// item and asset ids is checked by the repository.
//
// An `island` is derived from a run of segues (`deriveIslands`), one row per head item: its
// spec, its hash (which keys the rendered file) and its render status. Islands are rewritten
// by the sync, never edited. Their item ids carry no foreign key on purpose: when an item is
// deleted, the sync (on `log.updated`) drops the island and publishes `island.removed`, which a
// cascade would skip.

const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const segue = pgTable(
  'segue',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    fromItemId: uuid('from_item_id').references(() => logItem.id, { onDelete: 'set null' }),
    toItemId: uuid('to_item_id').references(() => logItem.id, { onDelete: 'set null' }),
    /** The assets A and B played when the segue was saved. */
    fromAssetId: uuid('from_asset_id').references(() => asset.id, { onDelete: 'set null' }),
    toAssetId: uuid('to_asset_id').references(() => asset.id, { onDelete: 'set null' }),
    outLane: jsonb('out_lane').$type<SegueOutLane>().notNull(),
    inLane: jsonb('in_lane').$type<SegueInLane>().notNull(),
    voices: jsonb('voices').$type<SegueVoiceLane[]>().notNull().default([]),
    origin: text('origin').$type<SegueOrigin>().notNull().default('manual'),
    status: text('status').$type<SegueStatus>().notNull().default('waiting'),
    problemCode: text('problem_code').$type<SegueProblemCode>(),
    problemMessage: text('problem_message'),
    islandId: uuid('island_id').references((): AnyPgColumn => island.id, {
      onDelete: 'set null',
    }),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'segue_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    // One segue per transition: one out of A, one into B.
    unique('segue_from_item_key').on(t.fromItemId),
    unique('segue_to_item_key').on(t.toItemId),
    index('segue_station_idx').on(t.stationId),
    index('segue_island_idx').on(t.islandId),
    index('segue_voices_idx').using('gin', t.voices),
    check('segue_status_check', sql`${t.status} in ('ready', 'waiting', 'detached', 'invalid')`),
    check('segue_origin_check', sql`${t.origin} in ('manual', 'auto')`),
    check('segue_problem_check', sql`(${t.problemCode} is null) = (${t.problemMessage} is null)`),
    check('segue_island_ready_check', sql`${t.islandId} is null or ${t.status} = 'ready'`),
    check('segue_version_check', sql`${t.version} >= 1`),
  ],
);

export const island = pgTable(
  'island',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    headItemId: uuid('head_item_id').notNull(),
    headAssetId: uuid('head_asset_id').notNull(),
    headJoinSample: integer('head_join_sample').notNull(),
    headHasBody: boolean('head_has_body').notNull(),
    tailItemId: uuid('tail_item_id').notNull(),
    tailAssetId: uuid('tail_asset_id').notNull(),
    tailJoinSample: integer('tail_join_sample').notNull(),
    tailHasBody: boolean('tail_has_body').notNull(),
    /** Log items covered, in play order (head … tail). */
    itemIds: uuid('item_ids').array().notNull(),
    /** Segues rendered, in play order. Mirrors `segue.island_id`, ordered. */
    segueIds: uuid('segue_ids').array().notNull(),
    specVersion: integer('spec_version').notNull(),
    spec: jsonb('spec').$type<IslandSpec>().notNull(),
    /** Playout copy hash → storage key and asset: where the renderer reads. Not hashed. */
    files: jsonb('files').$type<IslandFiles>().notNull(),
    /** SHA-256 of the spec (`islandHash`): keys the rendered file. */
    hash: text('hash').notNull(),
    lengthSamples: integer('length_samples').notNull(),
    status: text('status').$type<IslandStatus>().notNull().default('pending'),
    storageKey: text('storage_key'),
    /** SHA-256 and size of the rendered file (#56): its playout cache key. Set with `ready`. */
    fileSha256: text('file_sha256'),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }),
    error: text('error'),
    /** The render job holding the `rendering` claim (its job id, stable across its retries). */
    renderClaim: uuid('render_claim'),
    /** Claims of the current hash so far; reset with the hash. Caps transient retries. */
    renderAttempts: integer('render_attempts').notNull().default(0),
    /** When the sweep may render a `failed` island again; null: not until its spec changes. */
    retryAt: timestamp('retry_at', { withTimezone: true }),
    renderedAt: timestamp('rendered_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'island_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    unique('island_head_item_key').on(t.headItemId),
    index('island_station_status_idx').on(t.stationId, t.status),
    index('island_station_hash_idx').on(t.stationId, t.hash),
    check('island_status_check', sql`${t.status} in ('pending', 'rendering', 'ready', 'failed')`),
    check('island_ready_check', sql`${t.status} <> 'ready' or ${t.storageKey} is not null`),
    check('island_file_check', sql`(${t.fileSha256} is null) = (${t.fileSizeBytes} is null)`),
    check('island_length_check', sql`${t.lengthSamples} > 0`),
  ],
);
