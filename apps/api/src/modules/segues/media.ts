import {
  asset,
  assetCues,
  type Executor,
  logItem,
  type StationScope,
  station,
  whereStation,
} from '@ondes/db';
import type { AssetType, SegueMedia, SegueMediaResponse } from '@ondes/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { loadAssetMedia, resolveMedia } from './sync.ts';

// What the segue editor (#58) needs to place and preview lanes: each item's and voice's media
// resolved exactly as the island sync resolves it (cues, playout gain), so the waveforms sit
// where the render puts them and the preview mixes at the render's gains. With each one, its
// type and the cue markers smart placement reads (#61, ADR 0037), at the playout copy's rate.

export async function segueMedia(
  db: Executor,
  scope: StationScope,
  query: { itemIds: string[]; assetIds: string[] },
): Promise<SegueMediaResponse> {
  const items = query.itemIds.length
    ? await db
        .select({ id: logItem.id, assetId: logItem.assetId, cueOverrides: logItem.cueOverrides })
        .from(logItem)
        .where(and(whereStation(logItem, scope), inArray(logItem.id, query.itemIds)))
    : [];
  const assetIds = new Set(query.assetIds);
  for (const item of items) if (item.assetId) assetIds.add(item.assetId);
  const media = await loadAssetMedia(db, scope, [...assetIds]);
  const [stationGain] = await db
    .select({
      loudnessTargetLufs: station.loudnessTargetLufs,
      truePeakLimitDbtp: station.truePeakLimitDbtp,
    })
    .from(station)
    .where(and(eq(station.id, scope.stationId), eq(station.orgId, scope.orgId)));
  if (!stationGain) throw new Error(`station ${scope.stationId} not found`);
  const extras = await loadMarkers(db, scope, [...assetIds]);

  const toDto = (m: ReturnType<typeof resolveMedia>): SegueMedia | null => {
    if (!m) return null;
    const extra = extras.get(m.assetId);
    const scale = (n: number | null) =>
      n === null || !extra?.sampleRate
        ? null
        : extra.sampleRate === m.sampleRate
          ? n
          : Math.round((n * m.sampleRate) / extra.sampleRate);
    return {
      assetId: m.assetId,
      sha256: m.sha256,
      sampleRate: m.sampleRate,
      durationSamples: m.durationSamples,
      gainDb: m.gainDb,
      cueIn: m.cueIn,
      cueOut: m.cueOut,
      ...(extra && { kind: extra.kind }),
      markers: {
        introEnd: scale(extra?.introEnd ?? null),
        outroStart: scale(extra?.outroStart ?? null),
        crossStartNext: scale(extra?.crossStartNext ?? null),
      },
    };
  };
  const byItem = new Map(items.map((i) => [i.id, i]));
  return {
    items: Object.fromEntries(
      query.itemIds.map((id) => {
        const item = byItem.get(id);
        const m = item?.assetId ? media.get(item.assetId) : undefined;
        return [id, toDto(resolveMedia(m, stationGain, item?.cueOverrides ?? null))];
      }),
    ),
    assets: Object.fromEntries(
      query.assetIds.map((id) => [id, toDto(resolveMedia(media.get(id), stationGain))]),
    ),
  };
}

type Extra = {
  kind: AssetType;
  sampleRate: number | null;
  introEnd: number | null;
  outroStart: number | null;
  crossStartNext: number | null;
};

/** Each asset's type and cue markers, in its cue row's rate. */
async function loadMarkers(db: Executor, scope: StationScope, assetIds: string[]) {
  if (!assetIds.length) return new Map<string, Extra>();
  const rows = await db
    .select({
      assetId: asset.id,
      kind: asset.type,
      sampleRate: assetCues.sampleRate,
      introEnd: assetCues.introEnd,
      outroStart: assetCues.outroStart,
      crossStartNext: assetCues.crossStartNext,
    })
    .from(asset)
    .leftJoin(
      assetCues,
      and(eq(assetCues.assetId, asset.id), eq(assetCues.stationId, asset.stationId)),
    )
    .where(and(whereStation(asset, scope), inArray(asset.id, assetIds)));
  return new Map<string, Extra>(rows.map(({ assetId, ...r }) => [assetId, r]));
}
