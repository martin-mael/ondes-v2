import {
  type EngineDesiredState,
  type EnginePortPurpose,
  type Executor,
  enginePort,
  type StationScope,
  station,
  stationEngine,
  unsafeScope,
  whereStation,
} from '@ondes/db';
import type { EngineSettings } from '@ondes/shared';
import { and, eq, sql } from 'drizzle-orm';
import { type EngineSecretBox, type EngineSecrets, generateEngineSecrets } from './secrets.ts';

// Lifecycle data access (#35): the station's engine row (desired state, secrets) and the
// host port pool. Every function takes the station scope.

export type StationEngineRecord = {
  scope: StationScope;
  slug: string;
  name: string;
  engineSettings: EngineSettings;
  desiredState: EngineDesiredState;
  secrets: EngineSecrets;
  configVersion: string | null;
  containerId: string | null;
};

/**
 * The station and its engine row, creating the row (and the station's secrets) on first
 * use. Null if the station doesn't exist in this scope.
 */
export async function loadStationEngine(
  db: Executor,
  box: EngineSecretBox,
  scope: StationScope,
): Promise<StationEngineRecord | null> {
  const [st] = await db
    .select({ slug: station.slug, name: station.name, engineSettings: station.engineSettings })
    .from(station)
    .where(and(eq(station.id, scope.stationId), eq(station.orgId, scope.orgId)));
  if (!st) return null;

  const fresh = generateEngineSecrets();
  await db
    .insert(stationEngine)
    .values({
      stationId: scope.stationId,
      orgId: scope.orgId,
      controlTokenEnc: box.encrypt(fresh.controlToken),
      livePasswordEnc: box.encrypt(fresh.livePassword),
      icecastSourcePasswordEnc: box.encrypt(fresh.icecastSourcePassword),
    })
    .onConflictDoNothing();
  const [row] = await db
    .select()
    .from(stationEngine)
    .where(and(whereStation(stationEngine, scope), eq(stationEngine.orgId, scope.orgId)));
  if (!row) return null;
  return {
    scope,
    ...st,
    desiredState: row.desiredState,
    secrets: {
      controlToken: box.decrypt(row.controlTokenEnc),
      livePassword: box.decrypt(row.livePasswordEnc),
      icecastSourcePassword: box.decrypt(row.icecastSourcePasswordEnc),
    },
    configVersion: row.configVersion,
    containerId: row.containerId,
  };
}

export async function setDesiredState(
  db: Executor,
  scope: StationScope,
  desiredState: EngineDesiredState,
): Promise<void> {
  await db
    .update(stationEngine)
    .set({ desiredState })
    .where(and(whereStation(stationEngine, scope), eq(stationEngine.orgId, scope.orgId)));
}

/** Records the container the lifecycle just created and the script version it runs. */
export async function setApplied(
  db: Executor,
  scope: StationScope,
  applied: { configVersion: string | null; containerId: string | null },
): Promise<void> {
  await db
    .update(stationEngine)
    .set(applied)
    .where(and(whereStation(stationEngine, scope), eq(stationEngine.orgId, scope.orgId)));
}

/**
 * Every station whose engine should be running, across tenants: the api's boot list. The
 * scopes come from the rows themselves (system read, never request input).
 */
export async function listRunningStationScopes(db: Executor): Promise<StationScope[]> {
  const rows = await db
    .select({ stationId: stationEngine.stationId, orgId: stationEngine.orgId })
    .from(stationEngine)
    .where(eq(stationEngine.desiredState, 'running'));
  return rows.map((r) => unsafeScope(r.orgId, r.stationId));
}

export type PortRange = { min: number; max: number };

export class PortPoolExhaustedError extends Error {
  constructor(range: PortRange) {
    super(`no free engine port in ${range.min}-${range.max}`);
    this.name = 'PortPoolExhaustedError';
  }
}

/**
 * The station's host port for `purpose`, allocating the lowest free one in `range` on first
 * use. Concurrent allocations race on the primary key: the loser retries with the next port.
 */
export async function allocatePort(
  db: Executor,
  scope: StationScope,
  purpose: EnginePortPurpose,
  range: PortRange,
): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const [existing] = await db
      .select({ port: enginePort.port })
      .from(enginePort)
      .where(and(whereStation(enginePort, scope), eq(enginePort.purpose, purpose)));
    if (existing) return existing.port;

    const inserted = await db.execute<{ port: number }>(sql`
      insert into ${enginePort} (port, station_id, purpose)
      select p, ${scope.stationId}, ${purpose}
      from generate_series(${range.min}::int, ${range.max}::int) as p
      where not exists (select 1 from ${enginePort} e where e.port = p)
      order by p
      limit 1
      on conflict do nothing
      returning port`);
    const port = inserted[0]?.port;
    if (port !== undefined) return port;

    const [{ free } = { free: 0 }] = await db.execute<{ free: number }>(sql`
      select count(*)::int as free from generate_series(${range.min}::int, ${range.max}::int) p
      where not exists (select 1 from ${enginePort} e where e.port = p)`);
    if (free === 0) {
      // Maybe a concurrent call allocated this station's port: the loop re-reads it.
      const [mine] = await db
        .select({ port: enginePort.port })
        .from(enginePort)
        .where(and(whereStation(enginePort, scope), eq(enginePort.purpose, purpose)));
      if (mine) return mine.port;
      throw new PortPoolExhaustedError(range);
    }
  }
  throw new PortPoolExhaustedError(range);
}

/** Gives the station's ports back to the pool (its engine was removed). */
export async function releasePorts(db: Executor, scope: StationScope): Promise<void> {
  await db.delete(enginePort).where(whereStation(enginePort, scope));
}
