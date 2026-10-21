import { PEAKS_FORMAT_VERSION } from '@ondes/shared';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Executor } from '../client.ts';
import { assetFile } from '../schema/library.ts';
import { type StationScope, whereStation } from '../tenant.ts';

// Waveform peaks backfill (#22): the worker computes the peaks it missed (worker down when the
// asset was ingested) and those of an older format version or a replaced playout copy.

const peaksFile = alias(assetFile, 'peaks_file');

export interface PeaksCandidate {
  assetId: string;
  playoutSha256: string;
}

/**
 * A page of the station's assets that have a playout copy and no peaks file for it in the
 * current format: the peaks file's key isn't `peaksStorageKey(orgId, playoutSha256)`, which
 * the query rebuilds (`org/<orgId>/peaks/v<version>/<sha256>.peaks`).
 */
export async function listAssetsNeedingPeaks(
  db: Executor,
  scope: StationScope,
  options: { after?: string; limit?: number } = {},
): Promise<PeaksCandidate[]> {
  return db
    .select({ assetId: assetFile.assetId, playoutSha256: assetFile.sha256 })
    .from(assetFile)
    .leftJoin(
      peaksFile,
      and(
        eq(peaksFile.assetId, assetFile.assetId),
        eq(peaksFile.role, 'peaks'),
        whereStation(peaksFile, scope),
      ),
    )
    .where(
      and(
        whereStation(assetFile, scope),
        eq(assetFile.role, 'playout'),
        options.after ? gt(assetFile.assetId, options.after) : undefined,
        sql`${peaksFile.storageKey} is distinct from
          ('org/' || ${assetFile.orgId} || '/peaks/v' || ${String(PEAKS_FORMAT_VERSION)}
            || '/' || ${assetFile.sha256} || '.peaks')`,
      ),
    )
    .orderBy(asc(assetFile.assetId))
    .limit(options.limit ?? 500);
}
