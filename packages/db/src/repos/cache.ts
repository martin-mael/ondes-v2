import {
  type CacheFileError,
  type CacheMissingReason,
  type CacheReadiness,
  cacheExtOf,
} from '@ondes/shared';
import { and, asc, eq, gt, inArray, isNotNull, lt, ne, notInArray, sql } from 'drizzle-orm';
import type { Db, Executor } from '../client.ts';
import { playoutCacheFile, stationCache } from '../schema/cache.ts';
import { assetFile } from '../schema/library.ts';
import { logDay, logItem } from '../schema/log.ts';
import { station } from '../schema/tenancy.ts';
import { type StationScope, whereStation } from '../tenant.ts';

// Playout cache (#31, ADR 0004): the log horizon as files, the worker's record of what is on
// each station's disk, and readiness for the feeder (#29) and the dashboard.

/** One log item that plays a file, with that file (null when the asset has no playout file). */
export type CacheHorizonItem = {
  logItemId: string;
  airAt: Date;
  durationMs: number;
  assetFileId: string | null;
  sha256: string | null;
  ext: string | null;
  sizeBytes: number | null;
  storageKey: string | null;
};

/** Longest item the horizon query looks back for (an item that started before `from`). */
const MAX_ITEM_MS = 24 * 3_600_000;

/**
 * Log items overlapping [from, to) that play an asset, in air order, with the asset's playout
 * file. Segment items are containers: their parts carry the files. Island renders (#57) are
 * not modelled yet; when they are, they join here as more files of the segment.
 */
export async function listCacheHorizon(
  db: Executor,
  scope: StationScope,
  range: { from: Date; to: Date },
): Promise<CacheHorizonItem[]> {
  const rows = await db
    .select({
      logItemId: logItem.id,
      airAt: logItem.plannedStart,
      durationMs: logItem.plannedDurationMs,
      assetFileId: assetFile.id,
      sha256: assetFile.sha256,
      sizeBytes: assetFile.sizeBytes,
      storageKey: assetFile.storageKey,
    })
    .from(logItem)
    .leftJoin(
      assetFile,
      and(
        eq(assetFile.assetId, logItem.assetId),
        eq(assetFile.stationId, logItem.stationId),
        eq(assetFile.role, 'playout'),
      ),
    )
    .where(
      and(
        whereStation(logItem, scope),
        isNotNull(logItem.assetId),
        ne(logItem.kind, 'segment'),
        lt(logItem.plannedStart, range.to),
        gt(logItem.plannedStart, new Date(range.from.getTime() - MAX_ITEM_MS)),
        sql`${logItem.plannedStart} + ${logItem.plannedDurationMs} * interval '1 millisecond' > ${range.from.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(logItem.plannedStart), asc(logItem.position));
  return rows.map((r) => ({
    ...r,
    ext: r.storageKey ? cacheExtOf(r.storageKey) : null,
  }));
}

/**
 * The versions of the log days overlapping [from, to), as one string. A pass compares it
 * before and after: a change during the pass (whose enqueue was collapsed) means another pass.
 */
export async function cacheLogFingerprint(
  db: Executor,
  scope: StationScope,
  range: { from: Date; to: Date },
): Promise<string> {
  const days = await db
    .select({ id: logDay.id, version: logDay.version })
    .from(logDay)
    .where(
      and(
        whereStation(logDay, scope),
        lt(logDay.startsAt, range.to),
        gt(logDay.endsAt, range.from),
      ),
    )
    .orderBy(asc(logDay.startsAt));
  return days.map((d) => `${d.id}@${d.version}`).join(',');
}

export type CacheFileRow = typeof playoutCacheFile.$inferSelect;

export async function listCacheFiles(db: Executor, scope: StationScope): Promise<CacheFileRow[]> {
  return db.select().from(playoutCacheFile).where(whereStation(playoutCacheFile, scope));
}

export type CachedFileInput = {
  sha256: string;
  ext: string;
  sizeBytes: number;
  lastNeededAt: Date | null;
};

/** Records a file renamed into place (after its checksum was verified). */
export async function markCacheFileReady(
  db: Executor,
  scope: StationScope,
  file: CachedFileInput,
): Promise<void> {
  const now = new Date();
  await db
    .insert(playoutCacheFile)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      ...file,
      state: 'ready',
      fetchedAt: now,
    })
    .onConflictDoUpdate({
      target: [playoutCacheFile.stationId, playoutCacheFile.sha256],
      set: {
        ext: file.ext,
        sizeBytes: file.sizeBytes,
        lastNeededAt: file.lastNeededAt,
        state: 'ready',
        error: null,
        errorMessage: null,
        attempts: 0,
        fetchedAt: now,
      },
    });
}

/** Records a failed fetch. A `ready` row is left alone: the file is on disk. */
export async function markCacheFileFailed(
  db: Executor,
  scope: StationScope,
  file: Omit<CachedFileInput, 'lastNeededAt'> & { error: CacheFileError; message: string },
): Promise<void> {
  const message = file.message.slice(0, 2000);
  await db
    .insert(playoutCacheFile)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      sha256: file.sha256,
      ext: file.ext,
      sizeBytes: file.sizeBytes,
      state: 'failed',
      error: file.error,
      errorMessage: message,
      attempts: 1,
    })
    .onConflictDoUpdate({
      target: [playoutCacheFile.stationId, playoutCacheFile.sha256],
      set: {
        state: 'failed',
        error: file.error,
        errorMessage: message,
        attempts: sql`${playoutCacheFile.attempts} + 1`,
      },
      setWhere: eq(playoutCacheFile.state, 'failed'),
    });
}

/**
 * Makes the table match a disk scan: every file on disk is `ready` (with its LRU stamp),
 * `ready` rows of files gone from disk are deleted, and `failed` rows are kept only for files
 * the horizon still needs (`needed`), so their alerts clear when the log moves on.
 */
export async function reconcileCacheFiles(
  db: Db,
  scope: StationScope,
  input: { onDisk: readonly CachedFileInput[]; needed: ReadonlySet<string> },
): Promise<void> {
  await db.transaction(async (tx) => {
    const onDisk = input.onDisk.map((f) => f.sha256);
    await tx
      .delete(playoutCacheFile)
      .where(
        and(
          whereStation(playoutCacheFile, scope),
          eq(playoutCacheFile.state, 'ready'),
          onDisk.length ? notInArray(playoutCacheFile.sha256, onDisk) : undefined,
        ),
      );
    const needed = [...input.needed];
    await tx
      .delete(playoutCacheFile)
      .where(
        and(
          whereStation(playoutCacheFile, scope),
          eq(playoutCacheFile.state, 'failed'),
          needed.length ? notInArray(playoutCacheFile.sha256, needed) : undefined,
        ),
      );
    for (let i = 0; i < input.onDisk.length; i += 500) {
      const chunk = input.onDisk.slice(i, i + 500);
      await tx
        .insert(playoutCacheFile)
        .values(
          chunk.map((f) => ({
            orgId: scope.orgId,
            stationId: scope.stationId,
            ...f,
            state: 'ready' as const,
          })),
        )
        .onConflictDoUpdate({
          target: [playoutCacheFile.stationId, playoutCacheFile.sha256],
          set: {
            ext: sql`excluded.ext`,
            sizeBytes: sql`excluded.size_bytes`,
            lastNeededAt: sql`excluded.last_needed_at`,
            state: 'ready',
            error: null,
            errorMessage: null,
            attempts: 0,
            fetchedAt: sql`coalesce(${playoutCacheFile.fetchedAt}, now())`,
          },
        });
    }
  });
}

/** Drops the rows of files evicted from disk. */
export async function forgetCacheFiles(
  db: Executor,
  scope: StationScope,
  sha256s: readonly string[],
): Promise<void> {
  if (!sha256s.length) return;
  await db
    .delete(playoutCacheFile)
    .where(
      and(whereStation(playoutCacheFile, scope), inArray(playoutCacheFile.sha256, [...sha256s])),
    );
}

// --- Station settings and pass outcome ---------------------------------------------------

export const CACHE_DEFAULTS = {
  budgetBytes: 40 * 1024 ** 3,
  horizonHours: 48,
} as const;

export type StationCacheState = {
  budgetBytes: number;
  horizonHours: number;
  bytesPerSec: number | null;
  usedBytes: number;
  horizonBytes: number;
  deferred: string[];
  diskLow: boolean;
  lastPassAt: Date | null;
};

/** The station's cache settings (with defaults) and its last pass. */
export async function getStationCache(
  db: Executor,
  scope: StationScope,
  defaults: { budgetBytes?: number; horizonHours?: number } = {},
): Promise<StationCacheState> {
  const [row] = await db.select().from(stationCache).where(whereStation(stationCache, scope));
  return {
    budgetBytes: row?.budgetBytes ?? defaults.budgetBytes ?? CACHE_DEFAULTS.budgetBytes,
    horizonHours: row?.horizonHours ?? defaults.horizonHours ?? CACHE_DEFAULTS.horizonHours,
    bytesPerSec: row?.bytesPerSec ?? null,
    usedBytes: row?.usedBytes ?? 0,
    horizonBytes: row?.horizonBytes ?? 0,
    deferred: row?.deferred ?? [],
    diskLow: row?.diskLow ?? false,
    lastPassAt: row?.lastPassAt ?? null,
  };
}

/** Per-station overrides; null restores the default. */
export async function setStationCacheSettings(
  db: Executor,
  scope: StationScope,
  settings: {
    budgetBytes?: number | null;
    horizonHours?: number | null;
    bytesPerSec?: number | null;
  },
): Promise<void> {
  await db
    .insert(stationCache)
    .values({ stationId: scope.stationId, orgId: scope.orgId, ...settings })
    .onConflictDoUpdate({ target: stationCache.stationId, set: settings });
}

export async function recordCachePass(
  db: Executor,
  scope: StationScope,
  pass: { usedBytes: number; horizonBytes: number; deferred: readonly string[]; diskLow: boolean },
): Promise<void> {
  const values = {
    usedBytes: pass.usedBytes,
    horizonBytes: pass.horizonBytes,
    deferred: pass.deferred.slice(0, 1000),
    diskLow: pass.diskLow,
    lastPassAt: new Date(),
  };
  await db
    .insert(stationCache)
    .values({ stationId: scope.stationId, orgId: scope.orgId, ...values })
    .onConflictDoUpdate({ target: stationCache.stationId, set: values });
}

/** Every station, for the worker's sweep. */
export async function listCacheStations(
  db: Executor,
): Promise<Array<{ orgId: string; stationId: string }>> {
  return db.select({ orgId: station.orgId, stationId: station.id }).from(station);
}

/** Stations the worker has synced at least once: the ones cache alerts are evaluated for. */
export async function listSyncedCacheStations(
  db: Executor,
): Promise<Array<{ orgId: string; stationId: string }>> {
  return db
    .select({ orgId: stationCache.orgId, stationId: stationCache.stationId })
    .from(stationCache)
    .where(isNotNull(stationCache.lastPassAt));
}

// --- Readiness ---------------------------------------------------------------------------

/** Whether this asset file's content is in the station's cache. */
export async function isPlayoutCached(
  db: Executor,
  scope: StationScope,
  assetFileId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ sha256: playoutCacheFile.sha256 })
    .from(assetFile)
    .innerJoin(
      playoutCacheFile,
      and(
        eq(playoutCacheFile.stationId, assetFile.stationId),
        eq(playoutCacheFile.sha256, assetFile.sha256),
        eq(playoutCacheFile.state, 'ready'),
      ),
    )
    .where(and(whereStation(assetFile, scope), eq(assetFile.id, assetFileId)));
  return row !== undefined;
}

/** Whether a file with this hash is in the station's cache (islands, #57: every part). */
export async function isSha256Cached(
  db: Executor,
  scope: StationScope,
  sha256: string,
): Promise<boolean> {
  const [row] = await db
    .select({ sha256: playoutCacheFile.sha256 })
    .from(playoutCacheFile)
    .where(
      and(
        whereStation(playoutCacheFile, scope),
        eq(playoutCacheFile.sha256, sha256),
        eq(playoutCacheFile.state, 'ready'),
      ),
    );
  return row !== undefined;
}

/**
 * Readiness of the items overlapping [from, to) (pure). An item is ready when its file is;
 * `files` maps a hash to its row state, `deferred` lists hashes the budget pushed back.
 */
export function computeCacheReadiness(
  items: readonly CacheHorizonItem[],
  files: ReadonlyMap<string, { state: 'ready' | 'failed'; error: CacheFileError | null }>,
  deferred: ReadonlySet<string>,
  range: { from: Date; to: Date },
): CacheReadiness {
  const from = range.from.getTime();
  const to = range.to.getTime();
  const inWindow = items.filter(
    (i) => i.airAt.getTime() < to && i.airAt.getTime() + i.durationMs > from,
  );
  const missing: CacheReadiness['missing'] = [];
  let totalMs = 0;
  let missingMs = 0;
  for (const i of inWindow) {
    totalMs += i.durationMs;
    const file = i.sha256 ? files.get(i.sha256) : undefined;
    if (file?.state === 'ready') continue;
    let reason: CacheMissingReason;
    if (!i.sha256) reason = 'no_file';
    else if (file?.error) reason = file.error;
    else if (deferred.has(i.sha256)) reason = 'deferred';
    else reason = 'pending';
    missingMs += i.durationMs;
    missing.push({
      logItemId: i.logItemId,
      airAt: i.airAt.toISOString(),
      durationMs: i.durationMs,
      assetFileId: i.assetFileId,
      sha256: i.sha256,
      reason,
    });
  }
  const n = inWindow.length;
  const pctItems = n ? (100 * (n - missing.length)) / n : 100;
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    items: n,
    readyItems: n - missing.length,
    pctItems,
    pctAirTime: totalMs ? (100 * (totalMs - missingMs)) / totalMs : pctItems,
    firstMissingAt: missing[0]?.airAt ?? null,
    missing,
  };
}

/** Readiness of the station's log items overlapping [from, to), from the cache table. */
export async function cacheReadiness(
  db: Executor,
  scope: StationScope,
  range: { from: Date; to: Date },
): Promise<CacheReadiness> {
  const [items, files, state] = await Promise.all([
    listCacheHorizon(db, scope, range),
    listCacheFiles(db, scope),
    getStationCache(db, scope),
  ]);
  return computeCacheReadiness(
    items,
    new Map(files.map((f) => [f.sha256, { state: f.state, error: f.error }])),
    new Set(state.deferred),
    range,
  );
}

/** An asset file of the station, as the cache fetches it. Null if it isn't the station's. */
export async function getCacheSourceFile(
  db: Executor,
  scope: StationScope,
  assetFileId: string,
): Promise<{ sha256: string; ext: string; sizeBytes: number; key: string } | null> {
  const [row] = await db
    .select({ sha256: assetFile.sha256, sizeBytes: assetFile.sizeBytes, key: assetFile.storageKey })
    .from(assetFile)
    .where(and(whereStation(assetFile, scope), eq(assetFile.id, assetFileId)));
  return row ? { ...row, ext: cacheExtOf(row.key) } : null;
}

/** A station's ids from its id alone, for event consumers (events carry only the station). */
export async function getCacheStation(
  db: Executor,
  stationId: string,
): Promise<{ orgId: string; stationId: string } | null> {
  const [row] = await db
    .select({ orgId: station.orgId, stationId: station.id })
    .from(station)
    .where(eq(station.id, stationId));
  return row ?? null;
}
