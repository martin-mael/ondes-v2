import {
  asset,
  assetCues,
  assetFile,
  assetLoudness,
  type Executor,
  playoutCacheFile,
  type StationScope,
  station,
  whereStation,
} from '@ondes/db';
import { cacheExtOf, type LogItem, type PlayoutGainStation } from '@ondes/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { getLogRange } from '../../log/repo.ts';
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
