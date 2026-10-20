import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organization } from './tenancy.ts';

// Storage accounting (#17, follow-up of #7): the Postgres side of @ondes/storage's `QuotaStore`
// port. Implemented by `createPostgresQuotaStore` (src/repos/storage.ts).

/**
 * One row per stored object an org references. Content-addressed keys are shared between an
 * org's assets, so the object is charged on the first reference and deleted on the last.
 * Rows that drop to zero references are removed.
 */
export const storageObject = pgTable(
  'storage_object',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    refCount: bigint('ref_count', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'storage_object_pkey', columns: [t.orgId, t.key] }),
    check('storage_object_size_check', sql`${t.sizeBytes} >= 0`),
    check('storage_object_ref_count_check', sql`${t.refCount} >= 0`),
  ],
);

/** Bytes an org stores, and its limit (`null`: unlimited). Missing row: nothing stored yet. */
export const orgStorageUsage = pgTable(
  'org_storage_usage',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => organization.id, { onDelete: 'cascade' }),
    usedBytes: bigint('used_bytes', { mode: 'number' }).notNull().default(0),
    limitBytes: bigint('limit_bytes', { mode: 'number' }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [check('org_storage_usage_used_check', sql`${t.usedBytes} >= 0`)],
);
