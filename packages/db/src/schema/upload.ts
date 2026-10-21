import type { AssetType, UploadErrorCode, UploadStatus } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { station } from './tenancy.ts';

// Uploads (#18). Contracts: packages/shared/src/contracts/library-jobs.ts.
//
// One row per file sent by the browser, from the multipart upload to the end of ingest. It is
// the per-file status the UI shows (queued, ingested, duplicate, quarantined, …). The uploaded
// bytes sit under `staging_key` (not content-addressed, not reference-counted) until ingest
// has stored the asset's own files; ingest then deletes them. Quarantined files keep them for
// inspection until the upload row is deleted.

export const upload = pgTable(
  'upload',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    status: text('status').$type<UploadStatus>().notNull().default('uploading'),
    filename: text('filename').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    contentType: text('content_type'),
    assetType: text('asset_type').$type<AssetType>().notNull(),
    /** `org/<orgId>/uploads/<id>`: where the browser's parts land. */
    stagingKey: text('staging_key').notNull(),
    /** S3 multipart upload id, while `uploading`. */
    s3UploadId: text('s3_upload_id'),
    partSize: integer('part_size').notNull(),
    partCount: integer('part_count').notNull(),
    sha256: text('sha256'),
    /**
     * Bumped by each retry of a failed upload; part of the ingest job key
     * (`upload:<id>:<generation>`), so a retry is a new unit of work.
     */
    generation: integer('generation').notNull().default(0),
    /**
     * While another upload of the station ingests the same file: that upload. It settles this
     * one (duplicate, quarantined or failed like itself) when it finishes.
     */
    waitingOnUploadId: uuid('waiting_on_upload_id'),
    /** Asset created by ingest. Not a foreign key: the asset may be deleted later. */
    assetId: uuid('asset_id'),
    duplicateOfAssetId: uuid('duplicate_of_asset_id'),
    errorCode: text('error_code').$type<UploadErrorCode>(),
    error: text('error'),
    /** User who created it, when it came from a person. */
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    foreignKey({
      name: 'upload_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    index('upload_station_id_idx').on(t.stationId, t.id),
    index('upload_station_status_idx').on(t.stationId, t.status),
    // Dedupe of concurrent uploads of one file (see repos/upload.ts).
    index('upload_station_sha256_idx').on(t.stationId, t.sha256),
    // Sweeps of stale `uploading` and stuck `queued` uploads, across tenants.
    index('upload_status_updated_idx').on(t.status, t.updatedAt),
    check(
      'upload_status_check',
      sql`${t.status} in ('uploading', 'queued', 'processing', 'ingested', 'duplicate', 'quarantined', 'failed', 'aborted')`,
    ),
    check('upload_size_check', sql`${t.sizeBytes} >= 0`),
    check('upload_parts_check', sql`${t.partSize} > 0 and ${t.partCount} > 0`),
  ],
);
