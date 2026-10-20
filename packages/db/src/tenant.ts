import { and, eq, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Executor } from './client.ts';
import { NotFoundError } from './errors.ts';
import { organization, station } from './schema/tenancy.ts';

// Tenant scoping. Repository functions take a scope as an explicit argument and filter every
// query on it. Scopes are branded: the only way to get one is to resolve it against the
// database (`resolveOrgScope`, `resolveStationScope`), which proves the station belongs to the
// org. The auth layer (#6) then checks the caller's membership before handing it to a module.

declare const scopeBrand: unique symbol;

export interface OrgScope {
  readonly orgId: string;
  readonly [scopeBrand]: true;
}

/** A station scope is also an org scope (for the station's org). */
export interface StationScope extends OrgScope {
  readonly stationId: string;
}

/** Resolves an org scope. Throws `NotFoundError` if the org doesn't exist. */
export async function resolveOrgScope(db: Executor, orgId: string): Promise<OrgScope> {
  const [row] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, orgId));
  if (!row) throw new NotFoundError('organization', orgId);
  return { orgId: row.id } as OrgScope;
}

/** Resolves a station scope. Throws `NotFoundError` unless the station belongs to the org. */
export async function resolveStationScope(
  db: Executor,
  orgId: string,
  stationId: string,
): Promise<StationScope> {
  const [row] = await db
    .select({ id: station.id, orgId: station.orgId })
    .from(station)
    .where(and(eq(station.id, stationId), eq(station.orgId, orgId)));
  if (!row) throw new NotFoundError('station', stationId);
  return { orgId: row.orgId, stationId: row.id } as StationScope;
}

/**
 * Narrows an org scope to one of its stations. Same check as `resolveStationScope`, for code
 * that already holds an org scope.
 */
export function narrowToStation(
  db: Executor,
  scope: OrgScope,
  stationId: string,
): Promise<StationScope> {
  return resolveStationScope(db, scope.orgId, stationId);
}

/** `where` condition for a station-scoped table: `table.station_id = scope.stationId`. */
export function whereStation(table: { stationId: AnyPgColumn }, scope: StationScope): SQL {
  return eq(table.stationId, scope.stationId);
}

/** `where` condition for an org-scoped table: `table.org_id = scope.orgId`. */
export function whereOrg(table: { orgId: AnyPgColumn }, scope: OrgScope): SQL {
  return eq(table.orgId, scope.orgId);
}

/**
 * Builds a scope without checking the database. Only for code that has just read the ids from
 * a row it loaded under another scope, and for tests. Never feed it request input.
 */
export function unsafeScope(orgId: string): OrgScope;
export function unsafeScope(orgId: string, stationId: string): StationScope;
export function unsafeScope(orgId: string, stationId?: string): OrgScope | StationScope {
  return (stationId ? { orgId, stationId } : { orgId }) as OrgScope;
}
