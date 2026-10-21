import {
  type Asset,
  type AssetAnalysis,
  type AssetCues,
  type AssetDetail,
  type AssetFile,
  type AssetLoudness,
  type AssetPage,
  type AutoCues,
  autoCuesSchema,
  type CreateAsset,
  type CreateAssetFile,
  CUE_FIELDS,
  type CueField,
  type CuePoint,
  createAssetFileSchema,
  createAssetSchema,
  getPlayoutGain,
  type ListAssetsQuery,
  listAssetsQuerySchema,
  type SetAnalysis,
  type SetAssetTags,
  type SetLoudness,
  setAnalysisSchema,
  setAssetTagsSchema,
  setLoudnessSchema,
  type Tag,
  type UpdateAsset,
  type UpdateCues,
  updateAssetSchema,
  updateCuesSchema,
} from '@ondes/shared';
import { orgPrefix, releaseStoredObject } from '@ondes/storage';
import { and, asc, desc, eq, exists, ilike, lt, notInArray, or, type SQL, sql } from 'drizzle-orm';
import { auditDiff, withAudit } from '../audit.ts';
import type { Db, Executor, Tx } from '../client.ts';
import { NotFoundError } from '../errors.ts';
import {
  asset,
  assetAnalysis,
  assetCues,
  assetFile,
  assetLoudness,
  assetTag,
  tag,
} from '../schema/library.ts';
import { type StationScope, whereStation } from '../tenant.ts';
import { createPostgresQuotaStore, scheduleStorageDeletion } from './storage.ts';
import { getStation, type StationContext } from './tenancy.ts';

// Library repositories (#17). Reads take a station scope and filter on it; mutations go through
// `withAudit`. Stored objects are reference-counted in `storage_object`: adding a file charges
// its key in the same transaction, and deleting an asset (or replacing a file) releases keys
// through @ondes/storage's `releaseStoredObject` in the same transaction, deleting the objects
// that lost their last reference only after the commit.

type Writer = Db | Tx;

/** Input that is valid on its own but breaks a rule given the stored state (map it to 409). */
export class LibraryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryConflictError';
  }
}

/**
 * Stored objects an operation released for good (no reference left in the org). They're
 * queued in `storage_deletion` and removed from the bucket by `sweepStorageDeletions` after a
 * grace period; nothing is deleted inline.
 */
export interface ReleasedObjects {
  scheduled: string[];
}

// --- Assets ------------------------------------------------------------------------------

type AssetRow = typeof asset.$inferSelect;
const toAsset = (row: AssetRow): Asset => row;

/** Creates an asset with no files yet (ingest adds them). */
export async function createAsset(
  db: Writer,
  ctx: StationContext,
  input: CreateAsset,
): Promise<Asset> {
  const values = createAssetSchema.parse(input);
  return withAudit(db, ctx, async (tx, audit) => {
    const [row] = await tx
      .insert(asset)
      .values({ ...values, orgId: ctx.scope.orgId, stationId: ctx.scope.stationId })
      .returning();
    if (!row) throw new Error('insert returned no row');
    await audit({
      action: 'asset.create',
      entity: { type: 'asset', id: row.id },
      diff: auditDiff(null, row, ['orgId', 'stationId']),
    });
    return toAsset(row);
  });
}

export async function getAsset(db: Executor, scope: StationScope, id: string): Promise<Asset> {
  const [row] = await db
    .select()
    .from(asset)
    .where(and(eq(asset.id, id), whereStation(asset, scope)));
  if (!row) throw new NotFoundError('asset', id);
  return toAsset(row);
}

/** Locks the asset row for the rest of the transaction. */
async function lockAsset(tx: Tx, scope: StationScope, id: string): Promise<AssetRow> {
  const [row] = await tx
    .select()
    .from(asset)
    .where(and(eq(asset.id, id), whereStation(asset, scope)))
    .for('update');
  if (!row) throw new NotFoundError('asset', id);
  return row;
}

/** The asset with its files, cues, loudness (and the playout gain it gives), analysis and tags. */
export async function getAssetDetail(
  db: Executor,
  scope: StationScope,
  id: string,
): Promise<AssetDetail> {
  const base = await getAsset(db, scope, id);
  const [files, cues, loudness, analysis, tags, station] = await Promise.all([
    listAssetFiles(db, scope, id),
    getCues(db, scope, id),
    getLoudness(db, scope, id),
    getAnalysis(db, scope, id),
    listAssetTags(db, scope, id),
    getStation(db, scope, scope.stationId),
  ]);
  const playoutGain = getPlayoutGain({ ...base, loudness }, station);
  return { ...base, files, cues, loudness, playoutGain, analysis, tags };
}

/** Newest first, keyset-paginated on the (time-ordered) id. */
export async function listAssets(
  db: Executor,
  scope: StationScope,
  query: ListAssetsQuery = {},
): Promise<AssetPage> {
  const q = listAssetsQuerySchema.parse(query);
  const conditions: SQL[] = [whereStation(asset, scope)];
  if (q.type) conditions.push(eq(asset.type, q.type));
  if (q.cursor) conditions.push(lt(asset.id, q.cursor));
  if (q.q) {
    const pattern = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const match = or(
      ilike(asset.title, pattern),
      ilike(asset.album, pattern),
      ilike(sql`array_to_string(${asset.artists}, ' ')`, pattern),
    );
    if (match) conditions.push(match);
  }
  if (q.tag) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(assetTag)
          .innerJoin(tag, eq(tag.id, assetTag.tagId))
          .where(
            and(
              eq(assetTag.assetId, asset.id),
              eq(tag.key, q.tag.key),
              sql`lower(${tag.value}) = lower(${q.tag.value})`,
            ),
          ),
      ),
    );
  }
  const rows = await db
    .select()
    .from(asset)
    .where(and(...conditions))
    .orderBy(desc(asset.id))
    .limit(q.limit + 1);
  const items = rows.slice(0, q.limit).map(toAsset);
  const nextCursor = rows.length > q.limit ? (items.at(-1)?.id ?? null) : null;
  return { items, nextCursor };
}

export async function updateAsset(
  db: Writer,
  ctx: StationContext,
  id: string,
  input: UpdateAsset,
): Promise<Asset> {
  const values = updateAssetSchema.parse(input);
  return withAudit(db, ctx, async (tx, audit) => {
    const before = await lockAsset(tx, ctx.scope, id);
    const startAt = values.startAt !== undefined ? values.startAt : before.startAt;
    const killAt = values.killAt !== undefined ? values.killAt : before.killAt;
    if (startAt && killAt && killAt <= startAt) {
      throw new LibraryConflictError('killAt must be after startAt');
    }
    const [row] = await tx
      .update(asset)
      .set(values)
      .where(and(eq(asset.id, id), whereStation(asset, ctx.scope)))
      .returning();
    if (!row) throw new NotFoundError('asset', id);
    await audit({
      action: 'asset.update',
      entity: { type: 'asset', id },
      diff: auditDiff(before, row),
    });
    return toAsset(row);
  });
}

/**
 * Deletes an asset and everything attached to it, releasing its stored objects. An object no
 * other asset of the org references is queued for deletion; `sweepStorageDeletions` removes
 * it from the bucket after a grace period, unless something references it again first.
 */
export async function deleteAsset(
  db: Db,
  ctx: StationContext,
  id: string,
): Promise<ReleasedObjects> {
  const pending = await withAudit(db, ctx, async (tx, audit) => {
    const before = await lockAsset(tx, ctx.scope, id);
    const files = await tx
      .delete(assetFile)
      .where(and(eq(assetFile.assetId, id), whereStation(assetFile, ctx.scope)))
      .returning({ storageKey: assetFile.storageKey });
    await tx.delete(asset).where(and(eq(asset.id, id), whereStation(asset, ctx.scope)));
    const pending = await releaseKeys(
      tx,
      ctx.scope,
      files.map((f) => f.storageKey),
    );
    await audit({
      action: 'asset.delete',
      entity: { type: 'asset', id },
      diff: auditDiff(before, null, ['orgId', 'stationId']),
    });
    return pending;
  });
  return { scheduled: pending };
}

/**
 * Drops one reference per key through `releaseStoredObject`, against a quota store bound to
 * the transaction. Keys whose last reference went are queued for deletion in the same
 * transaction, so a rollback cancels both.
 */
async function releaseKeys(tx: Tx, scope: StationScope, keys: string[]): Promise<string[]> {
  const store = createPostgresQuotaStore(tx);
  const pending: string[] = [];
  const deferred = {
    delete: async (key: string) => {
      pending.push(key);
    },
  };
  for (const key of keys) await releaseStoredObject(deferred, store, scope.orgId, key);
  await scheduleStorageDeletion(tx, scope.orgId, pending);
  return pending;
}

// --- Files -------------------------------------------------------------------------------

type AssetFileRow = typeof assetFile.$inferSelect;
const toAssetFile = (row: AssetFileRow): AssetFile => row;

export async function listAssetFiles(
  db: Executor,
  scope: StationScope,
  assetId: string,
): Promise<AssetFile[]> {
  const rows = await db
    .select()
    .from(assetFile)
    .where(and(eq(assetFile.assetId, assetId), whereStation(assetFile, scope)))
    .orderBy(asc(assetFile.role));
  return rows.map(toAssetFile);
}

/**
 * Attaches a stored file to an asset in the given role, replacing the previous file of that
 * role. The new key is charged in the same transaction (once per org, however many assets
 * share it); the replaced key is released like on delete. Pass a transaction to tie it to other
 * writes (ingest creates the asset and both its files at once).
 */
export async function putAssetFile(
  db: Writer,
  ctx: StationContext,
  assetId: string,
  input: CreateAssetFile,
): Promise<{ file: AssetFile; released: ReleasedObjects }> {
  const values = createAssetFileSchema.parse(input);
  if (!values.storageKey.startsWith(orgPrefix(ctx.scope.orgId))) {
    throw new LibraryConflictError(`storage key outside the org: ${values.storageKey}`);
  }
  const { file, pending } = await withAudit(db, ctx, async (tx, audit) => {
    await lockAsset(tx, ctx.scope, assetId);
    const [previous] = await tx
      .delete(assetFile)
      .where(
        and(
          eq(assetFile.assetId, assetId),
          eq(assetFile.role, values.role),
          whereStation(assetFile, ctx.scope),
        ),
      )
      .returning();
    await createPostgresQuotaStore(tx).addReference(
      ctx.scope.orgId,
      values.storageKey,
      values.sizeBytes,
    );
    const [row] = await tx
      .insert(assetFile)
      .values({ ...values, assetId, orgId: ctx.scope.orgId, stationId: ctx.scope.stationId })
      .returning();
    if (!row) throw new Error('insert returned no row');
    const pending = previous ? await releaseKeys(tx, ctx.scope, [previous.storageKey]) : [];
    await audit({
      action: 'asset_file.put',
      entity: { type: 'asset', id: assetId },
      diff: auditDiff(previous ?? null, row, ['assetId', 'orgId', 'stationId']),
    });
    return { file: toAssetFile(row), pending };
  });
  return { file, released: { scheduled: pending } };
}

// --- Cues --------------------------------------------------------------------------------

type CuesRow = typeof assetCues.$inferSelect;
type CuesInsert = typeof assetCues.$inferInsert;
type CueColumns = {
  [K in CueField]: { samples: K; source: `${K}Source`; locked: `${K}Locked` };
};
const cueColumns = Object.fromEntries(
  CUE_FIELDS.map((field) => [
    field,
    { samples: field, source: `${field}Source`, locked: `${field}Locked` },
  ]),
) as CueColumns;

function cuePointOf(row: CuesRow, field: CueField): CuePoint {
  const c = cueColumns[field];
  return { samples: row[c.samples], source: row[c.source], locked: row[c.locked] };
}

function toCues(row: CuesRow): AssetCues {
  const points = Object.fromEntries(CUE_FIELDS.map((f) => [f, cuePointOf(row, f)])) as Record<
    CueField,
    CuePoint
  >;
  return {
    assetId: row.assetId,
    sampleRate: row.sampleRate,
    analyzerVersion: row.analyzerVersion,
    ...points,
    updatedAt: row.updatedAt,
  };
}

export async function getCues(
  db: Executor,
  scope: StationScope,
  assetId: string,
): Promise<AssetCues | null> {
  const [row] = await db
    .select()
    .from(assetCues)
    .where(and(eq(assetCues.assetId, assetId), whereStation(assetCues, scope)));
  return row ? toCues(row) : null;
}

/** Current points, defaulting to empty `auto` points when the asset has no cue row yet. */
function currentPoints(row: CuesRow | undefined): Record<CueField, CuePoint> {
  return Object.fromEntries(
    CUE_FIELDS.map((f) => [
      f,
      row ? cuePointOf(row, f) : { samples: null, source: 'auto', locked: false },
    ]),
  ) as Record<CueField, CuePoint>;
}

function cueValues(points: Record<CueField, CuePoint>): Partial<CuesInsert> {
  const values: Record<string, unknown> = {};
  for (const field of CUE_FIELDS) {
    const c = cueColumns[field];
    values[c.samples] = points[field].samples;
    values[c.source] = points[field].source;
    values[c.locked] = points[field].locked;
  }
  return values as Partial<CuesInsert>;
}

function assertCueOrder(points: Record<CueField, CuePoint>): void {
  const cueIn = points.cueIn.samples;
  const cueOut = points.cueOut.samples;
  if (cueIn !== null && cueOut !== null && cueOut <= cueIn) {
    throw new LibraryConflictError('cueOut must be after cueIn');
  }
}

async function writeCues(
  tx: Tx,
  scope: StationScope,
  assetId: string,
  existing: CuesRow | undefined,
  sampleRate: number,
  analyzerVersion: string | null,
  points: Record<CueField, CuePoint>,
): Promise<CuesRow> {
  assertCueOrder(points);
  const values = { sampleRate, analyzerVersion, ...cueValues(points) };
  const [row] = existing
    ? await tx
        .update(assetCues)
        .set(values)
        .where(and(eq(assetCues.assetId, assetId), whereStation(assetCues, scope)))
        .returning()
    : await tx
        .insert(assetCues)
        .values({ ...values, assetId, orgId: scope.orgId, stationId: scope.stationId })
        .returning();
  if (!row) throw new Error('cue upsert returned no row');
  return row;
}

async function lockCues(tx: Tx, scope: StationScope, assetId: string) {
  await lockAsset(tx, scope, assetId);
  const [row] = await tx
    .select()
    .from(assetCues)
    .where(and(eq(assetCues.assetId, assetId), whereStation(assetCues, scope)))
    .for('update');
  return row;
}

/**
 * Manual cue edit (the cue editor). A point given `samples` becomes `manual`; `locked` keeps
 * autocue away from it. `sampleRate` is needed for the first write and must match afterwards.
 */
export async function updateCues(
  db: Writer,
  ctx: StationContext,
  assetId: string,
  input: UpdateCues,
): Promise<AssetCues> {
  const patch = updateCuesSchema.parse(input);
  return withAudit(db, ctx, async (tx, audit) => {
    const existing = await lockCues(tx, ctx.scope, assetId);
    const sampleRate = resolveSampleRate(existing, patch.sampleRate);
    const points = currentPoints(existing);
    for (const field of CUE_FIELDS) {
      const change = patch[field];
      if (!change) continue;
      const point = { ...points[field] };
      if (change.samples !== undefined) {
        point.samples = change.samples;
        point.source = 'manual';
      }
      if (change.locked !== undefined) point.locked = change.locked;
      points[field] = point;
    }
    const row = await writeCues(
      tx,
      ctx.scope,
      assetId,
      existing,
      sampleRate,
      existing?.analyzerVersion ?? null,
      points,
    );
    await audit({
      action: 'asset_cues.update',
      entity: { type: 'asset', id: assetId },
      diff: auditDiff(existing ?? null, row, ['assetId', 'orgId', 'stationId']),
    });
    return toCues(row);
  });
}

/** Autocue results. Only unlocked `auto` points change; manual edits always win. */
export async function setAutoCues(
  db: Writer,
  ctx: StationContext,
  assetId: string,
  input: AutoCues,
): Promise<AssetCues> {
  const values = autoCuesSchema.parse(input);
  return withAudit(db, ctx, async (tx, audit) => {
    const existing = await lockCues(tx, ctx.scope, assetId);
    const sampleRate = resolveSampleRate(existing, values.sampleRate);
    const points = currentPoints(existing);
    for (const field of CUE_FIELDS) {
      const samples = values.points[field];
      const point = points[field];
      if (samples === undefined || point.locked || point.source === 'manual') continue;
      points[field] = { ...point, samples };
    }
    const row = await writeCues(
      tx,
      ctx.scope,
      assetId,
      existing,
      sampleRate,
      values.analyzerVersion,
      points,
    );
    await audit({
      action: 'asset_cues.autocue',
      entity: { type: 'asset', id: assetId },
      diff: auditDiff(existing ?? null, row, ['assetId', 'orgId', 'stationId']),
    });
    return toCues(row);
  });
}

function resolveSampleRate(existing: CuesRow | undefined, given: number | undefined): number {
  if (!existing) {
    if (given === undefined) throw new LibraryConflictError('sampleRate is required for new cues');
    return given;
  }
  if (given !== undefined && given !== existing.sampleRate) {
    throw new LibraryConflictError(`cues are stored at ${existing.sampleRate} Hz, got ${given} Hz`);
  }
  return existing.sampleRate;
}

// --- Loudness and analysis ---------------------------------------------------------------

export async function getLoudness(
  db: Executor,
  scope: StationScope,
  assetId: string,
): Promise<AssetLoudness | null> {
  const [row] = await db
    .select()
    .from(assetLoudness)
    .where(and(eq(assetLoudness.assetId, assetId), whereStation(assetLoudness, scope)));
  if (!row) return null;
  const { orgId: _o, stationId: _s, ...loudness } = row;
  return loudness;
}

/** Stores a loudness measurement, replacing the previous one. */
export async function setLoudness(
  db: Writer,
  ctx: StationContext,
  assetId: string,
  input: SetLoudness,
): Promise<AssetLoudness> {
  const values = { ...setLoudnessSchema.parse(input), measuredAt: new Date() };
  return withAudit(db, ctx, async (tx, audit) => {
    await lockAsset(tx, ctx.scope, assetId);
    const before = await getLoudness(tx, ctx.scope, assetId);
    const [row] = await tx
      .insert(assetLoudness)
      .values({ ...values, assetId, orgId: ctx.scope.orgId, stationId: ctx.scope.stationId })
      .onConflictDoUpdate({ target: assetLoudness.assetId, set: values })
      .returning();
    if (!row) throw new Error('upsert returned no row');
    const { orgId: _o, stationId: _s, ...after } = row;
    await audit({
      action: 'asset_loudness.set',
      entity: { type: 'asset', id: assetId },
      diff: auditDiff(before, after, ['assetId', 'measuredAt']),
    });
    return after;
  });
}

/**
 * Assets of the station that have a playout file but no loudness measurement, oldest first:
 * what the loudness backfill (#19) enqueues. Keyset-paginated on the asset id.
 */
export async function listAssetsWithoutLoudness(
  db: Executor,
  scope: StationScope,
  options: { limit: number; after?: string },
): Promise<{ assetId: string; playoutSha256: string }[]> {
  return db
    .select({ assetId: assetFile.assetId, playoutSha256: assetFile.sha256 })
    .from(assetFile)
    .leftJoin(assetLoudness, eq(assetLoudness.assetId, assetFile.assetId))
    .where(
      and(
        whereStation(assetFile, scope),
        eq(assetFile.role, 'playout'),
        sql`${assetLoudness.assetId} is null`,
        options.after ? sql`${assetFile.assetId} > ${options.after}` : undefined,
      ),
    )
    .orderBy(asc(assetFile.assetId))
    .limit(options.limit);
}

export async function getAnalysis(
  db: Executor,
  scope: StationScope,
  assetId: string,
): Promise<AssetAnalysis | null> {
  const [row] = await db
    .select()
    .from(assetAnalysis)
    .where(and(eq(assetAnalysis.assetId, assetId), whereStation(assetAnalysis, scope)));
  if (!row) return null;
  const { orgId: _o, stationId: _s, ...analysis } = row;
  return analysis;
}

/** Stores a musical analysis, replacing the previous one. */
export async function setAnalysis(
  db: Writer,
  ctx: StationContext,
  assetId: string,
  input: SetAnalysis,
): Promise<AssetAnalysis> {
  const parsed = setAnalysisSchema.parse(input);
  const values = { ...parsed, features: parsed.features ?? {}, analyzedAt: new Date() };
  return withAudit(db, ctx, async (tx, audit) => {
    await lockAsset(tx, ctx.scope, assetId);
    const before = await getAnalysis(tx, ctx.scope, assetId);
    const [row] = await tx
      .insert(assetAnalysis)
      .values({ ...values, assetId, orgId: ctx.scope.orgId, stationId: ctx.scope.stationId })
      .onConflictDoUpdate({ target: assetAnalysis.assetId, set: values })
      .returning();
    if (!row) throw new Error('upsert returned no row');
    const { orgId: _o, stationId: _s, ...after } = row;
    await audit({
      action: 'asset_analysis.set',
      entity: { type: 'asset', id: assetId },
      diff: auditDiff(before, after, ['assetId', 'analyzedAt']),
    });
    return after;
  });
}

// --- Tags --------------------------------------------------------------------------------

const tagColumns = { id: tag.id, key: tag.key, value: tag.value };

/** The station's tag vocabulary, by key then value. */
export async function listTags(db: Executor, scope: StationScope): Promise<Tag[]> {
  return db
    .select(tagColumns)
    .from(tag)
    .where(whereStation(tag, scope))
    .orderBy(asc(tag.key), asc(sql`lower(${tag.value})`));
}

export async function listAssetTags(
  db: Executor,
  scope: StationScope,
  assetId: string,
): Promise<Tag[]> {
  return db
    .select(tagColumns)
    .from(assetTag)
    .innerJoin(tag, eq(tag.id, assetTag.tagId))
    .where(and(eq(assetTag.assetId, assetId), whereStation(assetTag, scope)))
    .orderBy(asc(tag.key), asc(sql`lower(${tag.value})`));
}

/**
 * Replaces an asset's tags. Unknown `key = value` pairs join the station's vocabulary;
 * matching is case-insensitive and keeps the first spelling.
 */
export async function setAssetTags(
  db: Writer,
  ctx: StationContext,
  assetId: string,
  input: SetAssetTags,
): Promise<Tag[]> {
  const { tags } = setAssetTagsSchema.parse(input);
  const byName = new Map<string, (typeof tags)[number]>();
  for (const t of tags) {
    const name = `${t.key}\u0000${t.value.toLowerCase()}`;
    if (!byName.has(name)) byName.set(name, t);
  }
  const unique = [...byName.values()];
  return withAudit(db, ctx, async (tx, audit) => {
    await lockAsset(tx, ctx.scope, assetId);
    const before = await listAssetTags(tx, ctx.scope, assetId);
    const scope = { orgId: ctx.scope.orgId, stationId: ctx.scope.stationId };
    if (unique.length > 0) {
      await tx
        .insert(tag)
        .values(unique.map((t) => ({ ...scope, key: t.key, value: t.value })))
        .onConflictDoNothing();
    }
    const wanted =
      unique.length === 0
        ? []
        : await tx
            .select({ id: tag.id })
            .from(tag)
            .where(
              and(
                whereStation(tag, ctx.scope),
                or(
                  ...unique.map((t) =>
                    and(eq(tag.key, t.key), sql`lower(${tag.value}) = lower(${t.value})`),
                  ),
                ),
              ),
            );
    const wantedIds = wanted.map((t) => t.id);
    await tx
      .delete(assetTag)
      .where(
        and(
          eq(assetTag.assetId, assetId),
          whereStation(assetTag, ctx.scope),
          wantedIds.length > 0 ? notInArray(assetTag.tagId, wantedIds) : undefined,
        ),
      );
    if (wantedIds.length > 0) {
      await tx
        .insert(assetTag)
        .values(wantedIds.map((tagId) => ({ ...scope, assetId, tagId })))
        .onConflictDoNothing();
    }
    const after = await listAssetTags(tx, ctx.scope, assetId);
    const label = (list: Tag[]) => list.map((t) => `${t.key}:${t.value}`);
    await audit({
      action: 'asset.tag',
      entity: { type: 'asset', id: assetId },
      diff: auditDiff({ tags: label(before) }, { tags: label(after) }),
    });
    return after;
  });
}
