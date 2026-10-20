import {
  addMembership,
  createApiKey,
  createOrganization,
  createStation,
  type OrgScope,
  unsafeScope,
} from '@ondes/db';
import {
  type Actor,
  allPermissions,
  type Permission,
  type Role,
  rolePermissions,
  roleSchema,
  stationRoleOrgPermissions,
} from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieHeader, createTestApp, signUpAndLogin, type TestApp } from './testing.ts';

// The permission matrix through the real guard: every role against every resource:action, on
// its own station, on another station of the org, and on the org itself.

const system: Actor = { type: 'system', name: 'test' };

function probeRoutes(app: FastifyInstance) {
  for (const permission of allPermissions) {
    const [resource, action] = permission.split(':') as [never, never];
    const guard = { preHandler: app.requirePermission(resource, action) };
    const ok = async () => ({ ok: true });
    app.get(`/api/v1/orgs/:orgId/probe/${resource}/${action}`, guard, ok);
    app.get(`/api/v1/stations/:stationId/probe/${resource}/${action}`, guard, ok);
  }
}

let t: TestApp;
let scope: OrgScope;
let stationA: string;
let stationB: string;
let foreignStation: string;
const cookies = {} as Record<Role, string>;
let outsider: string;

beforeAll(async () => {
  t = await createTestApp({}, probeRoutes);
  const org = await createOrganization(t.tdb.db, system, { slug: 'matrix', name: 'Matrix' });
  scope = unsafeScope(org.id);
  const ctx = { actor: system, scope };
  stationA = (
    await createStation(t.tdb.db, ctx, { slug: 'matrix-a', name: 'A', timezone: 'Europe/Paris' })
  ).id;
  stationB = (
    await createStation(t.tdb.db, ctx, { slug: 'matrix-b', name: 'B', timezone: 'Europe/Paris' })
  ).id;
  const other = await createOrganization(t.tdb.db, system, { slug: 'other', name: 'Other' });
  foreignStation = (
    await createStation(
      t.tdb.db,
      { actor: system, scope: unsafeScope(other.id) },
      { slug: 'foreign', name: 'Foreign', timezone: 'UTC' },
    )
  ).id;

  for (const role of roleSchema.options) {
    const { userId, cookie } = await signUpAndLogin(t, `${role}@matrix.test`);
    cookies[role] = cookie;
    await addMembership(
      t.tdb.db,
      ctx,
      role === 'owner' || role === 'admin'
        ? { level: 'org', userId, role }
        : { level: 'station', userId, stationId: stationA, role },
    );
  }
  outsider = (await signUpAndLogin(t, 'outsider@matrix.test')).cookie;
});
afterAll(() => t?.close());

const isOrgRole = (role: Role) => role === 'owner' || role === 'admin';

async function probe(url: string, headers: Record<string, string>) {
  return (await t.app.inject({ method: 'GET', url, headers })).statusCode;
}

describe.each(roleSchema.options)('%s', (role) => {
  const has = (p: Permission) => rolePermissions[role].includes(p);

  it('on its own station', async () => {
    for (const p of allPermissions) {
      const status = await probe(
        `/api/v1/stations/${stationA}/probe/${p.replace(':', '/')}`,
        cookieHeader(cookies[role]),
      );
      expect({ p, status }).toEqual({ p, status: has(p) ? 200 : 403 });
    }
  });

  it('on another station of the org', async () => {
    for (const p of allPermissions) {
      const status = await probe(
        `/api/v1/stations/${stationB}/probe/${p.replace(':', '/')}`,
        cookieHeader(cookies[role]),
      );
      const expected = isOrgRole(role) ? (has(p) ? 200 : 403) : 404;
      expect({ p, status }).toEqual({ p, status: expected });
    }
  });

  it('on the org', async () => {
    for (const p of allPermissions) {
      const status = await probe(
        `/api/v1/orgs/${scope.orgId}/probe/${p.replace(':', '/')}`,
        cookieHeader(cookies[role]),
      );
      const allowed = isOrgRole(role) ? has(p) : stationRoleOrgPermissions.includes(p);
      expect({ p, status }).toEqual({ p, status: allowed ? 200 : 403 });
    }
  });

  it('never on another org', async () => {
    expect(
      await probe(
        `/api/v1/stations/${foreignStation}/probe/station/read`,
        cookieHeader(cookies[role]),
      ),
    ).toBe(404);
  });
});

describe('callers without a role', () => {
  it('hides the org from non-members', async () => {
    expect(await probe(`/api/v1/orgs/${scope.orgId}/probe/org/read`, cookieHeader(outsider))).toBe(
      404,
    );
    expect(
      await probe(`/api/v1/stations/${stationA}/probe/station/read`, cookieHeader(outsider)),
    ).toBe(404);
  });

  it('asks anonymous callers to sign in', async () => {
    expect(await probe(`/api/v1/orgs/${scope.orgId}/probe/org/read`, {})).toBe(401);
  });

  it('treats malformed ids as not found', async () => {
    expect(await probe('/api/v1/orgs/not-a-uuid/probe/org/read', cookieHeader(cookies.owner))).toBe(
      404,
    );
  });
});

describe('API keys', () => {
  it('grant exactly their scopes, within their org', async () => {
    const { token } = await createApiKey(
      t.tdb.db,
      { actor: system, scope },
      {
        name: 'reader',
        scopes: ['library:read', 'log:*'],
      },
    );
    const bearer = { authorization: `Bearer ${token}` };
    for (const p of allPermissions) {
      const status = await probe(
        `/api/v1/stations/${stationA}/probe/${p.replace(':', '/')}`,
        bearer,
      );
      const allowed = p === 'library:read' || p.startsWith('log:');
      expect({ p, status }).toEqual({ p, status: allowed ? 200 : 403 });
    }
    expect(await probe(`/api/v1/stations/${foreignStation}/probe/library/read`, bearer)).toBe(404);
  });

  it('narrowed to a station, stay on it', async () => {
    const { token } = await createApiKey(
      t.tdb.db,
      { actor: system, scope },
      {
        name: 'station a',
        stationId: stationA,
        scopes: ['library:read', 'org:read'],
      },
    );
    const bearer = { authorization: `Bearer ${token}` };
    expect(await probe(`/api/v1/stations/${stationA}/probe/library/read`, bearer)).toBe(200);
    expect(await probe(`/api/v1/stations/${stationB}/probe/library/read`, bearer)).toBe(404);
    expect(await probe(`/api/v1/orgs/${scope.orgId}/probe/org/read`, bearer)).toBe(404);
  });

  it('are refused when unknown', async () => {
    expect(
      await probe(`/api/v1/orgs/${scope.orgId}/probe/org/read`, {
        authorization: 'Bearer ondes_nope',
      }),
    ).toBe(401);
  });
});
