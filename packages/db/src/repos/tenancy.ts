import { createHash, randomBytes } from 'node:crypto';
import {
  type Actor,
  type ApiKey,
  type CreateApiKey,
  type CreateMembership,
  type CreateOrganization,
  type CreateStation,
  type CreateUser,
  createApiKeySchema,
  createMembershipSchema,
  createOrganizationSchema,
  createStationSchema,
  createUserSchema,
  type Membership,
  type Organization,
  type Station,
  type UpdateOrganization,
  type UpdateStation,
  type User,
  updateOrganizationSchema,
  updateStationSchema,
} from '@ondes/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { auditDiff, withAudit } from '../audit.ts';
import type { Db, Executor, Tx } from '../client.ts';
import { NotFoundError } from '../errors.ts';
import { apiKey, membership, organization, station, user } from '../schema/tenancy.ts';
import { narrowToStation, type OrgScope, type StationScope, whereOrg } from '../tenant.ts';

// Tenancy repositories. Every read takes a scope and filters on it; every mutation goes through
// `withAudit`, so it writes its audit row in the same transaction.

type Writer = Db | Tx;
export interface OrgContext {
  actor: Actor;
  scope: OrgScope;
}
export interface StationContext {
  actor: Actor;
  scope: StationScope;
}

// --- Organizations -----------------------------------------------------------------------

/** Creates an org. Not tenant-scoped: it creates the tenant. */
export async function createOrganization(
  db: Writer,
  actor: Actor,
  input: CreateOrganization,
): Promise<Organization> {
  const values = createOrganizationSchema.parse(input);
  return withAudit(db, { actor, scope: null }, async (tx, audit) => {
    const [row] = await tx.insert(organization).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    await audit({
      action: 'organization.create',
      entity: { type: 'organization', id: row.id },
      orgId: row.id,
      diff: auditDiff(null, row),
    });
    return row;
  });
}

export async function getOrganization(db: Executor, scope: OrgScope): Promise<Organization> {
  const [row] = await db.select().from(organization).where(eq(organization.id, scope.orgId));
  if (!row) throw new NotFoundError('organization', scope.orgId);
  return row;
}

export async function updateOrganization(
  db: Writer,
  ctx: OrgContext,
  input: UpdateOrganization,
): Promise<Organization> {
  const values = updateOrganizationSchema.parse(input);
  return withAudit(db, ctx, async (tx, audit) => {
    const before = await getOrganization(tx, ctx.scope);
    const [row] = await tx
      .update(organization)
      .set(values)
      .where(eq(organization.id, ctx.scope.orgId))
      .returning();
    if (!row) throw new NotFoundError('organization', ctx.scope.orgId);
    await audit({
      action: 'organization.update',
      entity: { type: 'organization', id: row.id },
      diff: auditDiff(before, row),
    });
    return row;
  });
}

// --- Stations ----------------------------------------------------------------------------

export async function createStation(
  db: Writer,
  ctx: OrgContext,
  input: CreateStation,
): Promise<Station> {
  const values = createStationSchema.parse(input);
  return withAudit(db, ctx, async (tx, audit) => {
    const [row] = await tx
      .insert(station)
      .values({ ...values, orgId: ctx.scope.orgId })
      .returning();
    if (!row) throw new Error('insert returned no row');
    await audit({
      action: 'station.create',
      entity: { type: 'station', id: row.id },
      stationId: row.id,
      diff: auditDiff(null, row),
    });
    return row;
  });
}

/** Throws `NotFoundError` if the station belongs to another org. */
export async function getStation(
  db: Executor,
  scope: OrgScope,
  stationId: string,
): Promise<Station> {
  const [row] = await db
    .select()
    .from(station)
    .where(and(eq(station.id, stationId), whereOrg(station, scope)));
  if (!row) throw new NotFoundError('station', stationId);
  return row;
}

export async function listStations(db: Executor, scope: OrgScope): Promise<Station[]> {
  return db.select().from(station).where(whereOrg(station, scope)).orderBy(asc(station.name));
}

/**
 * Every station's scope, by id. System-only, cross-tenant: for worker backfills that walk all
 * stations. Never call it from an api route or anything a user request reaches.
 */
export async function listAllStationScopes(db: Executor): Promise<StationScope[]> {
  const rows = await db
    .select({ id: station.id, orgId: station.orgId })
    .from(station)
    .orderBy(asc(station.id));
  return rows.map((row) => ({ orgId: row.orgId, stationId: row.id }) as StationScope);
}

export async function updateStation(
  db: Writer,
  ctx: StationContext,
  input: UpdateStation,
): Promise<Station> {
  const values = updateStationSchema.parse(input);
  return withAudit(db, ctx, async (tx, audit) => {
    const before = await getStation(tx, ctx.scope, ctx.scope.stationId);
    const [row] = await tx
      .update(station)
      .set(values)
      .where(and(eq(station.id, ctx.scope.stationId), whereOrg(station, ctx.scope)))
      .returning();
    if (!row) throw new NotFoundError('station', ctx.scope.stationId);
    await audit({
      action: 'station.update',
      entity: { type: 'station', id: row.id },
      diff: auditDiff(before, row),
    });
    return row;
  });
}

// --- Users -------------------------------------------------------------------------------

/** Users are global (one account, many orgs). Their audit rows carry no org. */
export async function createUser(db: Writer, actor: Actor, input: CreateUser): Promise<User> {
  const values = createUserSchema.parse(input);
  return withAudit(db, { actor, scope: null }, async (tx, audit) => {
    const [row] = await tx.insert(user).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    await audit({
      action: 'user.create',
      entity: { type: 'user', id: row.id },
      diff: auditDiff(null, row),
    });
    return row;
  });
}

/** Not tenant-scoped: for sign-in and invitations only. */
export async function findUserByEmail(db: Executor, email: string): Promise<User | undefined> {
  const [row] = await db.select().from(user).where(sql`lower(${user.email}) = lower(${email})`);
  return row;
}

/** A user as seen from an org: throws `NotFoundError` unless they're a member of it. */
export async function getOrgUser(db: Executor, scope: OrgScope, userId: string): Promise<User> {
  const [row] = await db
    .selectDistinct({ user })
    .from(user)
    .innerJoin(membership, eq(membership.userId, user.id))
    .where(and(eq(user.id, userId), whereOrg(membership, scope)));
  if (!row) throw new NotFoundError('user', userId);
  return row.user;
}

// --- Memberships -------------------------------------------------------------------------

export async function addMembership(
  db: Writer,
  ctx: OrgContext,
  input: CreateMembership,
): Promise<Membership> {
  const parsed = createMembershipSchema.parse(input);
  return withAudit(db, ctx, async (tx, audit) => {
    // Proves the station belongs to this org (the composite foreign key enforces it too).
    const stationId =
      parsed.level === 'station'
        ? (await narrowToStation(tx, ctx.scope, parsed.stationId)).stationId
        : null;
    const [row] = await tx
      .insert(membership)
      .values({ userId: parsed.userId, orgId: ctx.scope.orgId, stationId, role: parsed.role })
      .returning();
    if (!row) throw new Error('insert returned no row');
    await audit({
      action: 'membership.create',
      entity: { type: 'membership', id: row.id },
      stationId,
      diff: auditDiff(null, row),
    });
    return row;
  });
}

export async function listMemberships(db: Executor, scope: OrgScope): Promise<Membership[]> {
  return db
    .select()
    .from(membership)
    .where(whereOrg(membership, scope))
    .orderBy(asc(membership.createdAt));
}

export async function removeMembership(
  db: Writer,
  ctx: OrgContext,
  membershipId: string,
): Promise<void> {
  return withAudit(db, ctx, async (tx, audit) => {
    const [row] = await tx
      .delete(membership)
      .where(and(eq(membership.id, membershipId), whereOrg(membership, ctx.scope)))
      .returning();
    if (!row) throw new NotFoundError('membership', membershipId);
    await audit({
      action: 'membership.delete',
      entity: { type: 'membership', id: row.id },
      stationId: row.stationId,
      diff: auditDiff(row, null),
    });
  });
}

// --- API keys ----------------------------------------------------------------------------

const API_KEY_PREFIX = 'ondes_';

/** SHA-256 hex of a full API key. Keys are 256-bit random, so a slow hash isn't needed. */
export function hashApiKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Creates a key. `token` is the only time the full key is available: show it once. */
export async function createApiKey(
  db: Writer,
  ctx: OrgContext,
  input: CreateApiKey,
): Promise<{ apiKey: ApiKey; token: string }> {
  const values = createApiKeySchema.parse(input);
  const token = API_KEY_PREFIX + randomBytes(32).toString('base64url');
  return withAudit(db, ctx, async (tx, audit) => {
    const stationId = values.stationId
      ? (await narrowToStation(tx, ctx.scope, values.stationId)).stationId
      : null;
    const [row] = await tx
      .insert(apiKey)
      .values({
        orgId: ctx.scope.orgId,
        stationId,
        name: values.name,
        prefix: token.slice(0, API_KEY_PREFIX.length + 8),
        keyHash: hashApiKey(token),
        scopes: values.scopes,
        createdBy: ctx.actor.type === 'user' ? ctx.actor.userId : null,
        expiresAt: values.expiresAt ?? null,
      })
      .returning();
    if (!row) throw new Error('insert returned no row');
    const { keyHash: _secret, ...safe } = row;
    await audit({
      action: 'api_key.create',
      entity: { type: 'api_key', id: row.id },
      stationId,
      diff: auditDiff(null, safe),
    });
    return { apiKey: safe, token };
  });
}

const apiKeyColumns = {
  id: apiKey.id,
  orgId: apiKey.orgId,
  stationId: apiKey.stationId,
  name: apiKey.name,
  prefix: apiKey.prefix,
  scopes: apiKey.scopes,
  createdBy: apiKey.createdBy,
  expiresAt: apiKey.expiresAt,
  lastUsedAt: apiKey.lastUsedAt,
  revokedAt: apiKey.revokedAt,
  createdAt: apiKey.createdAt,
};

/** Never returns the hash. */
export async function listApiKeys(db: Executor, scope: OrgScope): Promise<ApiKey[]> {
  return db
    .select(apiKeyColumns)
    .from(apiKey)
    .where(whereOrg(apiKey, scope))
    .orderBy(asc(apiKey.createdAt));
}

export async function revokeApiKey(db: Writer, ctx: OrgContext, apiKeyId: string): Promise<ApiKey> {
  return withAudit(db, ctx, async (tx, audit) => {
    const [row] = await tx
      .update(apiKey)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKey.id, apiKeyId), whereOrg(apiKey, ctx.scope), isNull(apiKey.revokedAt)))
      .returning(apiKeyColumns);
    if (!row) throw new NotFoundError('api_key', apiKeyId);
    await audit({
      action: 'api_key.revoke',
      entity: { type: 'api_key', id: row.id },
      stationId: row.stationId,
      diff: { revokedAt: { from: null, to: row.revokedAt } },
    });
    return row;
  });
}
