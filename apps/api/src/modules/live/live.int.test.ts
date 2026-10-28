import {
  addMembership,
  auditLog,
  createOrganization,
  createStation,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
  streamer,
} from '@ondes/db';
import { createTestDatabase } from '@ondes/db/testing';
import type {
  Actor,
  LiveConnectionInfo,
  LiveEvent,
  LiveHandover,
  LiveHandoverList,
  Show,
  StreamerList,
  StreamerWithPassword,
} from '@ondes/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { createMemoryMailer } from '../../plugins/mail.ts';
import { signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../auth/testing.ts';
import { CONNECT_AUDIT_EVERY_MS, checkLiveLogin, LoginFailureLimiter } from './auth.ts';
import { createLiveRevoker } from './revoke.ts';
import type { LiveSwitchEngine } from './switching.ts';

// Live streamers on the real app (#63): CRUD, permissions, tenant isolation, audit without
// secrets, connection info, and the harbor auth callback against the database.

const system: Actor = { type: 'system', name: 'test' };
const TOKEN = 'engine-token-of-station-a';
const OTHER_TOKEN = 'engine-token-of-station-b';

let t: TestApp;
let scope: StationScope;
let otherScope: StationScope;
const cookies = { manager: '', presenter: '', programmer: '', outsider: '' };
let presenterId: string;
let showId: string;
let otherShowId: string;

/**
 * A fake engine with a DJ connected and on air, recording live gate commands. It doesn't report
 * the harbor pool (an engine rendered before #64): revocation falls back to closing the gate.
 */
const engine = {
  live: { enabled: true, connected: true, ready: true },
  gate: [] as boolean[],
  async state() {
    return { live: { ...this.live } };
  },
  async setLive(enabled: boolean) {
    this.gate.push(enabled);
    this.live.enabled = enabled;
  },
  async disconnectLive() {
    return false;
  },
  muted: [] as [number, boolean][],
  async muteLive(input: number, muted: boolean) {
    this.muted.push([input, muted]);
    return true;
  },
};

async function buildTestApp(): Promise<TestApp> {
  const tdb = await createTestDatabase();
  const mailer = createMemoryMailer();
  const tokens = new Map<string, string>();
  const app = await buildApp({
    db: { client: tdb },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    live: {
      tokenFor: (stationId) => tokens.get(stationId),
      limiter: new LoginFailureLimiter({ max: 5, probeEveryMs: 60_000 }),
      engineFor: async (stationId) =>
        stationId === scope?.stationId ? (engine as unknown as LiveSwitchEngine) : undefined,
      sweepIntervalMs: 0,
      switchIntervalMs: 0,
    },
    fastify: { logger: false },
  });
  app.decorate('testTokens', tokens);
  await app.ready();
  return {
    app,
    tdb,
    outbox: mailer.outbox,
    close: async () => {
      await app.close();
      await tdb.drop();
    },
  };
}

function call(
  who: keyof typeof cookies,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  stationId = scope.stationId,
) {
  return t.app.inject({
    method,
    url: `/api/v1/stations/${stationId}/live${url}`,
    cookies: { ondes_session: cookies[who] },
    ...(payload ? { payload } : {}),
  });
}

function engineLogin(
  body: object,
  { stationId = scope.stationId, token = TOKEN }: { stationId?: string; token?: string } = {},
) {
  return t.app.inject({
    method: 'POST',
    url: `/internal/engine/stations/${stationId}/live-auth`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body,
  });
}

beforeAll(async () => {
  t = await buildTestApp();
  const db = t.tdb.db;
  const org = await createOrganization(db, system, { slug: 'live-org', name: 'Org' });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: 'live-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(db, org.id, st.id);

  for (const role of ['manager', 'presenter', 'programmer'] as const) {
    const { userId, cookie } = await signUpAndLogin(t, `${role}@live.test`);
    await addMembership(
      db,
      { actor: system, scope: orgScope },
      {
        level: 'station',
        stationId: st.id,
        userId,
        role: role === 'manager' ? 'station_manager' : role,
      },
    );
    cookies[role] = cookie;
    if (role === 'presenter') presenterId = userId;
  }

  const other = await createOrganization(db, system, { slug: 'live-other', name: 'Other' });
  const otherOrgScope = await resolveOrgScope(db, other.id);
  const ost = await createStation(
    db,
    { actor: system, scope: otherOrgScope },
    { slug: 'live-other-fm', name: 'Other FM', timezone: 'Europe/Paris' },
  );
  otherScope = await resolveStationScope(db, other.id, ost.id);
  const outsider = await signUpAndLogin(t, 'outsider@live.test');
  await addMembership(
    db,
    { actor: system, scope: otherOrgScope },
    { level: 'org', userId: outsider.userId, role: 'owner' },
  );
  cookies.outsider = outsider.cookie;

  const tokens = (t.app as unknown as { testTokens: Map<string, string> }).testTokens;
  tokens.set(scope.stationId, TOKEN);
  tokens.set(otherScope.stationId, OTHER_TOKEN);

  // A show with a one-off live slot on Thursday 5 November 2026, 20:00–21:00 in Paris
  // (19:00–20:00 UTC), and a show of the other station.
  const showRes = await t.app.inject({
    method: 'POST',
    url: `/api/v1/stations/${st.id}/shows`,
    cookies: { ondes_session: cookies.manager },
    payload: { name: 'Night Shift' },
  });
  showId = showRes.json<Show>().id;
  const slot = await t.app.inject({
    method: 'POST',
    url: `/api/v1/stations/${st.id}/shows/${showId}/slots`,
    cookies: { ondes_session: cookies.manager },
    payload: {
      type: 'live',
      rule: { freq: 'once', date: '2026-11-05', time: '20:00' },
      durationMs: 3_600_000,
    },
  });
  expect(slot.statusCode).toBe(201);
  const otherShow = await t.app.inject({
    method: 'POST',
    url: `/api/v1/stations/${ost.id}/shows`,
    cookies: { ondes_session: cookies.outsider },
    payload: { name: 'Theirs' },
  });
  otherShowId = otherShow.json<Show>().id;
}, 60_000);

afterAll(() => t?.close());

async function auditRows(entityId: string, entityType = 'streamer') {
  return t.tdb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.entityId, entityId)));
}

describe('streamers API', () => {
  let djId: string;
  let djPassword: string;

  it('creates a streamer with a generated password, shown once and stored hashed', async () => {
    const res = await call('manager', 'POST', '/streamers', {
      displayName: 'DJ Nova',
      username: 'Nova',
      showIds: [showId],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<StreamerWithPassword>();
    djId = body.streamer.id;
    djPassword = body.password;
    expect(djPassword).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(body.streamer).toMatchObject({
      username: 'nova',
      displayName: 'DJ Nova',
      enabled: true,
      anyTime: false,
      status: 'active',
      user: null,
      shows: [{ id: showId, name: 'Night Shift' }],
    });
    expect(JSON.stringify(body.streamer)).not.toContain(djPassword);

    const [row] = await t.tdb.db.select().from(streamer).where(eq(streamer.id, djId));
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row?.passwordHash).not.toContain(djPassword);

    const audit = await auditRows(djId);
    expect(audit.map((a) => a.action)).toEqual(['streamer.create']);
    const diff = JSON.stringify(audit[0]?.diff);
    expect(diff).not.toContain(djPassword);
    expect(diff).not.toContain('argon2');
    expect(audit[0]?.diff).toMatchObject({ password: { to: 'set' }, showIds: { to: [showId] } });
  });

  it('refuses a username already used on the station, whatever its case', async () => {
    const res = await call('manager', 'POST', '/streamers', {
      displayName: 'Copy',
      username: 'NOVA',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('streamer_username_taken');
  });

  it('allows the same username on another station', async () => {
    const res = await call(
      'outsider',
      'POST',
      '/streamers',
      {
        displayName: 'Other Nova',
        username: 'nova',
        password: 'other-station-password',
        anyTime: true,
      },
      otherScope.stationId,
    );
    expect(res.statusCode).toBe(201);
  });

  it('refuses reserved usernames, short passwords, foreign shows and non-member users', async () => {
    const reserved = await call('manager', 'POST', '/streamers', {
      displayName: 'x',
      username: 'source',
    });
    expect(reserved.statusCode).toBe(400);
    const short = await call('manager', 'POST', '/streamers', {
      displayName: 'x',
      username: 'shorty',
      password: 'short',
    });
    expect(short.statusCode).toBe(400);
    const foreignShow = await call('manager', 'POST', '/streamers', {
      displayName: 'x',
      username: 'foreign',
      showIds: [otherShowId],
    });
    expect(foreignShow.statusCode).toBe(422);
    const outsiderUser = await call('manager', 'GET', '/streamers/user-candidates');
    expect(outsiderUser.json().users.map((u: { name: string }) => u.name)).toEqual([
      'manager',
      'presenter',
      'programmer',
    ]);
    const nonMember = await call('manager', 'POST', '/streamers', {
      displayName: 'x',
      username: 'stranger',
      userId: '01900000-0000-7000-8000-000000000000',
    });
    expect(nonMember.statusCode).toBe(422);
  });

  it('links a streamer to a presenter, who sees only their own and can reset its password', async () => {
    const created = await call('manager', 'POST', '/streamers', {
      displayName: 'Presenter',
      username: 'presenter',
      userId: presenterId,
      anyTime: true,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<StreamerWithPassword>().streamer.id;

    const mine = await call('presenter', 'GET', '/streamers');
    expect(mine.json<StreamerList>().streamers.map((s) => s.username)).toEqual(['presenter']);
    expect((await call('presenter', 'GET', `/streamers/${djId}`)).statusCode).toBe(404);
    expect((await call('presenter', 'GET', `/streamers/${id}`)).statusCode).toBe(200);

    const reset = await call('presenter', 'POST', `/streamers/${id}/password`, {});
    expect(reset.statusCode).toBe(200);
    expect(reset.json<StreamerWithPassword>().password).toHaveLength(24);
    expect((await call('presenter', 'POST', `/streamers/${djId}/password`, {})).statusCode).toBe(
      404,
    );
    // A programmer reads (live:read) but has no streamer of their own and can't broadcast.
    expect((await call('programmer', 'GET', '/streamers')).json<StreamerList>().streamers).toEqual(
      [],
    );
    expect(
      (await call('presenter', 'POST', '/streamers', { displayName: 'x', username: 'xx' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call('presenter', 'PATCH', `/streamers/${id}`, { enabled: false })).statusCode,
    ).toBe(403);
  });

  it('lists every streamer of the station for a manager, and none of another tenant', async () => {
    const res = await call('manager', 'GET', '/streamers');
    expect(res.json<StreamerList>().streamers.map((s) => s.username)).toEqual([
      'nova',
      'presenter',
    ]);
    expect((await call('outsider', 'GET', '/streamers')).statusCode).toBe(404);
    expect(
      (await call('outsider', 'GET', `/streamers/${djId}`, undefined, otherScope.stationId))
        .statusCode,
    ).toBe(404);
  });

  it('updates fields and shows, auditing only what changed', async () => {
    const res = await call('manager', 'PATCH', `/streamers/${djId}`, {
      displayName: 'DJ Nova (guest)',
      showIds: [],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ displayName: 'DJ Nova (guest)', shows: [] });
    const audit = (await auditRows(djId)).find((a) => a.action === 'streamer.update');
    expect(audit?.diff).toEqual({
      displayName: { from: 'DJ Nova', to: 'DJ Nova (guest)' },
      showIds: { from: [showId], to: [] },
    });
    await call('manager', 'PATCH', `/streamers/${djId}`, { showIds: [showId] });
  });

  it('reports an expired guest as expired', async () => {
    const res = await call('manager', 'POST', '/streamers', {
      displayName: 'Guest',
      username: 'guest',
      password: 'guest-password-123',
      anyTime: true,
      expiresAt: '2020-01-01T00:00:00Z',
    });
    expect(res.json<StreamerWithPassword>().streamer.status).toBe('expired');
  });

  it('gives the connection info', async () => {
    const res = await call('presenter', 'GET', '/connection');
    expect(res.statusCode).toBe(200);
    expect(res.json<LiveConnectionInfo>()).toMatchObject({
      enabled: true,
      host: 'app.test',
      port: null,
      mount: 'live',
      mounts: ['live', 'live-2'],
      shoutcastPort: null,
    });
  });

  describe('harbor auth callback', () => {
    it('needs the station engine token', async () => {
      const body = { user: 'presenter', password: 'x', address: '10.0.0.1' };
      expect((await engineLogin(body, { token: '' })).statusCode).toBe(401);
      expect((await engineLogin(body, { token: OTHER_TOKEN })).statusCode).toBe(401);
      expect((await engineLogin(body, { token: `${TOKEN}x` })).statusCode).toBe(401);
      expect((await engineLogin({ user: 1 })).statusCode).toBe(400);
    });

    it('accepts good credentials of an any-time streamer and audits the connection', async () => {
      const reset = await call('manager', 'POST', '/streamers', {
        displayName: 'Resident',
        username: 'resident',
        password: 'resident-password-1',
        anyTime: true,
      });
      const id = reset.json<StreamerWithPassword>().streamer.id;
      const ok = await engineLogin({
        user: 'Resident',
        password: 'resident-password-1',
        address: '10.0.0.2',
      });
      expect(ok.statusCode).toBe(200);
      const audit = (await auditRows(id)).find((a) => a.action === 'streamer.connect');
      expect(audit).toMatchObject({ actorType: 'system', diff: { address: { to: '10.0.0.2' } } });
      expect(JSON.stringify(audit)).not.toContain('resident-password-1');
      const [row] = await t.tdb.db.select().from(streamer).where(eq(streamer.id, id));
      expect(row?.lastConnectedAt).not.toBeNull();

      // Shoutcast clients: user `source`, `username:password` as the password.
      const icy = await engineLogin({
        user: 'source',
        password: 'resident:resident-password-1',
        address: '10.0.0.2',
      });
      expect(icy.statusCode).toBe(200);
    });

    it('refuses wrong passwords, unknown users, disabled and expired streamers', async () => {
      const at = { address: '10.0.0.3' };
      expect(
        (await engineLogin({ user: 'resident', password: 'nope-nope-nope', ...at })).statusCode,
      ).toBe(403);
      expect(
        (await engineLogin({ user: 'ghost', password: 'resident-password-1', ...at })).statusCode,
      ).toBe(403);
      expect(
        (await engineLogin({ user: 'guest', password: 'guest-password-123', ...at })).statusCode,
      ).toBe(403);
      const res = await call('manager', 'GET', '/streamers');
      const resident = res.json<StreamerList>().streamers.find((s) => s.username === 'resident');
      await call('manager', 'PATCH', `/streamers/${resident?.id}`, { enabled: false });
      expect(
        (
          await engineLogin({
            user: 'resident',
            password: 'resident-password-1',
            address: '10.0.0.4',
          })
        ).statusCode,
      ).toBe(403);
      await call('manager', 'PATCH', `/streamers/${resident?.id}`, { enabled: true });
      expect(
        (
          await engineLogin({
            user: 'resident',
            password: 'resident-password-1',
            address: '10.0.0.4',
          })
        ).statusCode,
      ).toBe(200);
    });

    it("never accepts another station's streamer", async () => {
      // `nova` exists on both stations; the other one's password is refused here.
      const res = await engineLogin({
        user: 'nova',
        password: 'other-station-password',
        address: '10.0.0.5',
      });
      expect(res.statusCode).toBe(403);
      const there = await engineLogin(
        { user: 'nova', password: 'other-station-password', address: '10.0.0.5' },
        { stationId: otherScope.stationId, token: OTHER_TOKEN },
      );
      expect(there.statusCode).toBe(200);
    });

    it('stops a changed password at once', async () => {
      const list = await call('manager', 'GET', '/streamers');
      const resident = list.json<StreamerList>().streamers.find((s) => s.username === 'resident');
      const reset = await call('manager', 'POST', `/streamers/${resident?.id}/password`, {
        password: 'a-brand-new-password',
      });
      expect(reset.statusCode).toBe(200);
      const audit = (await auditRows(resident?.id ?? '')).find(
        (a) => a.action === 'streamer.password',
      );
      expect(JSON.stringify(audit?.diff)).not.toContain('a-brand-new-password');
      const at = { address: '10.0.0.6' };
      expect(
        (await engineLogin({ user: 'resident', password: 'resident-password-1', ...at }))
          .statusCode,
      ).toBe(403);
      expect(
        (await engineLogin({ user: 'resident', password: 'a-brand-new-password', ...at }))
          .statusCode,
      ).toBe(200);
    });

    it('brakes guessing per username and address, letting the right password through', async () => {
      const at = { address: '10.0.0.7' };
      const login = (user: string, password: string, address = at.address) =>
        engineLogin({ user, password, address }).then((r) => r.statusCode);
      for (let i = 0; i < 5; i++) await login('resident', `guess-${i}-xxxxxx`);
      // Braked: one password check per minute. A guess uses it up…
      expect(await login('resident', 'guess-5-xxxxxx')).toBe(403);
      // …so the right password waits for the next probe.
      expect(await login('resident', 'a-brand-new-password')).toBe(403);
      // Other addresses, and other DJs at the same venue address, aren't braked.
      expect(await login('resident', 'a-brand-new-password', '10.0.0.8')).toBe(200);
      expect(await login('presenter-x', 'whatever-password')).toBe(403);
      const limiter = new LoginFailureLimiter({ max: 5, probeEveryMs: 60_000 });
      const key = LoginFailureLimiter.key(scope.stationId, 'resident', at.address);
      for (let i = 0; i < 5; i++) limiter.fail(key, 0);
      // The next probe, a minute later, is a real check: the right password gets in.
      expect(limiter.allow(key, 60_001)).toBe(true);
    });

    it('audits a reconnect loop once', async () => {
      const list = await call('manager', 'GET', '/streamers');
      const resident = list.json<StreamerList>().streamers.find((s) => s.username === 'resident');
      const id = resident?.id ?? '';
      const before = (await auditRows(id)).filter((a) => a.action === 'streamer.connect').length;
      const t0 = new Date('2027-01-01T12:00:00Z');
      const login = { username: 'resident', password: 'a-brand-new-password' };
      // Throttled from the previous login: the last one comes more than the interval after it.
      for (const offset of [0, 1000, 60_000, 60_000 + CONNECT_AUDIT_EVERY_MS + 1000]) {
        const ok = await checkLiveLogin(
          t.tdb.db,
          scope.stationId,
          login,
          new Date(t0.getTime() + offset),
        );
        expect(ok.ok).toBe(true);
      }
      const after = (await auditRows(id)).filter((a) => a.action === 'streamer.connect').length;
      expect(after - before).toBe(2);
    });

    it('lets a show-bound streamer connect only around its slots', async () => {
      const db = t.tdb.db;
      const login = { username: 'nova', password: djPassword };
      const at = (iso: string) => checkLiveLogin(db, scope.stationId, login, new Date(iso));
      // Slot: 19:00–20:00 UTC. Early connection from 18:45.
      expect(await at('2026-11-05T18:40:00Z')).toMatchObject({ ok: false, reason: 'outside_slot' });
      expect(await at('2026-11-05T18:50:00Z')).toMatchObject({ ok: true });
      expect(await at('2026-11-05T19:59:00Z')).toMatchObject({ ok: true });
      expect(await at('2026-11-05T20:00:00Z')).toMatchObject({ ok: false, reason: 'outside_slot' });
      // Through the route, now (the slot is in the future): refused.
      expect(
        (await engineLogin({ user: 'nova', password: djPassword, address: '10.0.0.9' })).statusCode,
      ).toBe(403);
      // An expiry before the slot wins.
      await call('manager', 'PATCH', `/streamers/${djId}`, { expiresAt: '2026-11-05T18:55:00Z' });
      expect(await at('2026-11-05T19:30:00Z')).toMatchObject({ ok: false, reason: 'expired' });
    });
  });

  describe('revocation', () => {
    // Logins stamped after every earlier test's, so each new one holds the live input.
    const connect = async (username: string, password: string, at = new Date()) =>
      expect((await checkLiveLogin(t.tdb.db, scope.stationId, { username, password }, at)).ok).toBe(
        true,
      );

    it('takes a streamer disabled while live off air', async () => {
      const created = await call('manager', 'POST', '/streamers', {
        displayName: 'Live now',
        username: 'live-now',
        password: 'live-now-password',
        anyTime: true,
      });
      const id = created.json<StreamerWithPassword>().streamer.id;
      await connect('live-now', 'live-now-password', new Date('2030-01-01T20:00:00Z'));
      engine.live.enabled = true;
      engine.gate.length = 0;
      await call('manager', 'PATCH', `/streamers/${id}`, { enabled: false });
      expect(engine.gate).toEqual([false]);
      expect((await auditRows(id)).map((a) => a.action)).toContain('streamer.revoke');
    });

    it("leaves the air alone when the streamer isn't the one connected", async () => {
      engine.live.enabled = true;
      engine.gate.length = 0;
      const list = await call('manager', 'GET', '/streamers');
      const resident = list.json<StreamerList>().streamers.find((s) => s.username === 'resident');
      await call('manager', 'PATCH', `/streamers/${resident?.id}`, { enabled: false });
      expect(engine.gate).toEqual([]);
      await call('manager', 'PATCH', `/streamers/${resident?.id}`, { enabled: true });
    });

    it('sweeps a guest off air when their expiry passes', async () => {
      const expires = new Date('2030-01-02T22:00:00Z');
      const created = await call('manager', 'POST', '/streamers', {
        displayName: 'One night',
        username: 'one-night',
        password: 'one-night-password',
        anyTime: true,
        expiresAt: expires.toISOString(),
      });
      const id = created.json<StreamerWithPassword>().streamer.id;
      await connect('one-night', 'one-night-password', new Date(expires.getTime() - 60_000));
      engine.live.enabled = true;
      engine.gate.length = 0;
      const revoker = createLiveRevoker({
        db: t.tdb.db,
        engineFor: async () => engine,
        logger: { warn: () => {}, error: () => {} },
      });
      expect(await revoker.sweep(new Date(expires.getTime() - 1000))).toBe(0);
      expect(await revoker.sweep(new Date(expires.getTime() + 30_000))).toBe(1);
      expect(engine.gate).toEqual([false]);
      // Already off air: the next sweep does nothing.
      expect(await revoker.sweep(new Date(expires.getTime() + 60_000))).toBe(0);
      expect((await auditRows(id)).map((a) => a.action)).toContain('streamer.revoke');
    });

    it('takes a deleted streamer off air', async () => {
      const created = await call('manager', 'POST', '/streamers', {
        displayName: 'Gone',
        username: 'gone',
        password: 'gone-password-123',
        anyTime: true,
      });
      const id = created.json<StreamerWithPassword>().streamer.id;
      await connect('gone', 'gone-password-123', new Date('2030-01-03T20:00:00Z'));
      engine.live.enabled = true;
      engine.gate.length = 0;
      expect((await call('manager', 'DELETE', `/streamers/${id}`)).statusCode).toBe(204);
      expect(engine.gate).toEqual([false]);
    });
  });

  it('deletes a streamer, audited, and its login stops working', async () => {
    const res = await call('manager', 'DELETE', `/streamers/${djId}`);
    expect(res.statusCode).toBe(204);
    expect((await auditRows(djId)).map((a) => a.action)).toContain('streamer.delete');
    expect((await call('manager', 'GET', `/streamers/${djId}`)).statusCode).toBe(404);
    const result = await checkLiveLogin(
      t.tdb.db,
      scope.stationId,
      { username: 'nova', password: djPassword },
      new Date('2026-11-05T19:30:00Z'),
    );
    expect(result).toMatchObject({ ok: false, reason: 'unknown' });
  });
});

describe('events and ad-hoc requests (#65)', () => {
  it('writes events (managers only, audited) and lets their DJs connect around them', async () => {
    const created = await call('manager', 'POST', '/streamers', {
      displayName: 'Gig',
      username: 'gig',
      password: 'gig-password-123',
    });
    const gigId = created.json<StreamerWithPassword>().streamer.id;
    const body = {
      title: 'Concert',
      startsAt: '2030-02-01T20:00:00Z',
      endsAt: '2030-02-01T22:00:00Z',
      streamerIds: [gigId],
    };
    expect((await call('presenter', 'POST', '/events', body)).statusCode).toBe(403);
    expect(
      (await call('manager', 'POST', '/events', { ...body, endsAt: '2030-02-02T21:00:00Z' }))
        .statusCode,
    ).toBe(400);
    const res = await call('manager', 'POST', '/events', body);
    expect(res.statusCode, res.body).toBe(201);
    const event = res.json<LiveEvent>();
    expect(event.streamers).toEqual([{ id: gigId, displayName: 'Gig' }]);
    expect((await auditRows(event.id, 'live_event')).map((a) => a.action)).toEqual([
      'live_event.create',
    ]);
    // Another station's member sees nothing of it.
    expect((await call('outsider', 'GET', '/events')).statusCode).toBe(404);
    const listed = await call('presenter', 'GET', '/events');
    expect(listed.json<{ events: LiveEvent[] }>().events.map((e) => e.id)).toContain(event.id);

    const login = { username: 'gig', password: 'gig-password-123' };
    const at = (iso: string) => checkLiveLogin(t.tdb.db, scope.stationId, login, new Date(iso));
    expect(await at('2030-02-01T19:40:00Z')).toMatchObject({ ok: false, reason: 'outside_slot' });
    expect((await at('2030-02-01T19:50:00Z')).ok).toBe(true);
    expect((await at('2030-02-01T21:59:00Z')).ok).toBe(true);
    expect(await at('2030-02-01T22:00:00Z')).toMatchObject({ ok: false, reason: 'outside_slot' });

    const moved = await call('manager', 'PATCH', `/events/${event.id}`, {
      endsAt: '2030-02-01T19:00:00Z',
    });
    expect(moved.statusCode).toBe(422);
    expect((await call('manager', 'DELETE', `/events/${event.id}`)).statusCode).toBe(204);
    expect((await auditRows(event.id, 'live_event')).map((a) => a.action)).toContain(
      'live_event.delete',
    );
  });

  it('admits a show’s DJ around its live slots only, not its pre-recorded ones', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: `/api/v1/stations/${scope.stationId}/shows`,
      cookies: { ondes_session: cookies.manager },
      payload: { name: 'Taped' },
    });
    const taped = created.json<Show>().id;
    const slot = await t.app.inject({
      method: 'POST',
      url: `/api/v1/stations/${scope.stationId}/shows/${taped}/slots`,
      cookies: { ondes_session: cookies.manager },
      payload: {
        type: 'prerecorded',
        rule: { freq: 'once', date: '2030-03-01', time: '20:00' },
        durationMs: 3_600_000,
      },
    });
    expect(slot.statusCode).toBe(201);
    await call('manager', 'POST', '/streamers', {
      displayName: 'Taper',
      username: 'taper',
      password: 'taper-password-123',
      showIds: [taped],
    });
    const result = await checkLiveLogin(
      t.tdb.db,
      scope.stationId,
      { username: 'taper', password: 'taper-password-123' },
      new Date('2030-03-01T19:30:00Z'),
    );
    expect(result).toMatchObject({ ok: false, reason: 'outside_slot' });
  });

  it('lists pending requests for readers, and only engine:control decides', async () => {
    const listed = await call('presenter', 'GET', '/requests');
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ requests: [] });
    const unknown = '01a15ddf-0000-7000-8000-00000000ffff';
    expect((await call('presenter', 'POST', `/requests/${unknown}/approve`)).statusCode).toBe(403);
    expect((await call('manager', 'POST', `/requests/${unknown}/refuse`)).statusCode).toBe(404);
  });
});

describe('DJ handover (#66)', () => {
  it('mutes an input for engine:control only, audited', async () => {
    // This one test's engine reports a pool: a DJ on input 2, nobody on 1.
    const dj = { connected: true, ready: true, streamer_id: null, muted: false };
    const nobody = { connected: false, ready: false, streamer_id: null };
    Object.assign(engine.live, {
      inputs: [
        { input: 1, mount: 'live', ...nobody },
        { input: 2, mount: 'live-2', ...dj },
      ],
    });
    try {
      expect((await call('presenter', 'PUT', '/inputs/2/mute', { muted: true })).statusCode).toBe(
        403,
      );
      const res = await call('manager', 'PUT', '/inputs/2/mute', { muted: true });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ connected: true, muted: true });
      expect(engine.muted).toEqual([[2, true]]);
      expect((await auditRows(scope.stationId, 'station')).map((r) => r.action)).toContain(
        'live.input.mute',
      );
      const nobodyThere = await call('manager', 'PUT', '/inputs/1/mute', { muted: true });
      expect(nobodyThere.statusCode).toBe(409);
      expect(nobodyThere.json()).toMatchObject({ error: 'live_input_not_connected' });
      expect(engine.muted).toHaveLength(1);
      expect((await call('manager', 'PUT', '/inputs/0/mute', { muted: true })).statusCode).toBe(
        400,
      );
    } finally {
      delete (engine.live as { inputs?: unknown }).inputs;
    }
  });

  it('schedules, lists and cancels handovers; readers only list', async () => {
    const created = await call('manager', 'POST', '/streamers', {
      displayName: 'Next DJ',
      username: 'next-dj',
      anyTime: true,
    });
    expect(created.statusCode).toBe(201);
    const streamerId = created.json<StreamerWithPassword>().streamer.id;
    const at = new Date(Date.now() + 3600_000).toISOString();
    expect((await call('presenter', 'POST', '/handovers', { streamerId, at })).statusCode).toBe(
      403,
    );
    const scheduled = await call('manager', 'POST', '/handovers', { streamerId, at });
    expect(scheduled.statusCode).toBe(201);
    const handover = scheduled.json<LiveHandover>();
    expect(handover).toMatchObject({
      streamer: { id: streamerId, displayName: 'Next DJ' },
      at,
      fadeMs: 2000,
      status: 'pending',
    });
    const listed = await call('presenter', 'GET', '/handovers');
    expect(listed.json<LiveHandoverList>().handovers.map((x) => x.id)).toEqual([handover.id]);
    expect((await call('outsider', 'GET', '/handovers')).statusCode).toBe(404);
    expect(
      (await call('manager', 'POST', '/handovers', { streamerId, at, fadeMs: 20_000 })).statusCode,
    ).toBe(400);
    expect(
      (
        await call('manager', 'POST', '/handovers', {
          streamerId,
          at: new Date(Date.now() - 1000).toISOString(),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await call('outsider', 'POST', '/handovers', { streamerId, at }, otherScope.stationId))
        .statusCode,
    ).toBe(404);

    expect((await call('presenter', 'DELETE', `/handovers/${handover.id}`)).statusCode).toBe(403);
    const cancelled = await call('manager', 'DELETE', `/handovers/${handover.id}`);
    expect(cancelled.json<LiveHandover>().status).toBe('cancelled');
    expect((await call('manager', 'DELETE', `/handovers/${handover.id}`)).statusCode).toBe(409);
    expect((await auditRows(handover.id, 'live_handover')).map((r) => r.action).sort()).toEqual([
      'live_handover.cancel',
      'live_handover.create',
    ]);
  });
});
