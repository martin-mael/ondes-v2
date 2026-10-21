import {
  type AuditEntry,
  asset,
  assetFile,
  assetTag,
  auditDiff,
  createPostgresQuotaStore,
  type Db,
  type StationContext,
  type StationScope,
  scheduleStorageDeletion,
  type Tx,
  tag,
  whereStation,
  writeAuditMany,
} from '@ondes/db';
import {
  type LibraryBulk,
  type LibraryBulkResult,
  libraryBulkSchema,
  MAX_BULK_ASSETS,
} from '@ondes/shared';
import { releaseStoredObject } from '@ondes/storage';
import { and, asc, inArray, or, sql } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';
import { matchingIds, uuidArray } from './search-repo.ts';

// Bulk edits of the library (#23): tags, shared fields or deletion on a selection of assets,
// in one transaction. Each changed asset gets its own audit row, with the same action and
// diff as the single-asset routes (`asset.tag`, `asset.update`, `asset.delete`), so an
// asset's history reads the same whichever way it was edited.

type AssetRow = typeof asset.$inferSelect;

/** Applies a bulk edit. 409 `selection_changed` when a filter selection no longer matches. */
export async function bulkEdit(
  db: Db,
  ctx: StationContext,
  input: LibraryBulk,
): Promise<LibraryBulkResult> {
  const { selection, action } = libraryBulkSchema.parse(input);
  const ids =
    'ids' in selection
      ? [...new Set(selection.ids)]
      : await matchingIds(db, ctx.scope, selection.filter, MAX_BULK_ASSETS + 1);
  if (!('ids' in selection)) {
    if (ids.length > MAX_BULK_ASSETS) {
      throw new HttpError(400, 'too_many_assets', `at most ${MAX_BULK_ASSETS} assets at once`);
    }
    if (ids.length !== selection.expectedCount) {
      throw new HttpError(
        409,
        'selection_changed',
        `the filter now matches ${ids.length} assets, not ${selection.expectedCount}`,
        { count: ids.length },
      );
    }
  }

  try {
    return await db.transaction(async (tx) => {
      const before = await lockAssets(tx, ctx.scope, ids);
      if (before.length === 0) return { matched: 0, changed: 0 };
      const entries =
        action.kind === 'tags'
          ? await bulkTags(tx, ctx.scope, before, action)
          : action.kind === 'update'
            ? await bulkUpdate(tx, ctx.scope, before, action.patch)
            : await bulkDelete(tx, ctx.scope, before);
      await writeAuditMany(tx, ctx, entries);
      return { matched: before.length, changed: entries.length };
    });
  } catch (error) {
    // Another table still refers to an asset through a restricting foreign key.
    if ((error as { cause?: { code?: string } }).cause?.code === '23503') {
      throw new HttpError(409, 'asset_in_use', 'an asset is still used elsewhere');
    }
    throw error;
  }
}

/** The station's assets among `ids`, locked in id order (no deadlock between two bulk edits). */
async function lockAssets(tx: Tx, scope: StationScope, ids: string[]): Promise<AssetRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(asset)
    .where(and(whereStation(asset, scope), sql`${asset.id} = any(${uuidArray(ids)})`))
    .orderBy(asc(asset.id))
    .for('update');
}

// --- Tags --------------------------------------------------------------------------------

type TagInput = { key: (typeof tag.$inferSelect)['key']; value: string };

const tagMatch = (tags: TagInput[]) =>
  or(
    ...tags.map((t) =>
      and(sql`${tag.key} = ${t.key}`, sql`lower(${tag.value}) = lower(${t.value})`),
    ),
  );

async function tagIds(tx: Tx, scope: StationScope, tags: TagInput[]): Promise<string[]> {
  if (tags.length === 0) return [];
  const rows = await tx
    .select({ id: tag.id })
    .from(tag)
    .where(and(whereStation(tag, scope), tagMatch(tags)));
  return rows.map((r) => r.id);
}

/** `key:value` labels per asset, sorted like the single-asset audit (key, then value). */
async function tagLabels(tx: Tx, scope: StationScope, ids: string[]) {
  const rows = await tx
    .select({ assetId: assetTag.assetId, key: tag.key, value: tag.value })
    .from(assetTag)
    .innerJoin(tag, sql`${tag.id} = ${assetTag.tagId}`)
    .where(and(whereStation(assetTag, scope), sql`${assetTag.assetId} = any(${uuidArray(ids)})`))
    .orderBy(asc(tag.key), asc(sql`lower(${tag.value})`));
  const labels = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const r of rows) labels.get(r.assetId)?.push(`${r.key}:${r.value}`);
  return labels;
}

async function bulkTags(
  tx: Tx,
  scope: StationScope,
  assets: AssetRow[],
  action: { add: TagInput[]; remove: TagInput[] },
): Promise<AuditEntry[]> {
  const ids = assets.map((a) => a.id);
  const owner = { orgId: scope.orgId, stationId: scope.stationId };
  if (action.add.length > 0) {
    await tx
      .insert(tag)
      .values(action.add.map((t) => ({ ...owner, key: t.key, value: t.value })))
      .onConflictDoNothing();
  }
  const addIds = await tagIds(tx, scope, action.add);
  // A tag both added and removed stays.
  const removeIds = (await tagIds(tx, scope, action.remove)).filter((id) => !addIds.includes(id));
  const before = await tagLabels(tx, scope, ids);
  if (removeIds.length > 0) {
    await tx
      .delete(assetTag)
      .where(
        and(
          whereStation(assetTag, scope),
          sql`${assetTag.assetId} = any(${uuidArray(ids)})`,
          inArray(assetTag.tagId, removeIds),
        ),
      );
  }
  if (addIds.length > 0) {
    await tx.execute(sql`insert into ${assetTag} (asset_id, tag_id, org_id, station_id)
      select a, t, ${scope.orgId}::uuid, ${scope.stationId}::uuid
      from unnest(${uuidArray(ids)}) as a cross join unnest(${uuidArray(addIds)}) as t
      on conflict do nothing`);
  }
  const after = await tagLabels(tx, scope, ids);
  return ids.flatMap((id) => {
    const from = before.get(id) ?? [];
    const to = after.get(id) ?? [];
    if (JSON.stringify(from) === JSON.stringify(to)) return [];
    return [
      {
        action: 'asset.tag',
        entity: { type: 'asset', id },
        diff: auditDiff({ tags: from }, { tags: to }),
      },
    ];
  });
}

// --- Fields ------------------------------------------------------------------------------

async function bulkUpdate(
  tx: Tx,
  scope: StationScope,
  assets: AssetRow[],
  patch: Partial<AssetRow>,
): Promise<AuditEntry[]> {
  const conflicts = assets.filter((a) => {
    const startAt = patch.startAt !== undefined ? patch.startAt : a.startAt;
    const killAt = patch.killAt !== undefined ? patch.killAt : a.killAt;
    return startAt && killAt && killAt <= startAt;
  });
  if (conflicts.length > 0) {
    throw new HttpError(
      409,
      'kill_before_start',
      `killAt would be before startAt on ${conflicts.length} assets`,
      { count: conflicts.length, assetIds: conflicts.slice(0, 50).map((a) => a.id) },
    );
  }
  const rows = await tx
    .update(asset)
    .set(patch)
    .where(
      and(
        whereStation(asset, scope),
        sql`${asset.id} = any(${uuidArray(assets.map((a) => a.id))})`,
      ),
    )
    .returning();
  const before = new Map(assets.map((a) => [a.id, a]));
  return rows.flatMap((row) => {
    const diff = auditDiff(before.get(row.id) ?? null, row);
    if (Object.keys(diff).length === 0) return [];
    return [{ action: 'asset.update', entity: { type: 'asset', id: row.id }, diff }];
  });
}

// --- Delete ------------------------------------------------------------------------------

/**
 * Deletes the assets and their files, releasing the stored objects like `deleteAsset`: keys
 * without a reference left are queued for the storage sweep, in the same transaction.
 */
async function bulkDelete(tx: Tx, scope: StationScope, assets: AssetRow[]): Promise<AuditEntry[]> {
  const ids = uuidArray(assets.map((a) => a.id));
  const files = await tx
    .delete(assetFile)
    .where(and(whereStation(assetFile, scope), sql`${assetFile.assetId} = any(${ids})`))
    .returning({ storageKey: assetFile.storageKey });
  await tx.delete(asset).where(and(whereStation(asset, scope), sql`${asset.id} = any(${ids})`));
  const store = createPostgresQuotaStore(tx);
  const pending: string[] = [];
  const deferred = {
    delete: async (key: string) => {
      pending.push(key);
    },
  };
  for (const { storageKey } of files) {
    await releaseStoredObject(deferred, store, scope.orgId, storageKey);
  }
  await scheduleStorageDeletion(tx, scope.orgId, pending);
  return assets.map((a) => ({
    action: 'asset.delete',
    entity: { type: 'asset', id: a.id },
    diff: auditDiff(a, null, ['orgId', 'stationId']),
  }));
}
