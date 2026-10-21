import type { QuotaStore, Storage } from '@ondes/storage';
import { and, eq, lte, sql } from 'drizzle-orm';
import type { Db, Executor } from '../client.ts';
import { storageDeletion } from '../schema/storage.ts';

// Postgres implementation of @ondes/storage's `QuotaStore` port (#17, follow-up of #7):
// `storage_object` holds a reference count per (org, key), `org_storage_usage` the org's
// counter. Each counter change is one SQL statement, so concurrent references to the same key
// are charged once: Postgres serializes them on the `storage_object` row.
//
// Pass a transaction to tie the counters to a mutation (an asset file insert, an asset
// delete); pass the pool otherwise.

/** postgres.js returns `bigint` columns of raw queries as strings. */
const num = (value: unknown): number => Number(value ?? 0);

export function createPostgresQuotaStore(db: Executor): QuotaStore {
  return {
    async get(orgId) {
      const rows = await db.execute<{ used_bytes: string; limit_bytes: string | null }>(sql`
        select used_bytes, limit_bytes from org_storage_usage where org_id = ${orgId}`);
      const row = rows[0];
      return {
        usedBytes: num(row?.used_bytes),
        limitBytes: row?.limit_bytes == null ? null : num(row.limit_bytes),
      };
    },

    async addReference(orgId, key, sizeBytes) {
      // The usage row is charged only when this statement created the reference (ref_count 1).
      // A new reference also cancels a pending bucket delete of the same key (`revived`); it
      // waits on the sweeper's row lock, so it never races an in-flight delete.
      const rows = await db.execute<{ ref_count: string; used_bytes: string }>(sql`
        with revived as (
          delete from storage_deletion where org_id = ${orgId} and key = ${key}
        ), obj as (
          insert into storage_object (org_id, key, size_bytes, ref_count)
          values (${orgId}, ${key}, ${sizeBytes}, 1)
          on conflict (org_id, key) do update set
            ref_count = storage_object.ref_count + 1,
            size_bytes = case when storage_object.ref_count = 0
              then excluded.size_bytes else storage_object.size_bytes end
          returning ref_count, size_bytes
        ), usage as (
          insert into org_storage_usage (org_id, used_bytes)
          select ${orgId}, case when obj.ref_count = 1 then obj.size_bytes else 0 end from obj
          on conflict (org_id) do update set
            used_bytes = org_storage_usage.used_bytes + excluded.used_bytes,
            updated_at = now()
          returning used_bytes
        )
        select obj.ref_count, usage.used_bytes from obj, usage`);
      const row = rows[0];
      if (!row) throw new Error('storage reference upsert returned no row');
      return { usedBytes: num(row.used_bytes), firstReference: num(row.ref_count) === 1 };
    },

    async removeReference(orgId, key) {
      // `ref_count > 0` is re-checked on the latest row version under concurrency, so two
      // concurrent removals of the last two references yield exactly one `lastReference`.
      const rows = await db.execute<{ ref_count: string | null; used_bytes: string | null }>(sql`
        with obj as (
          update storage_object set ref_count = ref_count - 1
          where org_id = ${orgId} and key = ${key} and ref_count > 0
          returning ref_count, size_bytes
        ), usage as (
          update org_storage_usage set
            used_bytes = greatest(0, org_storage_usage.used_bytes - obj.size_bytes),
            updated_at = now()
          from obj
          where org_storage_usage.org_id = ${orgId} and obj.ref_count = 0
          returning org_storage_usage.used_bytes
        )
        select
          (select ref_count from obj) as ref_count,
          coalesce(
            (select used_bytes from usage),
            (select used_bytes from org_storage_usage where org_id = ${orgId})
          ) as used_bytes`);
      const row = rows[0];
      const lastReference = row?.ref_count != null && num(row.ref_count) === 0;
      if (lastReference) {
        // Tidy up. A concurrent addReference that revived the row makes this a no-op.
        await db.execute(sql`
          delete from storage_object
          where org_id = ${orgId} and key = ${key} and ref_count = 0`);
      }
      return { usedBytes: num(row?.used_bytes), lastReference };
    },

    async set(orgId, usedBytes) {
      await db.execute(sql`
        insert into org_storage_usage (org_id, used_bytes) values (${orgId}, ${usedBytes})
        on conflict (org_id) do update set used_bytes = excluded.used_bytes, updated_at = now()`);
    },
  };
}

/** Sets an org's storage limit in bytes (`null`: unlimited). */
export async function setOrgStorageLimit(
  db: Executor,
  orgId: string,
  limitBytes: number | null,
): Promise<void> {
  await db.execute(sql`
    insert into org_storage_usage (org_id, limit_bytes) values (${orgId}, ${limitBytes})
    on conflict (org_id) do update set limit_bytes = excluded.limit_bytes, updated_at = now()`);
}

// --- Deferred bucket deletes -------------------------------------------------------------

/**
 * Queues objects whose last reference was just released (in the same transaction), instead of
 * deleting them from the bucket inline. See `storageDeletion`.
 */
export async function scheduleStorageDeletion(
  db: Executor,
  orgId: string,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    await db
      .insert(storageDeletion)
      .values({ orgId, key })
      .onConflictDoUpdate({
        target: [storageDeletion.orgId, storageDeletion.key],
        set: { releasedAt: sql`now()`, attempts: 0, lastError: null },
      });
  }
}

export interface SweepOptions {
  /** How long a released object waits before it's deleted. Default 1 hour. */
  graceMs?: number;
  /** Rows handled per call. Default 100. */
  limit?: number;
}

export interface SweepResult {
  deleted: string[];
  /** Referenced again since release: the row was dropped, the object kept. */
  revived: string[];
  /** Bucket delete failed: kept for the next sweep, with `attempts` and `last_error`. */
  failed: string[];
}

/**
 * Deletes released objects from the bucket once their grace period is over. Each row is
 * handled in its own transaction holding its row lock (`for update skip locked`, so several
 * workers can sweep at once), and the object is deleted only if no `storage_object` row
 * references it. A concurrent `addReference` waits on that lock, then re-creates the reference;
 * whoever then needs the object must check it exists (and upload it again) after charging it.
 */
export async function sweepStorageDeletions(
  db: Db,
  storage: Pick<Storage, 'delete'>,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const graceMs = options.graceMs ?? 60 * 60 * 1000;
  const result: SweepResult = { deleted: [], revived: [], failed: [] };
  const due = await db
    .select({ orgId: storageDeletion.orgId, key: storageDeletion.key })
    .from(storageDeletion)
    .where(lte(storageDeletion.releasedAt, sql`now() - ${`${graceMs} milliseconds`}::interval`))
    .orderBy(storageDeletion.releasedAt)
    .limit(options.limit ?? 100);

  for (const { orgId, key } of due) {
    await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        select 1 from storage_deletion where org_id = ${orgId} and key = ${key}
        for update skip locked`);
      if (locked.length === 0) return; // Another sweeper has it, or it was revived.
      const referenced = await tx.execute(sql`
        select 1 from storage_object where org_id = ${orgId} and key = ${key} and ref_count > 0`);
      const where = and(eq(storageDeletion.orgId, orgId), eq(storageDeletion.key, key));
      if (referenced.length > 0) {
        await tx.delete(storageDeletion).where(where);
        result.revived.push(key);
        return;
      }
      try {
        await storage.delete(key);
      } catch (error) {
        await tx
          .update(storageDeletion)
          .set({
            attempts: sql`${storageDeletion.attempts} + 1`,
            lastError: String(error instanceof Error ? error.message : error).slice(0, 1000),
          })
          .where(where);
        result.failed.push(key);
        return;
      }
      await tx.delete(storageDeletion).where(where);
      result.deleted.push(key);
    });
  }
  return result;
}
