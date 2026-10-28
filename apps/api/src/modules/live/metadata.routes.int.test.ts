import {
  addMembership,
  auditLog,
  createOrganization,
  createStation,
  liveSession,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
} from '@ondes/db';
import { createTestDatabase } from '@ondes/db/testing';
import {
  type Actor,
  type EngineLiveMetadata,
  liveNowPlayingResponseSchema,
  liveNowPlayingSchema,
  type StreamerWithPassword,
} from '@ondes/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { createMemoryMailer } from '../../plugins/mail.ts';
import { signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../auth/testing.ts';
import type { LiveSwitchEngine } from './switching.ts';

// The live now-playing routes on the real app (#68, ADR 0040): permissions, tenant isolation,
// 409 while nobody is on air, the manual text audited once, and the streamer switch reaching
// the engine at once. The order of sources and the sweep: metadata.int.test.ts.

const system: Actor = { type: 'system', name: 'test' };

let t: TestApp;
let scope: StationScope;
let otherScope: StationScope;
const cookies = { manager: '', programmer: '', viewer: '', outsider: '' };
let streamerId: string;
let sessionId: string;

/** An engine with a DJ on air that records the now-playing it was sent. */
const engine = {
  sent: [] as EngineLiveMetadata[],
  async state() {
    return { live: { enabled: true, connected: true, ready: true, session_id: sessionId } };
  },
  async setLive() {},
  async disconnectLive() {
    return false;
  },
  async setLiveMetadata(m: EngineLiveMetadata) {
    engine.sent.push(m);
    return true;
  },
};

function call(
  who: keyof typeof cookies,
  method: 'GET' | 'PUT' | 'PATCH' | 'DELETE',
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

const audits = () =>
  t.tdb.db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'live_session'), eq(auditLog.entityId, sessionId)));

beforeAll(async () => {
  const tdb = await createTestDatabase();
  const mailer = createMemoryMailer();
  const app = await buildApp({
    db: { client: tdb },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    live: {
      engineFor: async (stationId) =>
        stationId === scope?.stationId ? (engine as unknown as LiveSwitchEngine) : undefined,
      sweepIntervalMs: 0,
      switchIntervalMs: 0,
    },
    fastify: { logger: false },
  });
  await app.ready();
  t = {
    app,
    tdb,
    outbox: mailer.outbox,
    close: async () => {
      await app.close();
      await tdb.drop();
    },
  };
  const db = tdb.db;
  const org = await createOrganization(db, system, { slug: 'np-org', name: 'Org' });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: 'np-fm', name: 'NP FM', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(db, org.id, st.id);
  for (const role of ['manager', 'programmer', 'viewer'] as const) {
    const { userId, cookie } = await signUpAndLogin(t, `${role}@np.test`);
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
  }
  const other = await createOrganization(db, system, { slug: 'np-other', name: 'Other' });
  const otherOrgScope = await resolveOrgScope(db, other.id);
  const ost = await createStation(
    db,
    { actor: system, scope: otherOrgScope },
    { slug: 'np-other-fm', name: 'Other FM', timezone: 'Europe/Paris' },
  );
  otherScope = await resolveStationScope(db, other.id, ost.id);
  const outsider = await signUpAndLogin(t, 'outsider@np.test');
  await addMembership(
    db,
    { actor: system, scope: otherOrgScope },
    { level: 'org', userId: outsider.userId, role: 'owner' },
  );
  cookies.outsider = outsider.cookie;

  const created = await t.app.inject({
    method: 'POST',
    url: `/api/v1/stations/${st.id}/live/streamers`,
    cookies: { ondes_session: cookies.manager },
    payload: { displayName: 'DJ Nova', username: 'nova', anyTime: true },
  });
  expect(created.statusCode).toBe(201);
  streamerId = created.json<StreamerWithPassword>().streamer.id;
}, 60_000);

afterAll(() => t?.close());

beforeEach(async () => {
  await t.tdb.db.delete(liveSession);
  engine.sent = [];
  sessionId = '';
});

async function goLive() {
  const [row] = await t.tdb.db
    .insert(liveSession)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      streamerId,
      streamerName: 'DJ Nova',
      input: 1,
      trigger: 'manual',
      title: 'Night Shift',
    })
    .returning({ id: liveSession.id });
  sessionId = row?.id ?? '';
}

describe('live now-playing API', () => {
  it('is null and refuses a manual text while nobody is on air', async () => {
    const res = await call('programmer', 'GET', '/now-playing');
    expect(res.statusCode).toBe(200);
    expect(liveNowPlayingResponseSchema.parse(res.json())).toEqual({ nowPlaying: null });
    const put = await call('manager', 'PUT', '/now-playing', { title: 'x' });
    expect(put.statusCode).toBe(409);
    expect(put.json()).toMatchObject({ error: 'live_not_on_air' });
    expect((await call('manager', 'DELETE', '/now-playing')).statusCode).toBe(409);
  });

  it('reads for live:read, writes for engine:control, and keeps stations apart', async () => {
    await goLive();
    const res = await call('programmer', 'GET', '/now-playing');
    expect(liveNowPlayingResponseSchema.parse(res.json()).nowPlaying).toMatchObject({
      sessionId,
      title: 'Night Shift',
      artist: 'DJ Nova',
      source: 'default',
    });
    expect((await call('viewer', 'GET', '/now-playing')).statusCode).toBe(403);
    expect((await call('programmer', 'PUT', '/now-playing', { title: 'x' })).statusCode).toBe(403);
    expect((await call('programmer', 'DELETE', '/now-playing')).statusCode).toBe(403);
    // Not a member of this station: it doesn't exist for them.
    expect((await call('outsider', 'GET', '/now-playing')).statusCode).toBe(404);
    expect((await call('outsider', 'PUT', '/now-playing', { title: 'x' })).statusCode).toBe(404);
    // Another station's now-playing: nobody on air there.
    const theirs = await call('outsider', 'GET', '/now-playing', undefined, otherScope.stationId);
    expect(theirs.json()).toEqual({ nowPlaying: null });
    expect(engine.sent).toEqual([]);
  });

  it('sets and clears a manual text, audited once, and validates it', async () => {
    await goLive();
    expect((await call('manager', 'PUT', '/now-playing', { title: ' ' })).statusCode).toBe(400);
    expect(
      (await call('manager', 'PUT', '/now-playing', { title: 'x'.repeat(201) })).statusCode,
    ).toBe(400);

    const put = await call('manager', 'PUT', '/now-playing', {
      title: 'Live at the Marché',
      artist: 'Kiosque',
    });
    expect(put.statusCode).toBe(200);
    expect(liveNowPlayingSchema.parse(put.json())).toMatchObject({
      title: 'Live at the Marché',
      artist: 'Kiosque',
      source: 'manual',
    });
    expect(engine.sent).toEqual([
      { title: 'Live at the Marché', artist: 'Kiosque', encoder: false },
    ]);
    // The same text again: nothing changes, nothing audited or sent.
    await call('manager', 'PUT', '/now-playing', {
      title: 'Live at the Marché',
      artist: 'Kiosque',
    });
    expect(engine.sent).toHaveLength(1);

    const del = await call('manager', 'DELETE', '/now-playing');
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ title: 'Night Shift', source: 'default' });
    // Clearing with no manual text: a no-op.
    expect((await call('manager', 'DELETE', '/now-playing')).statusCode).toBe(200);
    expect(engine.sent).toHaveLength(2);
    expect((await audits()).map((a) => a.action).sort()).toEqual([
      'live.now_playing.clear',
      'live.now_playing.set',
    ]);
  });

  it("sends the streamer's encoder switch to the engine at once, same text or not", async () => {
    await goLive();
    const res = await call('manager', 'PATCH', `/streamers/${streamerId}`, {
      encoderMetadata: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ encoderMetadata: true });
    // Nothing from the encoder yet: still the default, but the engine lets the encoder through.
    expect(engine.sent.at(-1)).toEqual({ title: 'Night Shift', artist: 'DJ Nova', encoder: true });
    await call('manager', 'PATCH', `/streamers/${streamerId}`, { encoderMetadata: false });
    expect(engine.sent.at(-1)).toEqual({
      title: 'Night Shift',
      artist: 'DJ Nova',
      encoder: false,
    });
  });
});
