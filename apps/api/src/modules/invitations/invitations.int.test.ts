import {
  addMembership,
  auditLog,
  createOrganization,
  createStation,
  inviteLink,
  listMemberships,
  type OrgScope,
  unsafeScope,
} from '@ondes/db';
import type { Actor } from '@ondes/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieHeader, lastToken, signUpAndLogin } from '../auth/testing.ts';
import { MAX_FAILED_CHECKS, recheckDomains } from './service.ts';
import { createInvitationsTestApp, fakeResolver } from './testing.ts';

// Team onboarding (#113) through the real api: domain rules (auto-join, request-to-join,
// review list), bulk invitation lists, invite links, and the station-manager / API-key caps.

const system: Actor = { type: 'system', name: 'test' };
const DOMAIN = 'vandaleradio.org';

let t: Awaited<ReturnType<typeof createInvitationsTestApp>>;
let scope: OrgScope;
let orgId: string;
let stationA: string;
let stationB: string;
let owner: { userId: string; cookie: string };
let manager: { userId: string; cookie: string };

const api = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  cookie?: string,
  payload?: unknown,
) =>
  t.app.inject({
    method,
    url: `/api/v1${url}`,
    ...(cookie ? { headers: cookieHeader(cookie) } : {}),
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

const membershipsOf = async (userId: string) =>
  (await listMemberships(t.tdb.db, scope)).filter((m) => m.userId === userId);

const auditActions = async (action: string) =>
  t.tdb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.orgId, orgId)));

beforeAll(async () => {
  t = await createInvitationsTestApp({ invitationsPerHour: 12 });
  const org = await createOrganization(t.tdb.db, system, {
    slug: 'vandale',
    name: 'Vandale Radio',
  });
  orgId = org.id;
  scope = unsafeScope(org.id);
  const ctx = { actor: system, scope };
  stationA = (
    await createStation(t.tdb.db, ctx, { slug: 'vandale-a', name: 'A', timezone: 'Europe/Paris' })
  ).id;
  stationB = (
    await createStation(t.tdb.db, ctx, { slug: 'vandale-b', name: 'B', timezone: 'Europe/Paris' })
  ).id;
  owner = await signUpAndLogin(t, 'owner@ops.test');
  await addMembership(t.tdb.db, ctx, { level: 'org', userId: owner.userId, role: 'owner' });
  manager = await signUpAndLogin(t, 'manager@ops.test');
  await addMembership(t.tdb.db, ctx, {
    level: 'station',
    userId: manager.userId,
    stationId: stationA,
    role: 'station_manager',
  });
});
afterAll(() => t?.close());

describe('email-domain rules', () => {
  let domainId: string;
  let alice: { userId: string; cookie: string };

  it('refuses public email providers', async () => {
    for (const domain of ['gmail.com', 'outlook.com', 'proton.me']) {
      const res = await api('POST', `/orgs/${orgId}/domains`, owner.cookie, {
        domain,
        policy: 'auto_join',
        defaultGrant: { level: 'station', stationId: stationA, role: 'presenter' },
      });
      expect(res.statusCode, domain).toBe(422);
      expect(res.json().error).toBe('public_email_domain');
    }
  });

  it("doesn't let station managers manage domain rules", async () => {
    const res = await api('POST', `/orgs/${orgId}/domains`, manager.cookie, {
      domain: DOMAIN,
      policy: 'auto_join',
      defaultGrant: { level: 'station', stationId: stationA, role: 'presenter' },
    });
    expect(res.statusCode).toBe(403);
    expect((await api('GET', `/orgs/${orgId}/domains`, manager.cookie)).statusCode).toBe(403);
  });

  it('an unverified domain does nothing', async () => {
    const res = await api('POST', `/orgs/${orgId}/domains`, owner.cookie, {
      domain: '@VandaleRadio.org',
      policy: 'auto_join',
      defaultGrant: { level: 'station', stationId: stationA, role: 'presenter' },
    });
    expect(res.statusCode).toBe(201);
    const domain = res.json();
    domainId = domain.id;
    expect(domain).toMatchObject({ domain: DOMAIN, status: 'unverified' });
    expect(domain.dnsRecord).toMatch(/^ondes-verify=/);

    alice = await signUpAndLogin(t, `alice@${DOMAIN}`);
    expect(await membershipsOf(alice.userId)).toEqual([]);
    expect((await api('GET', '/me/joinable-orgs', alice.cookie)).json()).toEqual([]);
    expect(
      (await api('GET', `/orgs/${orgId}/domains/${domainId}/candidates`, owner.cookie)).json(),
    ).toEqual([]);
  });

  it('verifies by DNS TXT record', async () => {
    const missing = await api('POST', `/orgs/${orgId}/domains/${domainId}/verify`, owner.cookie, {
      method: 'dns',
    });
    expect(missing.statusCode).toBe(422);
    const record: string = missing.json().details.expectedRecord;

    t.dns.set(DOMAIN, [['v=spf1 -all'], [record.slice(0, 20), record.slice(20)]]);
    const res = await api('POST', `/orgs/${orgId}/domains/${domainId}/verify`, owner.cookie, {
      method: 'dns',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'active', verificationMethod: 'dns' });
    expect(await auditActions('org_domain.verify')).toHaveLength(1);
  });

  it('never adds existing users silently: they go to a review list', async () => {
    // Alice registered before the domain was verified: signing in again doesn't add her.
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: `alice@${DOMAIN}`, password: 'a long enough password' },
    });
    expect(await membershipsOf(alice.userId)).toEqual([]);

    const candidates = await api(
      'GET',
      `/orgs/${orgId}/domains/${domainId}/candidates`,
      owner.cookie,
    );
    expect(candidates.json()).toEqual([
      { userId: alice.userId, email: `alice@${DOMAIN}`, name: 'alice' },
    ]);
    const added = await api('POST', `/orgs/${orgId}/domains/${domainId}/candidates`, owner.cookie, {
      userIds: [alice.userId, owner.userId],
    });
    expect(added.json()).toEqual({ added: [alice.userId] });
    expect(await membershipsOf(alice.userId)).toMatchObject([
      { stationId: stationA, role: 'presenter' },
    ]);
    expect(await auditActions('org_domain.member_add')).toHaveLength(1);
  });

  it('auto-joins a new user with a verified email at the domain', async () => {
    const bob = await signUpAndLogin(t, `bob@${DOMAIN}`);
    expect(await membershipsOf(bob.userId)).toMatchObject([
      { stationId: stationA, role: 'presenter' },
    ]);
    expect(t.outbox.findLast((m) => m.to === `bob@${DOMAIN}`)?.subject).toBe(
      "You've joined Vandale Radio",
    );
    const audits = await auditActions('org_domain.auto_join');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'system', actorId: 'domain-auto-join' });
  });

  it("doesn't auto-join until the email is verified", async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: `pending@${DOMAIN}`, name: 'Pending', password: 'a long enough password' },
    });
    const members = await listMemberships(t.tdb.db, scope);
    expect(members).toHaveLength(4); // owner, manager, alice, bob
  });

  it("doesn't let a removed member back in on their next sign-in", async () => {
    const [bobMembership] = (await listMemberships(t.tdb.db, scope)).filter(
      (m) => m.role === 'presenter' && m.userId !== alice.userId,
    );
    if (!bobMembership) throw new Error('bob is not a member');
    const { removeMembership } = await import('@ondes/db');
    await removeMembership(t.tdb.db, { actor: system, scope }, bobMembership.id);
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: `bob@${DOMAIN}`, password: 'a long enough password' },
    });
    expect(await membershipsOf(bobMembership.userId)).toEqual([]);
  });

  it('a paused rule stops auto-joining', async () => {
    const paused = await api('PATCH', `/orgs/${orgId}/domains/${domainId}`, owner.cookie, {
      paused: true,
    });
    expect(paused.json().status).toBe('paused');
    const carol = await signUpAndLogin(t, `carol@${DOMAIN}`);
    expect(await membershipsOf(carol.userId)).toEqual([]);
    expect(await auditActions('org_domain.pause')).toHaveLength(1);
    await api('PATCH', `/orgs/${orgId}/domains/${domainId}`, owner.cookie, { paused: false });
  });

  it("another org can't take a verified domain", async () => {
    const other = await createOrganization(t.tdb.db, system, { slug: 'other', name: 'Other' });
    const otherOwner = await signUpAndLogin(t, 'boss@other.test');
    await addMembership(
      t.tdb.db,
      { actor: system, scope: unsafeScope(other.id) },
      {
        level: 'org',
        userId: otherOwner.userId,
        role: 'owner',
      },
    );
    // Adding works (it doesn't reveal who owns the domain); verifying fails like a missing record.
    const res = await api('POST', `/orgs/${other.id}/domains`, otherOwner.cookie, {
      domain: DOMAIN,
      policy: 'request',
      defaultGrant: { level: 'org', role: 'admin' },
    });
    expect(res.statusCode).toBe(201);
    t.dns.set(DOMAIN, [...(t.dns.get(DOMAIN) ?? []), [res.json().dnsRecord]]);
    const verify = await api(
      'POST',
      `/orgs/${other.id}/domains/${res.json().id}/verify`,
      otherOwner.cookie,
      { method: 'dns' },
    );
    expect(verify.statusCode).toBe(422);
    expect(verify.json()).toMatchObject({
      error: 'verification_failed',
      message: `${DOMAIN} couldn't be verified`,
    });
  });

  it('auto-join never grants org roles', async () => {
    const res = await api('POST', `/orgs/${orgId}/domains`, owner.cookie, {
      domain: 'admins.example',
      policy: 'auto_join',
      defaultGrant: { level: 'org', role: 'admin' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('auto_join_role_too_high');
    const asRequest = await api('POST', `/orgs/${orgId}/domains`, owner.cookie, {
      domain: 'admins.example',
      policy: 'request',
      defaultGrant: { level: 'org', role: 'admin' },
    });
    expect(asRequest.statusCode).toBe(201);
    const switched = await api(
      'PATCH',
      `/orgs/${orgId}/domains/${asRequest.json().id}`,
      owner.cookie,
      { policy: 'auto_join' },
    );
    expect(switched.statusCode).toBe(422);
  });

  it('a pre-existing account asks instead of self-joining an auto-join domain', async () => {
    const early = await signUpAndLogin(t, 'early@crew.example');
    const created = await api('POST', `/orgs/${orgId}/domains`, owner.cookie, {
      domain: 'crew.example',
      policy: 'auto_join',
      defaultGrant: { level: 'station', stationId: stationA, role: 'viewer' },
    });
    t.dns.set('crew.example', [[created.json().dnsRecord]]);
    await api('POST', `/orgs/${orgId}/domains/${created.json().id}/verify`, owner.cookie, {
      method: 'dns',
    });
    const joinable = await api('GET', '/me/joinable-orgs', early.cookie);
    expect(joinable.json()).toMatchObject([{ orgId, policy: 'request' }]);
    const res = await api('POST', `/me/joinable-orgs/${orgId}/join`, early.cookie);
    expect(res.json().status).toBe('requested');
    expect(await membershipsOf(early.userId)).toEqual([]);
  });

  it('API keys cannot manage domain rules or decide requests', async () => {
    const key = await api('POST', `/orgs/${orgId}/api-keys`, owner.cookie, {
      name: 'domains bot',
      scopes: ['member:*'],
    });
    const headers = { authorization: `Bearer ${key.json().token}` };
    for (const url of [`/orgs/${orgId}/domains`, `/orgs/${orgId}/join-requests`]) {
      const res = await t.app.inject({ method: 'GET', url: `/api/v1${url}`, headers });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error).toBe('session_required');
    }
  });

  it('request-to-join: email confirmation, request, approve and refuse', async () => {
    const created = await api('POST', `/orgs/${orgId}/domains`, owner.cookie, {
      domain: 'lecollectif.fr',
      policy: 'request',
      defaultGrant: { level: 'station', stationId: stationB, role: 'viewer' },
    });
    const id = created.json().id;
    const sent = await api('POST', `/orgs/${orgId}/domains/${id}/verify`, owner.cookie, {
      method: 'email',
      mailbox: 'postmaster',
    });
    expect(sent.json()).toMatchObject({
      status: 'unverified',
      emailVerificationSentTo: 'postmaster@lecollectif.fr',
    });
    const confirmed = await api('POST', '/domains/confirm', undefined, {
      token: lastToken(t.outbox, 'postmaster@lecollectif.fr'),
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ status: 'active', verificationMethod: 'email' });

    const dan = await signUpAndLogin(t, 'dan@lecollectif.fr');
    expect(await membershipsOf(dan.userId)).toEqual([]);
    const joinable = await api('GET', '/me/joinable-orgs', dan.cookie);
    expect(joinable.json()).toEqual([
      { orgId, orgName: 'Vandale Radio', domainId: id, policy: 'request', requestPending: false },
    ]);
    const asked = await api('POST', `/me/joinable-orgs/${orgId}/join`, dan.cookie);
    expect(asked.json()).toMatchObject({ status: 'requested', request: { status: 'pending' } });
    expect((await api('POST', `/me/joinable-orgs/${orgId}/join`, dan.cookie)).statusCode).toBe(409);
    expect(t.outbox.findLast((m) => m.to === 'owner@ops.test')?.subject).toBe(
      'dan asks to join Vandale Radio',
    );

    const eve = await signUpAndLogin(t, 'eve@lecollectif.fr');
    await api('POST', `/me/joinable-orgs/${orgId}/join`, eve.cookie);

    const queue = (await api('GET', `/orgs/${orgId}/join-requests?status=pending`, owner.cookie))
      .json()
      .filter((r: { domainId: string }) => r.domainId === id);
    expect(queue.map((r: { email: string }) => r.email)).toEqual([
      'dan@lecollectif.fr',
      'eve@lecollectif.fr',
    ]);
    const [danRequest, eveRequest] = queue;
    expect((await api('GET', `/orgs/${orgId}/join-requests`, manager.cookie)).statusCode).toBe(403);

    const approved = await api(
      'POST',
      `/orgs/${orgId}/join-requests/${danRequest.id}/approve`,
      owner.cookie,
      {},
    );
    expect(approved.json()).toMatchObject({ status: 'approved', decidedBy: owner.userId });
    expect(await membershipsOf(dan.userId)).toMatchObject([
      { stationId: stationB, role: 'viewer' },
    ]);
    expect(t.outbox.findLast((m) => m.to === 'dan@lecollectif.fr')?.subject).toBe(
      "You've joined Vandale Radio",
    );

    const refused = await api(
      'POST',
      `/orgs/${orgId}/join-requests/${eveRequest.id}/refuse`,
      owner.cookie,
    );
    expect(refused.json().status).toBe('refused');
    expect(await membershipsOf(eve.userId)).toEqual([]);
    expect(
      (await api('POST', `/orgs/${orgId}/join-requests/${eveRequest.id}/approve`, owner.cookie, {}))
        .statusCode,
    ).toBe(409);
    // A refused user can't ask again straight away (no request spam).
    const again = await api('POST', `/me/joinable-orgs/${orgId}/join`, eve.cookie);
    expect(again.statusCode).toBe(429);
    expect(again.json().error).toBe('request_cooldown');

    for (const action of ['join_request.create', 'join_request.approve', 'join_request.refuse']) {
      expect((await auditActions(action)).length, action).toBeGreaterThan(0);
    }

    // Removing the rule keeps the members it brought in.
    expect((await api('DELETE', `/orgs/${orgId}/domains/${id}`, owner.cookie)).statusCode).toBe(
      204,
    );
    expect(await membershipsOf(dan.userId)).toHaveLength(1);
    expect(await auditActions('org_domain.delete')).toHaveLength(1);
  });
});

describe('invitation lists', () => {
  it('previews and sends a CSV with mixed rows', async () => {
    const csv = [
      'email,role,station,name',
      'new1@ops.test,presenter,vandale-a,New One',
      `new2@ops.test,admin,,`,
      'not-an-email,viewer,vandale-a,',
      'new3@ops.test,dj,vandale-a,',
      'new4@ops.test,viewer,nowhere,',
      'NEW1@ops.test,programmer,vandale-a,',
      `alice@${DOMAIN},viewer,vandale-a,`,
      'new5@ops.test,viewer,,',
      'new6@ops.test,Station Manager,vandale-b,',
    ].join('\n');
    const preview = await api('POST', `/orgs/${orgId}/invitation-lists/preview`, owner.cookie, {
      format: 'csv',
      text: csv,
    });
    expect(preview.statusCode).toBe(200);
    const { rows, counts } = preview.json();
    expect(
      rows.map((r: { status: string; reason: string | null }) => r.reason ?? r.status),
    ).toEqual([
      'valid',
      'valid',
      'invalid_email',
      'unknown_role',
      'unknown_station',
      'duplicate',
      'already_member',
      'missing_station',
      'valid',
    ]);
    expect(counts).toEqual({ valid: 3, invalid: 4, already_member: 1, duplicate: 1 });
    expect(rows[0]).toMatchObject({
      line: 2,
      name: 'New One',
      stationId: stationA,
      role: 'presenter',
    });

    const sent = await api('POST', `/orgs/${orgId}/invitation-lists/send`, owner.cookie, {
      format: 'csv',
      text: csv,
    });
    expect(sent.statusCode).toBe(201);
    const result = sent.json();
    expect(result.sent.map((i: { email: string }) => i.email)).toEqual([
      'new1@ops.test',
      'new2@ops.test',
      'new6@ops.test',
    ]);
    expect(result.skipped).toHaveLength(6);
    // Each row is a normal #6 invitation, with its own email and audit row.
    const days = (new Date(result.sent[0].expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(14);
    expect(t.outbox.findLast((m) => m.to === 'new2@ops.test')?.subject).toBe(
      "You're invited to Vandale Radio on Ondes",
    );
    expect(await auditActions('invitation.create')).toHaveLength(3);
    expect(await auditActions('invitation_list.send')).toHaveLength(1);

    const listed = await api(
      'GET',
      `/orgs/${orgId}/invitation-lists?status=pending&email=new`,
      owner.cookie,
    );
    expect(listed.json()).toHaveLength(3);
    expect(listed.json()[0].inviter).toEqual({
      id: owner.userId,
      name: 'owner',
      email: 'owner@ops.test',
    });

    // Sending again replaces the pending invitations; accepting one goes through #6.
    const again = await api('POST', `/orgs/${orgId}/invitation-lists/preview`, owner.cookie, {
      format: 'emails',
      text: 'new1@ops.test',
      role: 'presenter',
      stationId: stationA,
    });
    expect(again.json().rows[0]).toMatchObject({ status: 'valid', replacesPending: true });
  });

  it('pasted emails: one role for all', async () => {
    const preview = await api('POST', `/orgs/${orgId}/invitation-lists/preview`, owner.cookie, {
      format: 'emails',
      text: 'a@paste.test, b@paste.test\n"Cee" <c@paste.test>; a@paste.test',
      role: 'viewer',
      stationId: stationB,
    });
    expect(preview.json().counts).toEqual({
      valid: 3,
      invalid: 0,
      already_member: 0,
      duplicate: 1,
    });
  });

  it('shows inviter emails only to people who can invite', async () => {
    const programmer = await signUpAndLogin(t, 'prog@ops.test');
    await addMembership(
      t.tdb.db,
      { actor: system, scope },
      { level: 'station', userId: programmer.userId, stationId: stationA, role: 'programmer' },
    );
    const listed = await api('GET', `/stations/${stationA}/invitation-lists`, programmer.cookie);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()[0].inviter).toEqual({ id: owner.userId, name: 'owner', email: null });
  });

  it('parallel sends share the hourly budget', async () => {
    // 12 per hour in this suite; 3 already sent, so 9 left: only one of two lists of 5 fits.
    const send = (prefix: string) =>
      api('POST', `/orgs/${orgId}/invitation-lists/send`, owner.cookie, {
        format: 'emails',
        text: Array.from({ length: 5 }, (_, i) => `${prefix}${i}@ops.test`).join('\n'),
        role: 'viewer',
        stationId: stationB,
      });
    const results = await Promise.all([send('par-a'), send('par-b')]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 429]);
    // An in-flight send may count one row twice for a moment (created, not yet released from
    // its reservation): the budget errs on the strict side, never the loose one.
    const refused = results.find((r) => r.statusCode === 429)?.json().details;
    expect(refused.requested).toBe(5);
    expect(refused.remaining).toBeLessThanOrEqual(4);
    const audits = await auditActions('invitation_list.send');
    expect(audits.at(-1)?.diff).toMatchObject({ sent: { to: 5 }, completed: { to: true } });
  });

  it('rate-limits sending per org', async () => {
    // 8 sent so far, 4 left.
    const text = Array.from({ length: 10 }, (_, i) => `bulk${i}@ops.test`).join('\n');
    const res = await api('POST', `/orgs/${orgId}/invitation-lists/send`, owner.cookie, {
      format: 'emails',
      text,
      role: 'viewer',
      stationId: stationB,
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({
      error: 'rate_limited',
      details: { remaining: 4, requested: 10 },
    });
  });
});

describe('station managers', () => {
  it("can't grant admin or invite to another station from a list", async () => {
    const preview = await api(
      'POST',
      `/stations/${stationA}/invitation-lists/preview`,
      manager.cookie,
      {
        format: 'csv',
        text: [
          'x1@ops.test,admin',
          'x2@ops.test,viewer,vandale-b',
          'x3@ops.test,station_manager',
          'x4@ops.test,presenter',
        ].join('\n'),
      },
    );
    expect(preview.statusCode).toBe(200);
    expect(
      preview
        .json()
        .rows.map((r: { reason: string | null; status: string }) => r.reason ?? r.status),
    ).toEqual(['role_too_high', 'forbidden_station', 'valid', 'valid']);
    expect(preview.json().rows[3].stationId).toBe(stationA);
  });

  it("can't use org routes or another station's routes", async () => {
    const body = { format: 'emails', text: 'y@ops.test', role: 'viewer', stationId: stationB };
    expect(
      (await api('POST', `/orgs/${orgId}/invitation-lists/send`, manager.cookie, body)).statusCode,
    ).toBe(403);
    expect(
      (await api('POST', `/stations/${stationB}/invitation-lists/send`, manager.cookie, body))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await api('POST', `/orgs/${orgId}/invite-links`, manager.cookie, {
          grant: { level: 'org', role: 'admin' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await api('POST', `/stations/${stationB}/invite-links`, manager.cookie, { role: 'viewer' }))
        .statusCode,
    ).toBe(404);
  });

  it('creates links for their own station, up to their own role', async () => {
    const res = await api('POST', `/stations/${stationA}/invite-links`, manager.cookie, {
      role: 'station_manager',
      label: 'Co-managers',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().inviteLink).toMatchObject({ stationId: stationA, role: 'station_manager' });
    expect(
      (await api('POST', `/stations/${stationA}/invite-links`, manager.cookie, { role: 'admin' }))
        .statusCode,
    ).toBe(400);
  });
});

describe('invite links', () => {
  const createLink = async (body: object) => {
    const res = await api('POST', `/orgs/${orgId}/invite-links`, owner.cookie, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { inviteLink: { id: string }; token: string; url: string };
  };
  const join = (cookie: string, token: string) =>
    api('POST', '/invite-links/join', cookie, { token });

  it('joins with a link, counts uses, and stops when used up', async () => {
    const link = await createLink({
      grant: { level: 'station', stationId: stationB, role: 'presenter' },
      label: 'DJs for the Nov 14 night',
      maxUses: 1,
    });
    expect(link.url).toBe(`https://app.test/join?token=${link.token}`);
    const info = await api('POST', '/invite-links/info', undefined, { token: link.token });
    expect(info.json()).toMatchObject({
      orgName: 'Vandale Radio',
      stationName: 'B',
      role: 'presenter',
    });

    const dj1 = await signUpAndLogin(t, 'dj1@night.test');
    const joined = await join(dj1.cookie, link.token);
    expect(joined.statusCode).toBe(200);
    expect(await membershipsOf(dj1.userId)).toMatchObject([
      { stationId: stationB, role: 'presenter' },
    ]);

    const dj2 = await signUpAndLogin(t, 'dj2@night.test');
    const over = await join(dj2.cookie, link.token);
    expect(over.statusCode).toBe(410);
    expect(over.json().error).toBe('invite_link_used_up');
    expect(await membershipsOf(dj2.userId)).toEqual([]);

    const listed = (await api('GET', `/orgs/${orgId}/invite-links`, owner.cookie)).json();
    expect(listed.find((l: { id: string }) => l.id === link.inviteLink.id)).toMatchObject({
      useCount: 1,
      maxUses: 1,
      status: 'used_up',
    });
    expect(await auditActions('invite_link.use')).toHaveLength(1);
  });

  it('refuses an expired link', async () => {
    const link = await createLink({
      grant: { level: 'station', stationId: stationB, role: 'viewer' },
    });
    await t.tdb.db
      .update(inviteLink)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(inviteLink.id, link.inviteLink.id));
    const user = await signUpAndLogin(t, 'late@night.test');
    const res = await join(user.cookie, link.token);
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('invite_link_expired');
    expect(
      (await api('POST', '/invite-links/info', undefined, { token: link.token })).statusCode,
    ).toBe(410);
  });

  it('refuses a revoked link', async () => {
    const link = await createLink({
      grant: { level: 'station', stationId: stationB, role: 'viewer' },
    });
    const revoked = await api(
      'DELETE',
      `/orgs/${orgId}/invite-links/${link.inviteLink.id}`,
      owner.cookie,
    );
    expect(revoked.json().status).toBe('revoked');
    const user = await signUpAndLogin(t, 'revoked@night.test');
    const res = await join(user.cookie, link.token);
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('invite_link_revoked');
    expect(await auditActions('invite_link.revoke')).toHaveLength(1);
  });

  it('a restricted link only takes emails at the verified domains', async () => {
    const link = await createLink({
      grant: { level: 'station', stationId: stationB, role: 'viewer' },
      restrictToDomains: true,
    });
    const outsider = await signUpAndLogin(t, 'outsider@night.test');
    const refused = await join(outsider.cookie, link.token);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('domain_not_allowed');
    const insider = await signUpAndLogin(t, `frank@${DOMAIN}`); // auto-joins station A
    expect((await join(insider.cookie, link.token)).statusCode).toBe(200);
    expect((await membershipsOf(insider.userId)).map((m) => m.stationId).sort()).toEqual(
      [stationA, stationB].sort(),
    );
  });

  it("an existing member's join doesn't burn a use", async () => {
    const link = await createLink({
      grant: { level: 'station', stationId: stationA, role: 'viewer' },
      maxUses: 5,
    });
    const res = await join(manager.cookie, link.token);
    expect(res.statusCode).toBe(409);
    const [row] = await t.tdb.db
      .select()
      .from(inviteLink)
      .where(eq(inviteLink.id, link.inviteLink.id));
    expect(row?.useCount).toBe(0);
  });

  it('parallel joins never go past maxUses', async () => {
    const link = await createLink({
      grant: { level: 'station', stationId: stationB, role: 'viewer' },
      maxUses: 2,
    });
    const users = await Promise.all(
      [1, 2, 3, 4].map((i) => signUpAndLogin(t, `rush${i}@night.test`)),
    );
    const results = await Promise.all(users.map((u) => join(u.cookie, link.token)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 410, 410]);
    const [row] = await t.tdb.db
      .select()
      .from(inviteLink)
      .where(eq(inviteLink.id, link.inviteLink.id));
    expect(row?.useCount).toBe(2);
  });

  it("stops working when its creator can't grant the role any more", async () => {
    const temp = await signUpAndLogin(t, 'temp-admin@ops.test');
    const membership = await addMembership(
      t.tdb.db,
      { actor: system, scope },
      { level: 'org', userId: temp.userId, role: 'admin' },
    );
    const res = await api('POST', `/orgs/${orgId}/invite-links`, temp.cookie, {
      grant: { level: 'station', stationId: stationB, role: 'programmer' },
    });
    expect(res.statusCode).toBe(201);
    const { removeMembership } = await import('@ondes/db');
    await removeMembership(t.tdb.db, { actor: system, scope }, membership.id);

    const user = await signUpAndLogin(t, 'orphan@night.test');
    const joined = await join(user.cookie, res.json().token);
    expect(joined.statusCode).toBe(410);
    expect(joined.json().error).toBe('invite_link_invalid');
    expect(await membershipsOf(user.userId)).toEqual([]);
  });

  it('stops working when the API key that made it is revoked', async () => {
    const key = await api('POST', `/orgs/${orgId}/api-keys`, owner.cookie, {
      name: 'event bot',
      scopes: ['member:*'],
    });
    const made = await t.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/invite-links`,
      headers: { authorization: `Bearer ${key.json().token}` },
      payload: { grant: { level: 'station', stationId: stationB, role: 'viewer' } },
    });
    expect(made.json().inviteLink.createdByApiKeyId).toBe(key.json().apiKey.id);
    const first = await signUpAndLogin(t, 'bot1@night.test');
    expect((await join(first.cookie, made.json().token)).statusCode).toBe(200);

    await api('DELETE', `/orgs/${orgId}/api-keys/${key.json().apiKey.id}`, owner.cookie);
    const second = await signUpAndLogin(t, 'bot2@night.test');
    const res = await join(second.cookie, made.json().token);
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('invite_link_invalid');
  });

  it('needs a signed-in user', async () => {
    expect(
      (await api('POST', '/invite-links/join', undefined, { token: 'x'.repeat(43) })).statusCode,
    ).toBe(401);
  });
});

describe('API keys', () => {
  it('stay capped like their creator', async () => {
    const key = await api('POST', `/orgs/${orgId}/api-keys`, owner.cookie, {
      name: 'onboarding bot',
      scopes: ['member:*'],
    });
    expect(key.statusCode).toBe(201);
    const bearer = { authorization: `Bearer ${key.json().token}` };
    const asKey = (url: string, payload: object) =>
      t.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: bearer, payload });

    const admin = await asKey(`/orgs/${orgId}/invite-links`, {
      grant: { level: 'org', role: 'admin' },
    });
    expect(admin.statusCode).toBe(403);
    expect(admin.json().error).toBe('role_too_high');
    const station = await asKey(`/orgs/${orgId}/invite-links`, {
      grant: { level: 'station', stationId: stationA, role: 'station_manager' },
    });
    expect(station.statusCode).toBe(201);
    const preview = await asKey(`/orgs/${orgId}/invitation-lists/preview`, {
      format: 'emails',
      text: 'k@ops.test',
      role: 'admin',
    });
    expect(preview.json().rows[0].reason).toBe('role_too_high');
  });
});

describe('domain re-checks', () => {
  const deps = () => ({
    db: t.app.db,
    mailer: t.app.mailer,
    auth: t.app.auth,
    log: t.app.log,
    resolver: fakeResolver(t.dns),
  });
  // A negative interval makes every verified domain due on each call.
  const recheck = () => recheckDomains(deps(), { everyMs: -60_000 });

  const verifiedDomain = async (domain: string) => {
    const created = await api('POST', `/orgs/${orgId}/domains`, owner.cookie, {
      domain,
      policy: 'auto_join',
      defaultGrant: { level: 'station', stationId: stationB, role: 'viewer' },
    });
    t.dns.set(domain, [[created.json().dnsRecord]]);
    const verified = await api(
      'POST',
      `/orgs/${orgId}/domains/${created.json().id}/verify`,
      owner.cookie,
      { method: 'dns' },
    );
    expect(verified.json().status).toBe('active');
    return created.json().id as string;
  };
  const statusOf = async (id: string) =>
    (await api('GET', `/orgs/${orgId}/domains`, owner.cookie))
      .json()
      .find((d: { id: string }) => d.id === id).status;

  it(`unverifies a domain after ${MAX_FAILED_CHECKS} failed checks in a row, and tells the owners`, async () => {
    const id = await verifiedDomain('recheck.example');
    await recheck();
    expect(await statusOf(id)).toBe('active');

    t.dns.delete('recheck.example');
    for (let i = 1; i < MAX_FAILED_CHECKS; i++) await recheck();
    expect(await statusOf(id)).toBe('active');
    await recheck();
    expect(await statusOf(id)).toBe('unverified');
    expect(t.outbox.findLast((m) => m.to === 'owner@ops.test')?.subject).toBe(
      'recheck.example is no longer verified',
    );
    expect(await auditActions('org_domain.unverify')).toHaveLength(1);

    // No longer verified: a new user at the domain isn't auto-joined.
    const late = await signUpAndLogin(t, 'late@recheck.example');
    expect(await membershipsOf(late.userId)).toEqual([]);
  });

  it('a record back in time resets the count', async () => {
    const id = await verifiedDomain('flaky.example');
    const record = t.dns.get('flaky.example') ?? [];
    t.dns.delete('flaky.example');
    for (let i = 1; i < MAX_FAILED_CHECKS; i++) await recheck();
    t.dns.set('flaky.example', record);
    await recheck();
    t.dns.delete('flaky.example');
    await recheck();
    expect(await statusOf(id)).toBe('active');
  });

  it('re-checks when a rule is resumed', async () => {
    const id = await verifiedDomain('resume.example');
    await api('PATCH', `/orgs/${orgId}/domains/${id}`, owner.cookie, { paused: true });
    t.dns.delete('resume.example');
    const res = await api('PATCH', `/orgs/${orgId}/domains/${id}`, owner.cookie, { paused: false });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('verification_lost');
    expect(await statusOf(id)).toBe('unverified');
  });
});
