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
import { and, eq, inArray, sql } from 'drizzle-orm';
import { type EngineSecretBox, type EngineSecrets, generateEngineSecrets } from './secrets.ts';

// Lifecycle data access (#35): the station's engine row (desired state, secrets, storm) and
// the host port pool. Station functions take the station scope.

export type StationEngineRecord = {
  scope: StationScope;
  slug: string;
  name: string;
  engineSettings: EngineSettings;
  desiredState: EngineDesiredState;
  secrets: EngineSecrets;
  configVersion: string | null;
  containerId: string | null;
  stormAt: Date | null;
};

const scoped = (scope: StationScope) =>
  and(whereStation(stationEngine, scope), eq(stationEngine.orgId, scope.orgId));

function sealSecrets(box: EngineSecretBox, secrets: EngineSecrets) {
  return {
    controlTokenEnc: box.encrypt(secrets.controlToken),
    livePasswordEnc: box.encrypt(secrets.livePassword),
    icecastSourcePasswordEnc: box.encrypt(secrets.icecastSourcePassword),
  };
}

/**
 * The station and its engine row, creating the row (and the station's secrets) on first
 * use. Secrets sealed with an older key are re-sealed with the current one. Null if the
 * station doesn't exist in this scope.
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

  await db
    .insert(stationEngine)
    .values({
      stationId: scope.stationId,
      orgId: scope.orgId,
      ...sealSecrets(box, generateEngineSecrets()),
    })
    .onConflictDoNothing();
  const [row] = await db.select().from(stationEngine).where(scoped(scope));
  if (!row) return null;
  const secrets: EngineSecrets = {
    controlToken: box.decrypt(row.controlTokenEnc),
    livePassword: box.decrypt(row.livePasswordEnc),
    icecastSourcePassword: box.decrypt(row.icecastSourcePasswordEnc),
  };
  if ([row.controlTokenEnc, row.livePasswordEnc, row.icecastSourcePasswordEnc].some(box.isStale)) {
    await db.update(stationEngine).set(sealSecrets(box, secrets)).where(scoped(scope));
  }
  return {
    scope,
    ...st,
    desiredState: row.desiredState,
    secrets,
    configVersion: row.configVersion,
    containerId: row.containerId,
    stormAt: row.stormAt,
  };
}

/** New secrets for the station (the container must be recreated to use them). */
export async function rotateSecrets(
  db: Executor,
  box: EngineSecretBox,
  scope: StationScope,
): Promise<EngineSecrets> {
  const secrets = generateEngineSecrets();
  await db.update(stationEngine).set(sealSecrets(box, secrets)).where(scoped(scope));
  return secrets;
}

/**
 * The station's control token, for the internal events route, which only has the station
 * id from the URL (the token it checks is the proof). Null without an engine row.
 */
export async function loadControlToken(
  db: Executor,
  box: EngineSecretBox,
  stationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ controlTokenEnc: stationEngine.controlTokenEnc })
    .from(stationEngine)
    .where(eq(stationEngine.stationId, stationId));
  return row ? box.decrypt(row.controlTokenEnc) : null;
}

export async function setDesiredState(
  db: Executor,
  scope: StationScope,
  desiredState: EngineDesiredState,
): Promise<void> {
  await db.update(stationEngine).set({ desiredState }).where(scoped(scope));
}

/** Records the container the lifecycle just created and the script version it runs. */
export async function setApplied(
  db: Executor,
  scope: StationScope,
  applied: { configVersion: string | null; containerId: string | null },
): Promise<void> {
  await db.update(stationEngine).set(applied).where(scoped(scope));
}

/** Marks (a date) or clears (null) a restart storm. */
export async function setStorm(db: Executor, scope: StationScope, at: Date | null): Promise<void> {
  await db.update(stationEngine).set({ stormAt: at }).where(scoped(scope));
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

/** Which of these station ids have an engine row (the orphan sweep keeps those). */
export async function stationsWithEngine(db: Executor, stationIds: string[]): Promise<Set<string>> {
  // Container labels are untrusted strings: only uuids reach the query.
  const ids = stationIds.filter((id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
  );
  if (!ids.length) return new Set();
  const rows = await db
    .select({ stationId: stationEngine.stationId })
    .from(stationEngine)
    .where(inArray(stationEngine.stationId, ids));
  return new Set(rows.map((r) => r.stationId));
}

/**
 * Forgets the station's engine: its row (secrets included) and its ports. Call once its
 * container is gone; afterwards the station can be deleted.
 */
export async function deleteStationEngine(db: Executor, scope: StationScope): Promise<void> {
  await db.delete(enginePort).where(whereStation(enginePort, scope));
  await db.delete(stationEngine).where(scoped(scope));
}

/** Holds a transaction-scoped Postgres advisory lock on the station for `fn`. */
export async function withStationLock<T>(
  db: Executor,
  stationId: string,
  fn: (tx: Executor) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ondes.engine:${stationId}`}))`);
    return fn(tx);
  });
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
  const mine = async () => {
    const [row] = await db
      .select({ port: enginePort.port })
      .from(enginePort)
      .where(and(whereStation(enginePort, scope), eq(enginePort.purpose, purpose)));
    return row?.port;
  };
  for (let attempt = 0; attempt < 20; attempt++) {
    const existing = await mine();
    if (existing !== undefined) return existing;

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
      // Maybe a concurrent call allocated this station's port.
      const raced = await mine();
      if (raced !== undefined) return raced;
      throw new PortPoolExhaustedError(range);
    }
  }
  throw new PortPoolExhaustedError(range);
}
