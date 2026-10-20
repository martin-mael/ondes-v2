import {
  addMembership,
  auditLog,
  createOrganization,
  createStation,
  invitation,
  type OrgScope,
  unsafeScope,
} from '@ondes/db';
import type { Actor } from '@ondes/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cookieHeader,
  createTestApp,
  enableTotp,
  lastToken,
  login,
  signUpAndLogin,
  type TestApp,
} from './testing.ts';

// Tenant-scoped auth flows: invitations, API keys, and the org's "require 2FA" policy.

const system: Actor = { type: 'system', name: 'test' };

let t: TestApp;
let scope: OrgScope;
let stationA: string;
let stationB: string;
let owner: { userId: string; cookie: string };
let manager: { userId: string; cookie: string };

beforeAll(async () => {
  t = await createTestApp();
  const org = await createOrganization(t.tdb.db, system, { slug: 'vandale', name: 'Vandale' });
  scope = unsafeScope(org.id);
  const ctx = { actor: system, scope };
  stationA = (
    await createStation(t.tdb.db, ctx, {
      slug: 'vandale-a',
      name: 'Vandale A',
      timezone: 'Europe/Paris',
    })
  ).id;
  stationB = (
    await createStation(t.tdb.db, ctx, {
      slug: 'vandale-b',
      name: 'Vandale B',
      timezone: 'Europe/Paris',
    })
  ).id;
  owner = await signUpAndLogin(t, 'owner@vandale.test');
  await addMembership(t.tdb.db, ctx, { level: 'org', userId: owner.userId, role: 'owner' });
  manager = await signUpAndLogin(t, 'manager@vandale.test');
  await addMembership(t.tdb.db, ctx, {
    level: 'station',
    userId: manager.userId,
    stationId: stationA,
    role: 'station_manager',
  });
});
afterAll(() => t?.close());

const inject = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  cookie: string | null,
  payload?: object,
) =>
  t.app.inject({
    method,
    url,
    headers: cookie ? cookieHeader(cookie) : {},
    ...(payload ? { payload } : {}),
  });

describe('invitations', () => {
  it('invites an existing account, which accepts after signing in', async () => {
    const invitee = await signUpAndLogin(t, 'existing@vandale.test');
    const created = await inject('POST', `/api/v1/orgs/${scope.orgId}/invitations`, owner.cookie, {
      level: 'station',
      email: 'Existing@Vandale.test',
      stationId: stationB,
      role: 'programmer',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      status: 'pending',
      email: 'existing@vandale.test',
      role: 'programmer',
    });
    const mail = t.outbox.at(-1);
    expect(mail).toMatchObject({
      to: 'existing@vandale.test',
      subject: "You're invited to Vandale on Ondes",
    });
    expect(mail?.text).toContain('Vandale B');
    const [stored] = await t.tdb.db
      .select()
      .from(invitation)
      .where(eq(invitation.id, created.json().id));
    expect(mail?.text).not.toContain(stored?.tokenHash);

    const token = lastToken(t.outbox, 'existing@vandale.test');
    const accepted = await inject('POST', '/api/v1/invitations/accept', invitee.cookie, { token });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe('accepted');

    const me = await inject('GET', '/api/v1/auth/me', invitee.cookie);
    expect(me.json().memberships).toMatchObject([{ stationId: stationB, role: 'programmer' }]);

    const again = await inject('POST', '/api/v1/invitations/accept', invitee.cookie, { token });
    expect(again.statusCode).toBe(409);
    const audit = await t.tdb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, created.json().id));
    expect(audit.map((a) => a.action).sort()).toEqual(['invitation.accept', 'invitation.create']);
  });

  it('lets a new person sign up from the link, verified and a member at once', async () => {
    await inject('POST', `/api/v1/orgs/${scope.orgId}/invitations`, owner.cookie, {
      level: 'org',
      email: 'newcomer@vandale.test',
      role: 'admin',
    });
    const token = lastToken(t.outbox, 'newcomer@vandale.test');
    const signup = await inject('POST', '/api/v1/auth/signup', null, {
      email: 'newcomer@vandale.test',
      name: 'Newcomer',
      password: 'a long enough password',
      invitationToken: token,
    });
    expect(signup.statusCode).toBe(202);
    const { cookie } = await login(t, 'newcomer@vandale.test');
    const me = await inject('GET', '/api/v1/auth/me', cookie);
    expect(me.json()).toMatchObject({
      emailVerified: true,
      memberships: [{ stationId: null, role: 'admin' }],
    });
  });

  it('refuses an invitation meant for another email', async () => {
    await inject('POST', `/api/v1/orgs/${scope.orgId}/invitations`, owner.cookie, {
      level: 'org',
      email: 'someone-else@vandale.test',
      role: 'admin',
    });
    const token = lastToken(t.outbox, 'someone-else@vandale.test');
    const wrongUser = await signUpAndLogin(t, 'forwarded@vandale.test');
    const res = await inject('POST', '/api/v1/invitations/accept', wrongUser.cookie, { token });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('invitation_email_mismatch');
  });

  it('lets a station manager invite to their station, at or below their role', async () => {
    const ok = await inject('POST', `/api/v1/stations/${stationA}/invitations`, manager.cookie, {
      email: 'dj@vandale.test',
      role: 'presenter',
    });
    expect(ok.statusCode).toBe(201);

    const peer = await inject('POST', `/api/v1/stations/${stationA}/invitations`, manager.cookie, {
      email: 'peer@vandale.test',
      role: 'station_manager',
    });
    expect(peer.statusCode).toBe(201);

    const admin = await inject('POST', `/api/v1/orgs/${scope.orgId}/invitations`, manager.cookie, {
      level: 'org',
      email: 'boss@vandale.test',
      role: 'admin',
    });
    expect(admin.statusCode).toBe(403);

    const otherStation = await inject(
      'POST',
      `/api/v1/stations/${stationB}/invitations`,
      manager.cookie,
      {
        email: 'dj2@vandale.test',
        role: 'presenter',
      },
    );
    expect(otherStation.statusCode).toBe(404);

    const list = await inject('GET', `/api/v1/stations/${stationA}/invitations`, manager.cookie);
    expect(list.statusCode).toBe(200);
    expect(list.json().every((i: { stationId: string }) => i.stationId === stationA)).toBe(true);
  });

  it('stops an admin from granting owner', async () => {
    const admin = await signUpAndLogin(t, 'admin@vandale.test');
    await addMembership(
      t.tdb.db,
      { actor: system, scope },
      { level: 'org', userId: admin.userId, role: 'admin' },
    );
    const res = await inject('POST', `/api/v1/orgs/${scope.orgId}/invitations`, admin.cookie, {
      level: 'org',
      email: 'coowner@vandale.test',
      role: 'owner',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('role_too_high');
  });

  it('revokes, replaces and expires invitations', async () => {
    const email = 'revoked@vandale.test';
    const first = await inject('POST', `/api/v1/orgs/${scope.orgId}/invitations`, owner.cookie, {
      level: 'station',
      email,
      stationId: stationA,
      role: 'viewer',
    });
    const firstToken = lastToken(t.outbox, email);
    // A second invitation for the same person and scope replaces the first.
    const second = await inject('POST', `/api/v1/orgs/${scope.orgId}/invitations`, owner.cookie, {
      level: 'station',
      email,
      stationId: stationA,
      role: 'presenter',
    });
    const secondToken = lastToken(t.outbox, email);
    const invitee = await signUpAndLogin(t, email);
    const stale = await inject('POST', '/api/v1/invitations/accept', invitee.cookie, {
      token: firstToken,
    });
    expect(stale.statusCode).toBe(410);
    expect(stale.json().error).toBe('invitation_revoked');
    expect(first.json().id).not.toBe(second.json().id);

    const revoke = await inject(
      'DELETE',
      `/api/v1/orgs/${scope.orgId}/invitations/${second.json().id}`,
      owner.cookie,
    );
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().status).toBe('revoked');
    const revoked = await inject('POST', '/api/v1/invitations/accept', invitee.cookie, {
      token: secondToken,
    });
    expect(revoked.statusCode).toBe(410);

    const third = await inject('POST', `/api/v1/orgs/${scope.orgId}/invitations`, owner.cookie, {
      level: 'station',
      email,
      stationId: stationA,
      role: 'presenter',
    });
    await t.tdb.db
      .update(invitation)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitation.id, third.json().id));
    const expired = await inject('POST', '/api/v1/invitations/accept', invitee.cookie, {
      token: lastToken(t.outbox, email),
    });
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error).toBe('invitation_expired');

    const resent = await inject(
      'POST',
      `/api/v1/orgs/${scope.orgId}/invitations/${third.json().id}/resend`,
      owner.cookie,
    );
    expect(resent.statusCode).toBe(201);
    const ok = await inject('POST', '/api/v1/invitations/accept', invitee.cookie, {
      token: lastToken(t.outbox, email),
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('API keys', () => {
  it('creates a key within the creator permissions, uses it, then revokes it', async () => {
    const tooBroad = await inject('POST', `/api/v1/stations/${stationA}/api-keys`, manager.cookie, {
      name: 'too broad',
      scopes: ['station:delete'],
    });
    expect(tooBroad.statusCode).toBe(403);
    expect(tooBroad.json().error).toBe('scope_too_broad');

    const created = await inject('POST', `/api/v1/stations/${stationA}/api-keys`, manager.cookie, {
      name: 'now playing widget',
      scopes: ['member:read', 'api_key:read'],
    });
    expect(created.statusCode).toBe(201);
    const { token, apiKey } = created.json();
    expect(token).toMatch(/^ondes_/);
    expect(apiKey).toMatchObject({ stationId: stationA, scopes: ['member:read', 'api_key:read'] });

    const bearer = { authorization: `Bearer ${token}` };
    const listed = await t.app.inject({
      method: 'GET',
      url: `/api/v1/stations/${stationA}/api-keys`,
      headers: bearer,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().map((k: { id: string }) => k.id)).toContain(apiKey.id);
    expect(listed.body).not.toContain('keyHash');
    // An API key isn't a user session.
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer });
    expect(me.statusCode).toBe(403);

    const revoked = await inject(
      'DELETE',
      `/api/v1/stations/${stationA}/api-keys/${apiKey.id}`,
      manager.cookie,
    );
    expect(revoked.statusCode).toBe(200);
    const after = await t.app.inject({
      method: 'GET',
      url: `/api/v1/stations/${stationA}/api-keys`,
      headers: bearer,
    });
    expect(after.statusCode).toBe(401);
  });

  it("can't reach another station's keys", async () => {
    const created = await inject('POST', `/api/v1/orgs/${scope.orgId}/api-keys`, owner.cookie, {
      name: 'station b',
      stationId: stationB,
      scopes: ['library:read'],
    });
    expect(created.statusCode).toBe(201);
    const res = await inject(
      'DELETE',
      `/api/v1/stations/${stationA}/api-keys/${created.json().apiKey.id}`,
      manager.cookie,
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('org 2FA policy', () => {
  it('locks members without 2FA out of the org until they enable it', async () => {
    const member = await signUpAndLogin(t, 'nototp@vandale.test');
    await addMembership(
      t.tdb.db,
      { actor: system, scope },
      {
        level: 'station',
        userId: member.userId,
        stationId: stationA,
        role: 'viewer',
      },
    );
    const before = await inject('GET', `/api/v1/orgs/${scope.orgId}/auth-policy`, member.cookie);
    expect(before.json()).toEqual({ orgId: scope.orgId, requireTwoFactor: false });

    const denied = await inject('PUT', `/api/v1/orgs/${scope.orgId}/auth-policy`, manager.cookie, {
      requireTwoFactor: true,
    });
    expect(denied.statusCode).toBe(403);

    // The owner can only turn it on once their own 2FA is on.
    const tooEarly = await inject('PUT', `/api/v1/orgs/${scope.orgId}/auth-policy`, owner.cookie, {
      requireTwoFactor: true,
    });
    expect(tooEarly.statusCode).toBe(409);
    expect(tooEarly.json().error).toBe('enable_two_factor_first');
    await enableTotp(t, owner.cookie);
    const on = await inject('PUT', `/api/v1/orgs/${scope.orgId}/auth-policy`, owner.cookie, {
      requireTwoFactor: true,
    });
    expect(on.statusCode).toBe(200);

    const locked = await inject('GET', `/api/v1/orgs/${scope.orgId}/auth-policy`, member.cookie);
    expect(locked.statusCode).toBe(403);
    expect(locked.json().error).toBe('two_factor_required');
    // Account routes still work, so they can enrol.
    await enableTotp(t, member.cookie);
    const unlocked = await inject('GET', `/api/v1/orgs/${scope.orgId}/auth-policy`, member.cookie);
    expect(unlocked.statusCode).toBe(200);

    const off = await inject('PUT', `/api/v1/orgs/${scope.orgId}/auth-policy`, owner.cookie, {
      requireTwoFactor: false,
    });
    expect(off.statusCode).toBe(200);
  });
});
