import {
  alert,
  asset,
  assetCues,
  assetFile,
  assetLoudness,
  type Executor,
  feederPush,
  playoutCacheFile,
  type StationScope,
  station,
  whereStation,
} from '@ondes/db';
import {
  alertTypes,
  cacheExtOf,
  feederPushPartsSchema,
  type IslandPlan,
  type LogItem,
  type PlayoutGainStation,
} from '@ondes/shared';
import { and, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { getLogRange } from '../../log/repo.ts';
import { deriveIslandsFor } from '../../segues/sync.ts';
import type { FeederPushStore } from './feeder.ts';
import type { FeedMedia } from './push.ts';

// Reads for the feeder: the log around now (published days only) and, in one query, the
// playout media of every asset in it: playout file, cues, loudness, and whether the station's
// playout cache has it (`playout_cache_file` ready, like `isPlayoutCached`).

export type FeedWindow = {
  /** Top-level items of published days, in play order, with their segment parts. */
  items: LogItem[];
  media: Map<string, FeedMedia>;
  station: PlayoutGainStation;
};

export async function loadFeedWindow(
  db: Executor,
  scope: StationScope,
  range: { from: Date; to: Date },
): Promise<FeedWindow> {
  const [log, [stationRow]] = await Promise.all([
    getLogRange(db, scope, { from: range.from.toISOString(), to: range.to.toISOString() }),
    db
      .select({
        loudnessTargetLufs: station.loudnessTargetLufs,
        truePeakLimitDbtp: station.truePeakLimitDbtp,
      })
      .from(station)
      .where(and(eq(station.id, scope.stationId), eq(station.orgId, scope.orgId))),
  ]);
  if (!stationRow) throw new Error(`station ${scope.stationId} not found`);
  // A draft day is a plan being edited: the feeder treats it as no log (contracts/log.ts).
  const published = new Set(log.days.filter((d) => d.status === 'published').map((d) => d.id));
  const items = log.items.filter((i) => published.has(i.logDayId));
  const assetIds = [
    ...new Set(
      items.flatMap((i) => [i.assetId, ...i.parts.map((p) => p.assetId)]).filter((id) => !!id),
    ),
  ] as string[];
  return { items, media: await loadMedia(db, scope, assetIds), station: stationRow };
}

export async function loadMedia(
  db: Executor,
  scope: StationScope,
  assetIds: readonly string[],
): Promise<Map<string, FeedMedia>> {
  if (!assetIds.length) return new Map();
  const rows = await db
    .select({
      assetId: asset.id,
      title: asset.title,
      artists: asset.artists,
      normalizeLoudness: asset.normalizeLoudness,
      gainOverrideDb: asset.gainOverrideDb,
      fileId: assetFile.id,
      sha256: assetFile.sha256,
      storageKey: assetFile.storageKey,
      sampleRate: assetFile.sampleRate,
      durationSamples: assetFile.durationSamples,
      flacBlockSize: assetFile.flacBlockSize,
      cueSampleRate: assetCues.sampleRate,
      cueIn: assetCues.cueIn,
      cueOut: assetCues.cueOut,
      fadeIn: assetCues.fadeIn,
      fadeOut: assetCues.fadeOut,
      crossStartNext: assetCues.crossStartNext,
      integratedLufs: assetLoudness.integratedLufs,
      truePeakDbtp: assetLoudness.truePeakDbtp,
      cachedSha: playoutCacheFile.sha256,
    })
    .from(asset)
    .innerJoin(
      assetFile,
      and(
        eq(assetFile.assetId, asset.id),
        eq(assetFile.stationId, asset.stationId),
        eq(assetFile.role, 'playout'),
      ),
    )
    .leftJoin(
      assetCues,
      and(eq(assetCues.assetId, asset.id), eq(assetCues.stationId, asset.stationId)),
    )
    .leftJoin(
      assetLoudness,
      and(eq(assetLoudness.assetId, asset.id), eq(assetLoudness.stationId, asset.stationId)),
    )
    .leftJoin(
      playoutCacheFile,
      and(
        eq(playoutCacheFile.stationId, asset.stationId),
        eq(playoutCacheFile.sha256, assetFile.sha256),
        eq(playoutCacheFile.state, 'ready'),
      ),
    )
    .where(and(whereStation(asset, scope), inArray(asset.id, [...assetIds])));

  const media = new Map<string, FeedMedia>();
  for (const r of rows) {
    let ext: string;
    try {
      ext = cacheExtOf(r.storageKey);
    } catch {
      continue; // No usable extension: treated as no playout file.
    }
    media.set(r.assetId, {
      assetId: r.assetId,
      fileId: r.fileId,
      sha256: r.sha256,
      ext,
      flacBlockSize: r.flacBlockSize,
      durationSamples: r.durationSamples,
      sampleRate: r.sampleRate,
      cached: r.cachedSha !== null,
      title: r.title,
      artists: r.artists,
      cues:
        r.cueSampleRate === null
          ? null
          : {
              sampleRate: r.cueSampleRate,
              cueIn: r.cueIn,
              cueOut: r.cueOut,
              fadeIn: r.fadeIn,
              fadeOut: r.fadeOut,
              crossStartNext: r.crossStartNext,
            },
      gain: {
        normalizeLoudness: r.normalizeLoudness,
        gainOverrideDb: r.gainOverrideDb,
        loudness:
          r.integratedLufs === null
            ? null
            : { integratedLufs: r.integratedLufs, truePeakDbtp: r.truePeakDbtp },
      },
    });
  }
  return media;
}

/** An island the segues of the window call for right now (ADR 0017 `deriveIslandsFor`). */
export type FeedIsland = {
  hash: string;
  plan: IslandPlan;
  /** A `ready` render with this exact hash, and whether the station's cache has its file. */
  rendered: { islandId: string; sha256: string; cached: boolean } | null;
};

export type FeedIslands = {
  islands: FeedIsland[];
  /** Media of every asset the islands play (voices included), by asset id. */
  media: Map<string, FeedMedia>;
};

/**
 * The islands of the segues touching `itemIds`, re-derived from the log and the library as
 * they are now (never a stale render: ADR 0017), with their render's cache state and the media
 * of the voices they play, for the fallback.
 */
export async function loadFeedIslands(
  db: Executor,
  scope: StationScope,
  itemIds: readonly string[],
): Promise<FeedIslands> {
  const derived = await deriveIslandsFor(db, scope, itemIds);
  if (!derived.islands.length) return { islands: [], media: new Map() };
  const shas = derived.islands.flatMap((i) => (i.rendered?.file ? [i.rendered.file.sha256] : []));
  const cached = shas.length
    ? await db
        .select({ sha256: playoutCacheFile.sha256 })
        .from(playoutCacheFile)
        .where(
          and(
            whereStation(playoutCacheFile, scope),
            inArray(playoutCacheFile.sha256, shas),
            eq(playoutCacheFile.state, 'ready'),
          ),
        )
    : [];
  const ready = new Set(cached.map((r) => r.sha256));
  const assetIds = [
    ...new Set(derived.islands.flatMap((i) => Object.values(i.files).map((f) => f.assetId))),
  ];
  return {
    islands: derived.islands.map((i) => ({
      hash: i.hash,
      plan: i,
      rendered: i.rendered?.file
        ? {
            islandId: i.rendered.islandId,
            sha256: i.rendered.file.sha256,
            cached: ready.has(i.rendered.file.sha256),
          }
        : null,
    })),
    media: await loadMedia(db, scope, assetIds),
  };
}

/** Records of other boots and older than this are dropped by `prune`. */
const PUSH_RECORD_MAX_AGE_MS = 2 * 24 * 3_600_000;

/** `feeder_push`: what the station's feeder pushed during the engine's current boot. */
export function createFeederPushStore(db: Executor, scope: StationScope): FeederPushStore {
  const where = (bootId: string) =>
    and(whereStation(feederPush, scope), eq(feederPush.bootId, bootId));
  return {
    async load(bootId) {
      const rows = await db
        .select({
          entryId: feederPush.entryId,
          fingerprint: feederPush.fingerprint,
          trimMs: feederPush.trimMs,
          aired: feederPush.aired,
          parts: feederPush.parts,
          itemIds: feederPush.itemIds,
        })
        .from(feederPush)
        .where(where(bootId));
      // jsonb written by another api version: parts that don't parse are as good as none.
      return rows.map((r) => ({
        ...r,
        parts: feederPushPartsSchema.safeParse(r.parts).data ?? null,
      }));
    },

    async save(bootId, entryId, push) {
      await db
        .insert(feederPush)
        .values({
          ...scope,
          bootId,
          entryId,
          fingerprint: push.fingerprint,
          trimMs: push.trimMs,
          parts: push.parts ?? null,
          itemIds: push.itemIds ?? null,
          pushedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [feederPush.stationId, feederPush.bootId, feederPush.entryId],
          set: {
            fingerprint: push.fingerprint,
            trimMs: push.trimMs,
            parts: push.parts ?? null,
            itemIds: push.itemIds ?? null,
            pushedAt: new Date(),
          },
        });
    },

    async remove(bootId, entryIds) {
      if (!entryIds.length) return;
      // Something that aired stays recorded as aired.
      await db
        .delete(feederPush)
        .where(
          and(
            where(bootId),
            inArray(feederPush.entryId, [...entryIds]),
            eq(feederPush.aired, false),
          ),
        );
    },

    async markAired(bootId, entryIds) {
      if (!entryIds.length) return;
      await db
        .insert(feederPush)
        .values(
          entryIds.map((entryId) => ({ ...scope, bootId, entryId, fingerprint: '', aired: true })),
        )
        .onConflictDoUpdate({
          target: [feederPush.stationId, feederPush.bootId, feederPush.entryId],
          set: { aired: sql`true` },
        });
    },

    async prune(bootId) {
      await db
        .delete(feederPush)
        .where(
          and(
            whereStation(feederPush, scope),
            or(
              ne(feederPush.bootId, bootId),
              lt(feederPush.pushedAt, new Date(Date.now() - PUSH_RECORD_MAX_AGE_MS)),
            ),
          ),
        );
    },
  };
}

/** Dedupe keys of the station's open feeder alerts. */
export async function openFeederAlerts(db: Executor, scope: StationScope): Promise<Set<string>> {
  const rows = await db
    .select({ dedupeKey: alert.dedupeKey })
    .from(alert)
    .where(
      and(
        whereStation(alert, scope),
        isNull(alert.resolvedAt),
        inArray(alert.type, [alertTypes.feederItemsSkipped, alertTypes.feederLogEmpty]),
      ),
    );
  return new Set(rows.map((r) => r.dedupeKey));
}
