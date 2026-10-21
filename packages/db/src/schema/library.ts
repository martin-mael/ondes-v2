import type { AssetFileRole, AssetMetadata, AssetType, CueSource, TagKey } from '@ondes/shared';
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
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { station } from './tenancy.ts';

// Library (#17). Contracts: packages/shared/src/contracts/library.ts.
//
// Every table carries `org_id` and `station_id`. Child tables point at the asset with a
// composite foreign key on (asset_id, org_id, station_id), so a row can never be attached to
// an asset of another tenant. An asset belongs to one station today; sharing it with the
// org's other stations will be an added link table (`asset_share (asset_id, station_id)`),
// not a change to these ones.

const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const orgId = () => uuid('org_id').notNull();
const stationId = () => uuid('station_id').notNull();
const assetId = () => uuid('asset_id').notNull();

export const asset = pgTable(
  'asset',
  {
    id: id(),
    orgId: orgId(),
    stationId: stationId(),
    type: text('type').$type<AssetType>().notNull(),
    title: text('title').notNull(),
    artists: text('artists').array().notNull().default(sql`'{}'::text[]`),
    album: text('album'),
    year: integer('year'),
    isrc: text('isrc'),
    version: text('version'),
    durationMs: integer('duration_ms'),
    explicit: boolean('explicit').notNull().default(false),
    startAt: timestamp('start_at', { withTimezone: true }),
    killAt: timestamp('kill_at', { withTimezone: true }),
    notes: text('notes'),
    metadata: jsonb('metadata').$type<AssetMetadata>().notNull().default({}),
    sourceFilename: text('source_filename'),
    /** Loudness normalisation at playout (#19); off plays the file as it is. */
    normalizeLoudness: boolean('normalize_loudness').notNull().default(true),
    /** Fixed playout gain in dB instead of the measured one (#19). */
    gainOverrideDb: real('gain_override_db'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'asset_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    // Target of the child tables' composite foreign keys.
    unique('asset_id_org_station_key').on(t.id, t.orgId, t.stationId),
    index('asset_station_id_idx').on(t.stationId, t.id),
    index('asset_station_type_idx').on(t.stationId, t.type),
    index('asset_isrc_idx').on(t.isrc),
    check(
      'asset_type_check',
      sql`${t.type} in ('song', 'vt', 'jingle', 'bed', 'episode', 'other')`,
    ),
    check('asset_kill_after_start_check', sql`${t.killAt} > ${t.startAt}`),
    check('asset_duration_check', sql`${t.durationMs} >= 0`),
    check('asset_gain_override_check', sql`${t.gainOverrideDb} between -60 and 24`),
  ],
);

/** Composite foreign key from a child table to its asset, within the same tenant. */
function assetFk(
  name: string,
  t: { assetId: AnyPgColumn; orgId: AnyPgColumn; stationId: AnyPgColumn },
) {
  return foreignKey({
    name,
    columns: [t.assetId, t.orgId, t.stationId],
    foreignColumns: [asset.id, asset.orgId, asset.stationId],
  }).onDelete('cascade');
}

/**
 * Stored files of an asset, one per role. `storage_key` is counted in `storage_object`:
 * adding a file charges a reference, deleting the asset releases it (src/repos/library.ts).
 */
export const assetFile = pgTable(
  'asset_file',
  {
    id: id(),
    assetId: assetId(),
    orgId: orgId(),
    stationId: stationId(),
    role: text('role').$type<AssetFileRole>().notNull(),
    storageKey: text('storage_key').notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    codec: text('codec').notNull(),
    mimeType: text('mime_type'),
    sampleRate: integer('sample_rate'),
    channels: integer('channels'),
    bitDepth: integer('bit_depth'),
    durationSamples: bigint('duration_samples', { mode: 'number' }),
    /** FLAC block size in samples; the splice grid of islands (spike #12). */
    flacBlockSize: integer('flac_block_size'),
    createdAt: createdAt(),
  },
  (t) => [
    assetFk('asset_file_asset_fk', t),
    unique('asset_file_asset_role_key').on(t.assetId, t.role),
    index('asset_file_station_id_idx').on(t.stationId),
    // Dedupe at ingest: "does this org already have this content?"
    index('asset_file_org_sha256_idx').on(t.orgId, t.sha256),
    index('asset_file_org_key_idx').on(t.orgId, t.storageKey),
    check('asset_file_role_check', sql`${t.role} in ('master', 'playout', 'peaks')`),
    check('asset_file_size_check', sql`${t.sizeBytes} >= 0`),
    check(
      'asset_file_playout_flac_check',
      sql`${t.role} <> 'playout' or (${t.codec} = 'flac' and ${t.flacBlockSize} is not null and ${t.sampleRate} is not null)`,
    ),
  ],
);

/** Cue point columns: position (samples), who set it, and whether autocue may change it. */
const cuePoint = (name: string) => ({
  samples: bigint(name, { mode: 'number' }),
  source: text(`${name}_source`).$type<CueSource>().notNull().default('auto'),
  locked: boolean(`${name}_locked`).notNull().default(false),
});
const cueIn = cuePoint('cue_in');
const cueOut = cuePoint('cue_out');
const introEnd = cuePoint('intro_end');
const outroStart = cuePoint('outro_start');
const fadeIn = cuePoint('fade_in');
const fadeOut = cuePoint('fade_out');
const crossStartNext = cuePoint('cross_start_next');

/**
 * Cue points as sample positions at `sample_rate` (fades are durations in samples), so islands
 * can splice sample-exactly. One row per asset.
 */
export const assetCues = pgTable(
  'asset_cues',
  {
    assetId: uuid('asset_id').primaryKey(),
    orgId: orgId(),
    stationId: stationId(),
    sampleRate: integer('sample_rate').notNull(),
    analyzerVersion: text('analyzer_version'),
    cueIn: cueIn.samples,
    cueInSource: cueIn.source,
    cueInLocked: cueIn.locked,
    cueOut: cueOut.samples,
    cueOutSource: cueOut.source,
    cueOutLocked: cueOut.locked,
    introEnd: introEnd.samples,
    introEndSource: introEnd.source,
    introEndLocked: introEnd.locked,
    outroStart: outroStart.samples,
    outroStartSource: outroStart.source,
    outroStartLocked: outroStart.locked,
    fadeIn: fadeIn.samples,
    fadeInSource: fadeIn.source,
    fadeInLocked: fadeIn.locked,
    fadeOut: fadeOut.samples,
    fadeOutSource: fadeOut.source,
    fadeOutLocked: fadeOut.locked,
    crossStartNext: crossStartNext.samples,
    crossStartNextSource: crossStartNext.source,
    crossStartNextLocked: crossStartNext.locked,
    updatedAt: updatedAt(),
  },
  (t) => [
    assetFk('asset_cues_asset_fk', t),
    index('asset_cues_station_id_idx').on(t.stationId),
    check('asset_cues_sample_rate_check', sql`${t.sampleRate} > 0`),
    check(
      'asset_cues_non_negative_check',
      sql`${t.cueIn} >= 0 and ${t.cueOut} >= 0 and ${t.introEnd} >= 0 and ${t.outroStart} >= 0
        and ${t.fadeIn} >= 0 and ${t.fadeOut} >= 0 and ${t.crossStartNext} >= 0`,
    ),
    check('asset_cues_in_before_out_check', sql`${t.cueOut} > ${t.cueIn}`),
    check(
      'asset_cues_source_check',
      sql`${t.cueInSource} in ('auto', 'manual') and ${t.cueOutSource} in ('auto', 'manual')
        and ${t.introEndSource} in ('auto', 'manual') and ${t.outroStartSource} in ('auto', 'manual')
        and ${t.fadeInSource} in ('auto', 'manual') and ${t.fadeOutSource} in ('auto', 'manual')
        and ${t.crossStartNextSource} in ('auto', 'manual')`,
    ),
  ],
);

/** EBU R128 measurement of the asset, one row per asset (latest analysis wins). */
export const assetLoudness = pgTable(
  'asset_loudness',
  {
    assetId: uuid('asset_id').primaryKey(),
    orgId: orgId(),
    stationId: stationId(),
    integratedLufs: real('integrated_lufs').notNull(),
    loudnessRangeLu: real('loudness_range_lu'),
    truePeakDbtp: real('true_peak_dbtp'),
    analyzer: text('analyzer').notNull(),
    analyzerVersion: text('analyzer_version').notNull(),
    confidence: real('confidence'),
    measuredAt: timestamp('measured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    assetFk('asset_loudness_asset_fk', t),
    index('asset_loudness_station_id_idx').on(t.stationId),
    check('asset_loudness_confidence_check', sql`${t.confidence} between 0 and 1`),
  ],
);

/** Musical analysis (BPM, key, energy), one row per asset (latest analysis wins). */
export const assetAnalysis = pgTable(
  'asset_analysis',
  {
    assetId: uuid('asset_id').primaryKey(),
    orgId: orgId(),
    stationId: stationId(),
    bpm: real('bpm'),
    musicalKey: text('musical_key'),
    energy: real('energy'),
    confidence: real('confidence'),
    analyzer: text('analyzer').notNull(),
    analyzerVersion: text('analyzer_version').notNull(),
    features: jsonb('features').$type<Record<string, unknown>>().notNull().default({}),
    analyzedAt: timestamp('analyzed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    assetFk('asset_analysis_asset_fk', t),
    index('asset_analysis_station_id_idx').on(t.stationId),
    check('asset_analysis_confidence_check', sql`${t.confidence} between 0 and 1`),
    check('asset_analysis_energy_check', sql`${t.energy} between 0 and 1`),
  ],
);

/** Station vocabulary of `key = value` tags. Values are unique per key, case-insensitively. */
export const tag = pgTable(
  'tag',
  {
    id: id(),
    orgId: orgId(),
    stationId: stationId(),
    key: text('key').$type<TagKey>().notNull(),
    value: text('value').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'tag_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    uniqueIndex('tag_station_key_value_key').on(t.stationId, t.key, sql`lower(${t.value})`),
    unique('tag_id_org_station_key').on(t.id, t.orgId, t.stationId),
  ],
);

export const assetTag = pgTable(
  'asset_tag',
  {
    assetId: assetId(),
    tagId: uuid('tag_id').notNull(),
    orgId: orgId(),
    stationId: stationId(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'asset_tag_pkey', columns: [t.assetId, t.tagId] }),
    assetFk('asset_tag_asset_fk', t),
    foreignKey({
      name: 'asset_tag_tag_fk',
      columns: [t.tagId, t.orgId, t.stationId],
      foreignColumns: [tag.id, tag.orgId, tag.stationId],
    }).onDelete('cascade'),
    index('asset_tag_tag_id_idx').on(t.tagId),
    index('asset_tag_station_id_idx').on(t.stationId),
  ],
);
