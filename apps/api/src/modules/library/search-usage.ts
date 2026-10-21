import {
  episode,
  logItem,
  type StationScope,
  segue,
  stationEmergencyAsset,
  stationSafetyAsset,
  type Tx,
  whereStation,
} from '@ondes/db';
import type { AssetUsage } from '@ondes/shared';
import { ne, type SQL, sql } from 'drizzle-orm';
import { uuidArray } from './search-repo.ts';

// What still needs an asset (#23). Deleting an asset that something will play or fall back
// to would silently drop it: their foreign keys cascade or set null. Deletes (bulk and single)
// check these first, under the assets' row locks, and refuse with 409 `asset_in_use`.
//
// A feature whose table should block deletes adds one check here: `kind` names it in the
// contract (`assetUsageKindSchema`), `query` returns (asset id, user id) pairs.

interface UsageCheck {
  kind: AssetUsage['kind'];
  query: (scope: StationScope, ids: SQL, at: Date) => SQL;
}

const USAGE_CHECKS: UsageCheck[] = [
  {
    // Not aired yet (planned, ready or missing): the show still counts on this audio.
    kind: 'episode',
    query: (scope, ids) =>
      sql`select ${episode.assetId} as asset_id, ${episode.id}::text as used_by from ${episode}
        where ${whereStation(episode, scope)} and ${episode.assetId} = any(${ids})
          and ${ne(episode.status, 'aired')}`,
  },
  {
    kind: 'safety_playlist',
    query: (scope, ids) =>
      sql`select ${stationSafetyAsset.assetId} as asset_id, ${stationSafetyAsset.stationId}::text as used_by
        from ${stationSafetyAsset}
        where ${whereStation(stationSafetyAsset, scope)} and ${stationSafetyAsset.assetId} = any(${ids})`,
  },
  {
    kind: 'emergency_file',
    query: (scope, ids) =>
      sql`select ${stationEmergencyAsset.assetId} as asset_id, ${stationEmergencyAsset.stationId}::text as used_by
        from ${stationEmergencyAsset}
        where ${whereStation(stationEmergencyAsset, scope)} and ${stationEmergencyAsset.assetId} = any(${ids})`,
  },
  {
    // Scheduled to air: a log item from now on.
    kind: 'log_item',
    query: (scope, ids, at) =>
      sql`select ${logItem.assetId} as asset_id, ${logItem.id}::text as used_by from ${logItem}
        where ${whereStation(logItem, scope)} and ${logItem.assetId} = any(${ids})
          and ${logItem.plannedStart} >= ${at.toISOString()}::timestamptz`,
  },
  {
    // A recorded voice in a segue's lanes (#55): deleting it would lose the voice track.
    kind: 'segue_voice',
    query: (scope, ids) =>
      sql`select (lane->>'assetId')::uuid as asset_id, ${segue.id}::text as used_by
        from ${segue}, jsonb_array_elements(${segue.voices}) as lane
        where ${whereStation(segue, scope)} and (lane->>'assetId')::uuid = any(${ids})`,
  },
];

/** Most usages reported in a refusal. */
const MAX_REPORTED = 100;

/** Usages of these assets, by kind then asset; at most {@link MAX_REPORTED}. */
export async function assetUsages(
  tx: Tx,
  scope: StationScope,
  assetIds: string[],
  at = new Date(),
): Promise<AssetUsage[]> {
  if (assetIds.length === 0) return [];
  const ids = uuidArray(assetIds);
  const usages: AssetUsage[] = [];
  for (const check of USAGE_CHECKS) {
    const rows = (await tx.execute(
      sql`${check.query(scope, ids, at)} limit ${MAX_REPORTED}`,
    )) as unknown as { asset_id: string; used_by: string }[];
    usages.push(...rows.map((r) => ({ assetId: r.asset_id, kind: check.kind, usedBy: r.used_by })));
    if (usages.length >= MAX_REPORTED) break;
  }
  return usages.slice(0, MAX_REPORTED);
}
