import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { Executor } from '../client.ts';
import { assetCues, assetFile } from '../schema/library.ts';
import { station } from '../schema/tenancy.ts';
import { type StationScope, whereStation } from '../tenant.ts';

// Autocue backfill (#20): the worker re-analyses assets it missed (worker down when they were
// ingested) and assets analysed by another analyzer version (new algorithm, new thresholds).

export interface AutocueStation {
  scope: StationScope;
  engineSettings: Record<string, unknown>;
}

/** Every station with its engine settings (where its autocue thresholds live). */
export async function listAutocueStations(db: Executor): Promise<AutocueStation[]> {
  const rows = await db
    .select({ id: station.id, orgId: station.orgId, engineSettings: station.engineSettings })
    .from(station)
    .orderBy(asc(station.id));
  return rows.map((row) => ({
    scope: { orgId: row.orgId, stationId: row.id } as StationScope,
    engineSettings: row.engineSettings,
  }));
}

/** The station's engine settings (`{}` for a station that doesn't exist). */
export async function getStationEngineSettings(
  db: Executor,
  scope: StationScope,
): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ engineSettings: station.engineSettings })
    .from(station)
    .where(and(eq(station.id, scope.stationId), eq(station.orgId, scope.orgId)));
  return row?.engineSettings ?? {};
}

export interface AutocueCandidate {
  assetId: string;
  playoutSha256: string;
}

/**
 * A page of the station's assets that have a playout copy and no cues from `analyzerVersion`
 * (no cue row, or one from another version), by asset id after `after`.
 */
export async function listAssetsNeedingAutocue(
  db: Executor,
  scope: StationScope,
  analyzerVersion: string,
  options: { after?: string; limit?: number } = {},
): Promise<AutocueCandidate[]> {
  return db
    .select({ assetId: assetFile.assetId, playoutSha256: assetFile.sha256 })
    .from(assetFile)
    .leftJoin(
      assetCues,
      and(eq(assetCues.assetId, assetFile.assetId), whereStation(assetCues, scope)),
    )
    .where(
      and(
        whereStation(assetFile, scope),
        eq(assetFile.role, 'playout'),
        options.after ? gt(assetFile.assetId, options.after) : undefined,
        or(
          isNull(assetCues.assetId),
          sql`${assetCues.analyzerVersion} is distinct from ${analyzerVersion}`,
        ),
      ),
    )
    .orderBy(asc(assetFile.assetId))
    .limit(options.limit ?? 500);
}
