import type { Actor } from '@ondes/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withAudit } from './audit.ts';
import { MissingAuditError, NotFoundError } from './errors.ts';
import {
  addMembership,
  createApiKey,
  createOrganization,
  createStation,
  createUser,
  getOrganization,
  getOrgUser,
  getStation,
  listApiKeys,
  listMemberships,
  listStations,
  removeMembership,
  revokeApiKey,
  updateOrganization,
  updateStation,
} from './repos/tenancy.ts';
import { auditLog, membership, organization, station } from './schema/tenancy.ts';
import { resolveOrgScope, resolveStationScope, unsafeScope } from './tenant.ts';
import { createTestDatabase, type TestDatabase } from './testing.ts';

const system: Actor = { type: 'system', name: 'test' };

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(() => tdb?.drop());

let n = 0;
/** Two tenants, each with one station, one org owner and one station programmer. */
async function twoTenants() {
  n++;
  const make = async (label: string) => {
    const org = await createOrganization(tdb.db, system, { slug: `${label}-${n}`, name: label });
    const orgScope = await resolveOrgScope(tdb.db, org.id);
    const st = await createStation(
      tdb.db,
      { actor: system, scope: orgScope },
      { slug: `${label}-fm-${n}`, name: `${label} FM`, timezone: 'Europe/Paris' },
    );
    const stationScope = await resolveStationScope(tdb.db, org.id, st.id);
    const member = await createUser(tdb.db, system, {
      email: `${label}-${n}@example.test`,
      name: label,
    });
    await addMembership(
      tdb.db,
      { actor: system, scope: orgScope },
      { level: 'station', userId: member.id, stationId: st.id, role: 'programmer' },
    );
    return { org, orgScope, station: st, stationScope, member };
  };
  return { a: await make('alpha'), b: await make('bravo') };
}

describe('tenant scoping', () => {
  it('rejects resolving a station scope across orgs', async () => {
    const { a, b } = await twoTenants();
    await expect(resolveStationScope(tdb.db, a.org.id, b.station.id)).rejects.toThrow(
      NotFoundError,
    );
    await expect(resolveOrgScope(tdb.db, crypto.randomUUID())).rejects.toThrow(NotFoundError);
  });

  it('fails cross-tenant reads', async () => {
    const { a, b } = await twoTenants();
    await expect(getStation(tdb.db, a.orgScope, b.station.id)).rejects.toThrow(NotFoundError);
    await expect(getOrgUser(tdb.db, a.orgScope, b.member.id)).rejects.toThrow(NotFoundError);

    expect((await getStation(tdb.db, a.orgScope, a.station.id)).id).toBe(a.station.id);
    expect((await getOrgUser(tdb.db, a.orgScope, a.member.id)).id).toBe(a.member.id);
    expect((await listStations(tdb.db, a.orgScope)).map((s) => s.id)).toEqual([a.station.id]);
    const memberships = await listMemberships(tdb.db, a.orgScope);
    expect(memberships.every((m) => m.orgId === a.org.id)).toBe(true);
  });

  it('fails cross-tenant writes, even with a forged scope', async () => {
    const { a, b } = await twoTenants();
    const forged = unsafeScope(a.org.id, b.station.id);
    await expect(
      updateStation(tdb.db, { actor: system, scope: forged }, { name: 'hijacked' }),
    ).rejects.toThrow(NotFoundError);
    expect((await getStation(tdb.db, b.orgScope, b.station.id)).name).toBe('bravo FM');

    await expect(
      addMembership(
        tdb.db,
        { actor: system, scope: a.orgScope },
        { level: 'station', userId: a.member.id, stationId: b.station.id, role: 'viewer' },
      ),
    ).rejects.toThrow(NotFoundError);
    await expect(
      createApiKey(
        tdb.db,
        { actor: system, scope: a.orgScope },
        { name: 'x', stationId: b.station.id, scopes: ['log:read'] },
      ),
    ).rejects.toThrow(NotFoundError);

    const { apiKey } = await createApiKey(
      tdb.db,
      { actor: system, scope: b.orgScope },
      { name: 'b key', scopes: ['log:read'] },
    );
    await expect(
      revokeApiKey(tdb.db, { actor: system, scope: a.orgScope }, apiKey.id),
    ).rejects.toThrow(NotFoundError);
    expect(await listApiKeys(tdb.db, a.orgScope)).toEqual([]);

    const [bMembership] = await listMemberships(tdb.db, b.orgScope);
    await expect(
      removeMembership(tdb.db, { actor: system, scope: a.orgScope }, bMembership?.id ?? ''),
    ).rejects.toThrow(NotFoundError);
  });

  it('enforces station/org consistency in the database too', async () => {
    const { a, b } = await twoTenants();
    // Bypass the repositories: the composite foreign key still refuses a station of another org.
    await expect(
      tdb.db.insert(membership).values({
        userId: a.member.id,
        orgId: a.org.id,
        stationId: b.station.id,
        role: 'viewer',
      }),
    ).rejects.toThrow();
    // Station roles need a station, org roles must not have one.
    await expect(
      tdb.db
        .insert(membership)
        .values({ userId: a.member.id, orgId: a.org.id, stationId: null, role: 'viewer' }),
    ).rejects.toThrow();
  });
});

describe('audit log', () => {
  const auditRows = (entityId: string) =>
    tdb.db.select().from(auditLog).where(eq(auditLog.entityId, entityId));

  let tenants: Awaited<ReturnType<typeof twoTenants>>;
  beforeEach(async () => {
    tenants = await twoTenants();
  });

  it('records every repository mutation with actor, tenant and diff', async () => {
    const { a } = tenants;
    const actor: Actor = { type: 'user', userId: a.member.id };

    const org = await createOrganization(tdb.db, actor, { slug: `audit-${n}`, name: 'Audit' });
    const orgScope = await resolveOrgScope(tdb.db, org.id);
    const updatedOrg = await updateOrganization(tdb.db, { actor, scope: orgScope }, { name: 'A2' });
    const st = await createStation(
      tdb.db,
      { actor, scope: orgScope },
      { slug: `audit-fm-${n}`, name: 'Audit FM', timezone: 'Europe/Paris' },
    );
    const stationScope = await resolveStationScope(tdb.db, org.id, st.id);
    await updateStation(tdb.db, { actor, scope: stationScope }, { loudnessTargetLufs: -18 });
    const u = await createUser(tdb.db, actor, { email: `Audit-${n}@Example.test`, name: 'U' });
    const m = await addMembership(
      tdb.db,
      { actor, scope: orgScope },
      { level: 'org', userId: u.id, role: 'admin' },
    );
    await removeMembership(tdb.db, { actor, scope: orgScope }, m.id);
    const { apiKey, token } = await createApiKey(
      tdb.db,
      { actor, scope: orgScope },
      { name: 'k', stationId: st.id, scopes: ['library:*'] },
    );
    await revokeApiKey(tdb.db, { actor, scope: orgScope }, apiKey.id);

    expect(updatedOrg.name).toBe('A2');
    expect(u.email).toBe(`audit-${n}@example.test`);

    const expectations: [string, string[]][] = [
      [org.id, ['organization.create', 'organization.update']],
      [st.id, ['station.create', 'station.update']],
      [u.id, ['user.create']],
      [m.id, ['membership.create', 'membership.delete']],
      [apiKey.id, ['api_key.create', 'api_key.revoke']],
    ];
    for (const [entityId, actions] of expectations) {
      const rows = await auditRows(entityId);
      expect(rows.map((r) => r.action).sort()).toEqual(actions);
      for (const row of rows) {
        expect(row.actorType).toBe('user');
        expect(row.actorId).toBe(a.member.id);
        if (row.action.startsWith('user.')) expect(row.orgId).toBeNull();
        else expect(row.orgId).toBe(org.id);
      }
    }

    const [stationUpdate] = (await auditRows(st.id)).filter((r) => r.action === 'station.update');
    expect(stationUpdate?.stationId).toBe(st.id);
    expect(stationUpdate?.diff).toEqual({ loudnessTargetLufs: { from: -16, to: -18 } });

    const keyAudit = JSON.stringify(await auditRows(apiKey.id));
    expect(keyAudit).not.toContain('keyHash');
    expect(keyAudit).not.toContain(token);
  });

  it('writes nothing when the mutation fails', async () => {
    const { a, b } = tenants;
    const before = await tdb.db.$count(auditLog);
    // Slug taken: the insert fails, so the transaction (and its audit row) rolls back.
    await expect(
      createStation(
        tdb.db,
        { actor: system, scope: a.orgScope },
        { slug: b.station.slug, name: 'dup', timezone: 'Europe/Paris' },
      ),
    ).rejects.toThrow();
    expect(await tdb.db.$count(auditLog)).toBe(before);
  });

  it('rolls back a mutation that forgets its audit entry', async () => {
    const { a } = tenants;
    await expect(
      withAudit(tdb.db, { actor: system, scope: a.orgScope }, async (tx) => {
        await tx.update(organization).set({ name: 'silent' }).where(eq(organization.id, a.org.id));
      }),
    ).rejects.toThrow(MissingAuditError);
    expect((await getOrganization(tdb.db, a.orgScope)).name).toBe('alpha');
  });

  it('rejects invalid input before touching the database', async () => {
    const { a } = tenants;
    await expect(
      createStation(
        tdb.db,
        { actor: system, scope: a.orgScope },
        { slug: `tz-${n}`, name: 'tz', timezone: 'Mars/Olympus_Mons' },
      ),
    ).rejects.toThrow();
    expect(await tdb.db.$count(station, eq(station.slug, `tz-${n}`))).toBe(0);
  });
});
