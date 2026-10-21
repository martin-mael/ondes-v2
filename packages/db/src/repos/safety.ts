import type {
  CacheFileError,
  EngineSource,
  FallbackAsset,
  FallbackCache,
  FallbackKind,
  TagKey,
} from '@ondes/shared';
import { and, asc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { Executor } from '../client.ts';
import { NotFoundError } from '../errors.ts';
import { alert } from '../schema/alerts.ts';
import { stationEngine } from '../schema/engine.ts';
import { asset, assetFile, assetTag, tag } from '../schema/library.ts';
import {
  stationEmergencyAsset,
  stationFallbackFile,
  stationFallbackState,
  stationSafetyAsset,
} from '../schema/safety.ts';
import { type StationScope, whereStation } from '../tenant.ts';

// Safety playlist and emergency file (#34): the selection (api), the files the worker put in
// the engine's cache (worker), and what the engine has on air (api, from engine events).

// --- Selection ---------------------------------------------------------------------------

type SelectionRow = {
  assetId: string;
  type: FallbackAsset['type'];
  title: string;
  artists: string[];
  durationMs: number | null;
  addedAt: Date;
  sha256: string | null;
  sizeBytes: number | null;
  storageKey: string | null;
};

const selectionColumns = {
  assetId: asset.id,
  type: asset.type,
  title: asset.title,
  artists: asset.artists,
  durationMs: asset.durationMs,
  sha256: assetFile.sha256,
  sizeBytes: assetFile.sizeBytes,
  storageKey: assetFile.storageKey,
};

const playoutJoin = and(eq(assetFile.assetId, asset.id), eq(assetFile.role, 'playout'));

async function safetyRows(db: Executor, scope: StationScope): Promise<SelectionRow[]> {
  return db
    .select({ ...selectionColumns, addedAt: stationSafetyAsset.addedAt })
    .from(stationSafetyAsset)
    .innerJoin(asset, eq(asset.id, stationSafetyAsset.assetId))
    .leftJoin(assetFile, playoutJoin)
    .where(whereStation(stationSafetyAsset, scope))
    .orderBy(asc(sql`lower(${asset.title})`), asc(asset.id));
}

async function emergencyRow(db: Executor, scope: StationScope): Promise<SelectionRow | null> {
  const [row] = await db
    .select({ ...selectionColumns, addedAt: stationEmergencyAsset.updatedAt })
    .from(stationEmergencyAsset)
    .innerJoin(asset, eq(asset.id, stationEmergencyAsset.assetId))
    .leftJoin(assetFile, playoutJoin)
    .where(whereStation(stationEmergencyAsset, scope));
  return row ?? null;
}

/** Cache state of a selected asset's file from the worker's rows. */
export function fallbackCacheOf(
  sha256: string | null,
  files: ReadonlyMap<string, FallbackFileRow>,
): FallbackCache {
  if (!sha256) return { state: 'no_file', error: null, errorMessage: null };
  const f = files.get(sha256);
  if (!f) return { state: 'pending', error: null, errorMessage: null };
  return { state: f.state, error: f.error ?? null, errorMessage: f.errorMessage ?? null };
}

export type FallbackFileRow = typeof stationFallbackFile.$inferSelect;

export type FallbackSelection = {
  safety: FallbackAsset[];
  emergency: FallbackAsset | null;
  syncedAt: Date | null;
  onAir: { source: EngineSource; startedAt: Date } | null;
};

/** The station's selection with each file's cache state, for the api and its alerts. */
export async function getFallbackSelection(
  db: Executor,
  scope: StationScope,
): Promise<FallbackSelection> {
  const [safety, emergency, files, state] = await Promise.all([
    safetyRows(db, scope),
    emergencyRow(db, scope),
    db.select().from(stationFallbackFile).where(whereStation(stationFallbackFile, scope)),
    getFallbackState(db, scope),
  ]);
  const byKind = (kind: FallbackKind) =>
    new Map(files.filter((f) => f.kind === kind).map((f) => [f.sha256, f]));
  const toAsset = (r: SelectionRow, kind: FallbackKind): FallbackAsset => ({
    assetId: r.assetId,
    type: r.type,
    title: r.title,
    artists: r.artists,
    durationMs: r.durationMs,
    sha256: r.sha256,
    cache: fallbackCacheOf(r.sha256, byKind(kind)),
    addedAt: r.addedAt,
  });
  return {
    safety: safety.map((r) => toAsset(r, 'safety')),
    emergency: emergency ? toAsset(emergency, 'emergency') : null,
    syncedAt: state?.syncedAt ?? null,
    onAir:
      state?.onAirSource && state.onAirSince
        ? { source: state.onAirSource, startedAt: state.onAirSince }
        : null,
  };
}

/** Ids of the station's assets among `assetIds`; throws NotFoundError if one isn't. */
async function assertStationAssets(db: Executor, scope: StationScope, assetIds: string[]) {
  const unique = [...new Set(assetIds)];
  if (unique.length === 0) return unique;
  const found = await db
    .select({ id: asset.id })
    .from(asset)
    .where(and(whereStation(asset, scope), inArray(asset.id, unique)));
  const ids = new Set(found.map((f) => f.id));
  const missing = unique.find((id) => !ids.has(id));
  if (missing) throw new NotFoundError('asset', missing);
  return unique;
}

export type SafetySelectionChange = { added: string[]; removed: string[] };

/** Replaces the safety playlist. Returns the asset ids added and removed. */
export async function setSafetyAssets(
  db: Executor,
  scope: StationScope,
  assetIds: string[],
): Promise<SafetySelectionChange> {
  const wanted = await assertStationAssets(db, scope, assetIds);
  const removed = await db
    .delete(stationSafetyAsset)
    .where(
      and(
        whereStation(stationSafetyAsset, scope),
        wanted.length > 0 ? notInArray(stationSafetyAsset.assetId, wanted) : undefined,
      ),
    )
    .returning({ assetId: stationSafetyAsset.assetId });
  const added = await insertSafetyAssets(db, scope, wanted);
  return { added, removed: removed.map((r) => r.assetId) };
}

async function insertSafetyAssets(db: Executor, scope: StationScope, assetIds: string[]) {
  if (assetIds.length === 0) return [];
  const rows = await db
    .insert(stationSafetyAsset)
    .values(
      assetIds.map((assetId) => ({ orgId: scope.orgId, stationId: scope.stationId, assetId })),
    )
    .onConflictDoNothing()
    .returning({ assetId: stationSafetyAsset.assetId });
  return rows.map((r) => r.assetId);
}

/** Adds assets to the safety playlist; returns the ids that weren't in it yet. */
export async function addSafetyAssets(
  db: Executor,
  scope: StationScope,
  assetIds: string[],
): Promise<string[]> {
  return insertSafetyAssets(db, scope, await assertStationAssets(db, scope, assetIds));
}

/** The station's assets carrying a tag (value compared case-insensitively). */
export async function listAssetIdsByTag(
  db: Executor,
  scope: StationScope,
  t: { key: TagKey; value: string },
  limit: number,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: assetTag.assetId })
    .from(assetTag)
    .innerJoin(tag, eq(tag.id, assetTag.tagId))
    .where(
      and(
        whereStation(tag, scope),
        eq(tag.key, t.key),
        sql`lower(${tag.value}) = lower(${t.value})`,
      ),
    )
    .limit(limit);
  return rows.map((r) => r.id);
}

/** Number of assets in the safety playlist. */
export async function countSafetyAssets(db: Executor, scope: StationScope): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(stationSafetyAsset)
    .where(whereStation(stationSafetyAsset, scope));
  return row?.n ?? 0;
}

/** Removes one asset from the safety playlist; false if it wasn't in it. */
export async function removeSafetyAsset(
  db: Executor,
  scope: StationScope,
  assetId: string,
): Promise<boolean> {
  const rows = await db
    .delete(stationSafetyAsset)
    .where(and(whereStation(stationSafetyAsset, scope), eq(stationSafetyAsset.assetId, assetId)))
    .returning({ assetId: stationSafetyAsset.assetId });
  return rows.length > 0;
}

/** Sets or clears the emergency file. Returns the previous asset id. */
export async function setEmergencyAsset(
  db: Executor,
  scope: StationScope,
  assetId: string | null,
): Promise<{ before: string | null }> {
  const [current] = await db
    .select({ assetId: stationEmergencyAsset.assetId })
    .from(stationEmergencyAsset)
    .where(whereStation(stationEmergencyAsset, scope))
    .for('update');
  const before = current?.assetId ?? null;
  if (assetId === null) {
    await db.delete(stationEmergencyAsset).where(whereStation(stationEmergencyAsset, scope));
    return { before };
  }
  await assertStationAssets(db, scope, [assetId]);
  await db
    .insert(stationEmergencyAsset)
    .values({ orgId: scope.orgId, stationId: scope.stationId, assetId })
    .onConflictDoUpdate({
      target: stationEmergencyAsset.stationId,
      set: { assetId, updatedAt: new Date() },
    });
  return { before };
}

// --- Worker: what to put in the cache, what it holds -------------------------------------

/** A playout file the worker pins in the station's cache. */
export type FallbackSource = {
  assetId: string;
  sha256: string;
  sizeBytes: number;
  storageKey: string;
};

export type FallbackSources = {
  safety: FallbackSource[];
  emergency: FallbackSource | null;
  /** An emergency asset is selected, even if it has no playout file yet. */
  emergencySelected: boolean;
};

/**
 * The playout files of the station's selection. Assets without a playout file (not ingested
 * yet) are left out: there is nothing to fetch.
 */
export async function listFallbackSources(
  db: Executor,
  scope: StationScope,
): Promise<FallbackSources> {
  const [safety, emergency] = await Promise.all([safetyRows(db, scope), emergencyRow(db, scope)]);
  const source = (r: SelectionRow): FallbackSource | null =>
    r.sha256 && r.sizeBytes !== null && r.storageKey
      ? { assetId: r.assetId, sha256: r.sha256, sizeBytes: r.sizeBytes, storageKey: r.storageKey }
      : null;
  return {
    safety: safety.map(source).filter((s): s is FallbackSource => s !== null),
    emergency: emergency ? source(emergency) : null,
    emergencySelected: emergency !== null,
  };
}

export type FallbackFileInput = {
  kind: FallbackKind;
  sha256: string;
  state: 'ready' | 'failed';
  error?: CacheFileError;
  errorMessage?: string;
};

/** Replaces the station's fallback file rows with what a sync found, and stamps the sync. */
export async function recordFallbackSync(
  db: Executor,
  scope: StationScope,
  files: FallbackFileInput[],
  at: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(stationFallbackFile).where(whereStation(stationFallbackFile, scope));
    const unique = new Map(files.map((f) => [`${f.kind}:${f.sha256}`, f]));
    if (unique.size > 0) {
      await tx.insert(stationFallbackFile).values(
        [...unique.values()].map((f) => ({
          orgId: scope.orgId,
          stationId: scope.stationId,
          kind: f.kind,
          sha256: f.sha256,
          state: f.state,
          error: f.state === 'failed' ? (f.error ?? 'io') : null,
          errorMessage: f.errorMessage ?? null,
        })),
      );
    }
    await tx
      .insert(stationFallbackState)
      .values({ orgId: scope.orgId, stationId: scope.stationId, syncedAt: at })
      .onConflictDoUpdate({ target: stationFallbackState.stationId, set: { syncedAt: at } });
  });
}

// --- On air ------------------------------------------------------------------------------

export type FallbackState = typeof stationFallbackState.$inferSelect;

export async function getFallbackState(
  db: Executor,
  scope: StationScope,
): Promise<FallbackState | null> {
  const [row] = await db
    .select()
    .from(stationFallbackState)
    .where(whereStation(stationFallbackState, scope));
  return row ?? null;
}

/**
 * Records what the engine has on air (`null` after a boot or when it went down). Consecutive
 * events of the same source keep its `since`; an event older than the last one applied is
 * ignored. Returns whether it applied.
 */
export async function recordOnAirSource(
  db: Executor,
  scope: StationScope,
  input: { source: EngineSource | null; at: Date },
): Promise<boolean> {
  const t = stationFallbackState;
  const rows = await db
    .insert(t)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      onAirSource: input.source,
      onAirSince: input.source ? input.at : null,
      onAirEventAt: input.at,
    })
    .onConflictDoUpdate({
      target: t.stationId,
      set: {
        onAirSource: input.source,
        onAirSince: input.source
          ? sql`case when ${t.onAirSource} is not distinct from ${input.source} and ${t.onAirSince} is not null then ${t.onAirSince} else ${input.at.toISOString()}::timestamptz end`
          : null,
        onAirEventAt: input.at,
      },
      setWhere: or(
        isNull(t.onAirEventAt),
        sql`${t.onAirEventAt} <= ${input.at.toISOString()}::timestamptz`,
      ),
    })
    .returning({ stationId: t.stationId });
  return rows.length > 0;
}

// --- Alerts ------------------------------------------------------------------------------

/** Whether the station's engine should be running (`station_engine.desired_state`). */
export async function isStationEngineRunning(db: Executor, scope: StationScope): Promise<boolean> {
  const [row] = await db
    .select({ desiredState: stationEngine.desiredState })
    .from(stationEngine)
    .where(whereStation(stationEngine, scope));
  return row?.desiredState === 'running';
}

/**
 * Stations whose fallbacks are checked: every station whose engine should be running, and
 * every station with an open alert of these types (so it resolves once the engine stops).
 */
export async function listFallbackAlertStations(
  db: Executor,
  alertTypes: readonly string[],
): Promise<Array<{ orgId: string; stationId: string; engineRunning: boolean }>> {
  const [running, alerted] = await Promise.all([
    db
      .select({ orgId: stationEngine.orgId, stationId: stationEngine.stationId })
      .from(stationEngine)
      .where(eq(stationEngine.desiredState, 'running')),
    alertTypes.length === 0
      ? Promise.resolve([])
      : db
          .selectDistinct({ orgId: alert.orgId, stationId: alert.stationId })
          .from(alert)
          .where(and(isNull(alert.resolvedAt), inArray(alert.type, [...alertTypes]))),
  ]);
  const out = new Map<string, { orgId: string; stationId: string; engineRunning: boolean }>();
  for (const s of alerted) out.set(s.stationId, { ...s, engineRunning: false });
  for (const s of running) out.set(s.stationId, { ...s, engineRunning: true });
  return [...out.values()];
}
