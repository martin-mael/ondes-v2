import { describe, expect, it } from 'vitest';
import {
  allPermissions,
  effectivePermissions,
  expandScopes,
  highestRole,
  permissionCatalogue,
  permissionScopeSchema,
  type Resource,
  rolePermissions,
} from './auth.ts';
import { type Role, roleSchema } from './tenancy.ts';

// The permission matrix: every role against every resource, written out by hand so that any
// change to a role preset shows up here as a deliberate diff. The api runs the presets through
// the real guard (apps/api/src/modules/auth/permissions.int.test.ts).
const expectedMatrix: Record<Role, Record<Resource, string[]>> = {
  owner: Object.fromEntries(
    Object.entries(permissionCatalogue).map(([r, actions]) => [r, [...actions]]),
  ) as Record<Resource, string[]>,
  admin: {
    ...(Object.fromEntries(
      Object.entries(permissionCatalogue).map(([r, actions]) => [r, [...actions]]),
    ) as Record<Resource, string[]>),
    org: ['read', 'update'],
  },
  station_manager: {
    org: ['read'],
    station: ['read', 'update'],
    member: ['read', 'invite', 'manage'],
    api_key: ['read', 'manage'],
    audit: ['read'],
    library: ['read', 'write'],
    rotation: ['read', 'write'],
    clock: ['read', 'write'],
    show: ['read', 'write', 'write_own'],
    log: ['read', 'write'],
    voice_track: ['read', 'write', 'write_own'],
    live: ['read', 'manage', 'broadcast'],
    engine: ['read', 'control'],
    alert: ['read', 'manage'],
    dashboard: ['read'],
  },
  programmer: {
    org: ['read'],
    station: ['read'],
    member: ['read'],
    api_key: [],
    audit: [],
    library: ['read', 'write'],
    rotation: ['read', 'write'],
    clock: ['read', 'write'],
    show: ['read', 'write', 'write_own'],
    log: ['read', 'write'],
    voice_track: ['read', 'write', 'write_own'],
    live: ['read'],
    engine: ['read'],
    alert: ['read'],
    dashboard: ['read'],
  },
  presenter: {
    org: ['read'],
    station: ['read'],
    member: [],
    api_key: [],
    audit: [],
    library: ['read'],
    rotation: [],
    clock: [],
    show: ['read', 'write_own'],
    log: ['read'],
    voice_track: ['read', 'write_own'],
    live: ['read', 'broadcast'],
    engine: ['read'],
    alert: [],
    dashboard: ['read'],
  },
  viewer: {
    org: ['read'],
    station: ['read'],
    member: [],
    api_key: [],
    audit: [],
    library: [],
    rotation: [],
    clock: [],
    show: ['read'],
    log: ['read'],
    voice_track: [],
    live: [],
    engine: ['read'],
    alert: [],
    dashboard: ['read'],
  },
};

const resources = Object.keys(permissionCatalogue) as Resource[];

describe('role presets', () => {
  for (const role of roleSchema.options) {
    for (const resource of resources) {
      it(`${role} on ${resource}`, () => {
        const granted = permissionCatalogue[resource].filter((action) =>
          rolePermissions[role].includes(`${resource}:${action}` as never),
        );
        expect(granted).toEqual(expectedMatrix[role][resource]);
      });
    }
  }

  it('only grants catalogued permissions', () => {
    for (const role of roleSchema.options) {
      for (const p of rolePermissions[role]) expect(allPermissions).toContain(p);
    }
  });
});

describe('effectivePermissions', () => {
  const station = '00000000-0000-7000-8000-000000000001';
  const other = '00000000-0000-7000-8000-000000000002';

  it('applies org roles to every station', () => {
    const perms = effectivePermissions([{ role: 'admin', stationId: null }], other);
    expect(perms.has('library:write')).toBe(true);
  });

  it('applies station roles to their station only', () => {
    const grants = [{ role: 'programmer' as const, stationId: station }];
    expect(effectivePermissions(grants, station).has('library:write')).toBe(true);
    expect(effectivePermissions(grants, other).size).toBe(0);
  });

  it('gives station members org:read only at org level', () => {
    const perms = effectivePermissions([{ role: 'station_manager', stationId: station }], null);
    expect([...perms]).toEqual(['org:read']);
  });

  it('unions several memberships', () => {
    const perms = effectivePermissions(
      [
        { role: 'viewer', stationId: station },
        { role: 'presenter', stationId: station },
      ],
      station,
    );
    expect(perms.has('live:broadcast')).toBe(true);
    expect(perms.has('dashboard:read')).toBe(true);
  });

  it('finds the highest applicable role', () => {
    const grants = [
      { role: 'viewer' as const, stationId: station },
      { role: 'programmer' as const, stationId: other },
    ];
    expect(highestRole(grants, station)).toBe('viewer');
    expect(highestRole(grants, null)).toBe(null);
    expect(highestRole([...grants, { role: 'admin', stationId: null }], station)).toBe('admin');
  });
});

describe('API-key scopes', () => {
  it('expands resource wildcards', () => {
    expect([...expandScopes(['library:*', 'log:read'])].sort()).toEqual([
      'library:read',
      'library:write',
      'log:read',
    ]);
  });

  it('rejects unknown scopes', () => {
    expect(permissionScopeSchema.safeParse('library:read').success).toBe(true);
    expect(permissionScopeSchema.safeParse('engine:*').success).toBe(true);
    expect(permissionScopeSchema.safeParse('library:fly').success).toBe(false);
    expect(permissionScopeSchema.safeParse('nope:*').success).toBe(false);
    expect([...expandScopes(['nope:*', 'library:fly'])]).toEqual([]);
  });
});
