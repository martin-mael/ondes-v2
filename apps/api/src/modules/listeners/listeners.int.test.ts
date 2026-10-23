import {
  addMembership,
  createOrganization,
  createStation,
  recordListenerSamples,
  unsafeScope,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import {
  type Actor,
  currentListenersSchema,
  type ListenerSample,
  listenerHistorySchema,
} from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { createMemoryMailer } from '../../plugins/mail.ts';
import { cookieHeader, signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../auth/testing.ts';
import { currentListeners, historyStepSeconds, listenerHistory } from './repo.ts';

// Listener counts for the dashboard (#71), over what the Icecast poller records (#32).
// Needs Postgres (`pnpm dev:up`).

const system: Actor = { type: 'system', name: 'test' };
let tdb: TestDatabase;
let app: FastifyInstance;
let cookie: string;
let userId: string;
let orgId: string;

beforeAll(async () => {
  tdb = await createTestDatabase();
  const mailer = createMemoryMailer();
  app = await buildApp({
    db: { client: tdb },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    alerts: { sweepIntervalMs: 0 },
    fastify: { logger: false },
  });
  await app.ready();
  orgId = (await createOrganization(tdb.db, system, { slug: 'listeners', name: 'L' })).id;
  ({ userId, cookie } = await signUpAndLogin(
    { app, tdb, outbox: mailer.outbox } as unknown as TestApp,
    'viewer@listeners.test',
  ));
}, 60_000);

afterAll(async () => {
  await app?.close();
  await tdb?.drop();
}, 60_000);

let n = 0;
async function newStation(role: 'viewer' | null = 'viewer') {
  const ctx = { actor: system, scope: unsafeScope(orgId) };
  const st = await createStation(tdb.db, ctx, {
    slug: `listeners-${++n}`,
    name: 'L',
    timezone: 'Europe/Paris',
  });
  if (role) {
    await addMembership(tdb.db, ctx, { level: 'station', userId, stationId: st.id, role });
  }
  return unsafeScope(orgId, st.id);
}

const sample = (
  stationId: string,
  mount: string,
  at: Date,
  listeners: number,
  sourceConnected = true,
): ListenerSample => ({ stationId, mount, at, listeners, sourceConnected });

describe('listeners', () => {
  it('now: the newest minute per mount seen in the last 3 minutes', async () => {
    const scope = await newStation();
    const other = await newStation(null);
    const now = new Date('2026-10-23T12:00:30Z');
    const m = (ms: number) => new Date(now.getTime() - ms);
    await recordListenerSamples(tdb.db, [
      // mp3: two minutes; the newest one counts, its average rounded.
      sample(scope.stationId, '/l/mp3', m(70_000), 50),
      sample(scope.stationId, '/l/mp3', m(15_000), 10),
      sample(scope.stationId, '/l/mp3', m(5_000), 13),
      // aac: on its fallback for most of the minute.
      sample(scope.stationId, '/l/aac', m(20_000), 4, false),
      sample(scope.stationId, '/l/aac', m(10_000), 4, false),
      sample(scope.stationId, '/l/aac', m(5_000), 6, true),
      // opus: gone for 10 minutes, not "now".
      sample(scope.stationId, '/l/opus', m(600_000), 99),
      // Another station's mount.
      sample(other.stationId, '/x/mp3', m(5_000), 1000),
    ]);
    const current = await currentListeners(tdb.db, scope, now);
    expect(currentListenersSchema.parse(current)).toEqual({
      sampledAt: new Date('2026-10-23T12:00:00Z'),
      total: 17,
      mounts: [
        {
          mount: '/l/aac',
          listeners: 5,
          listenersMax: 6,
          sourceConnected: false,
          sampledAt: new Date('2026-10-23T12:00:00Z'),
        },
        {
          mount: '/l/mp3',
          listeners: 12,
          listenersMax: 13,
          sourceConnected: true,
          sampledAt: new Date('2026-10-23T12:00:00Z'),
        },
      ],
    });
    // No recent data: unknown, not zero.
    expect(await currentListeners(tdb.db, scope, new Date('2026-10-24T00:00:00Z'))).toEqual({
      sampledAt: null,
      total: 0,
      mounts: [],
    });
  });

  it('history: 288 steps over 24 h, null where nothing was sampled', async () => {
    const scope = await newStation();
    const now = new Date('2026-10-23T12:02:00Z');
    await recordListenerSamples(tdb.db, [
      sample(scope.stationId, '/l/mp3', new Date('2026-10-23T11:51:00Z'), 10),
      sample(scope.stationId, '/l/mp3', new Date('2026-10-23T11:53:00Z'), 20),
      sample(scope.stationId, '/l/aac', new Date('2026-10-23T11:52:00Z'), 3),
      sample(scope.stationId, '/l/mp3', new Date('2026-10-22T13:00:00Z'), 7),
      // Older than 24 h: out.
      sample(scope.stationId, '/l/mp3', new Date('2026-10-22T11:00:00Z'), 500),
    ]);
    const history = listenerHistorySchema.parse(await listenerHistory(tdb.db, scope, 24, now));
    expect(history.stepSeconds).toBe(300);
    expect(history.points).toHaveLength(288);
    expect(history.endsAt).toEqual(new Date('2026-10-23T12:05:00Z'));
    expect(history.startsAt).toEqual(new Date('2026-10-22T12:05:00Z'));
    expect(history.mounts).toEqual(['/l/aac', '/l/mp3']);
    const at = (iso: string) => history.points.find((p) => p.startsAt.toISOString() === iso);
    expect(at('2026-10-23T11:50:00.000Z')).toEqual({
      startsAt: new Date('2026-10-23T11:50:00Z'),
      total: 18,
      byMount: { '/l/mp3': 15, '/l/aac': 3 },
    });
    expect(at('2026-10-22T13:00:00.000Z')?.total).toBe(7);
    expect(at('2026-10-23T12:00:00.000Z')).toEqual({
      startsAt: new Date('2026-10-23T12:00:00Z'),
      total: null,
      byMount: {},
    });
    expect(historyStepSeconds(1)).toBe(60);
    expect(historyStepSeconds(6)).toBe(120);
    expect(historyStepSeconds(168)).toBe(2100);
  });

  it('routes need dashboard:read on the station', async () => {
    const scope = await newStation();
    const stranger = await newStation(null);
    const get = (stationId: string, path: string) =>
      app.inject({
        method: 'GET',
        url: `/api/v1/stations/${stationId}/${path}`,
        headers: cookieHeader(cookie),
      });
    const now = await get(scope.stationId, 'listeners');
    expect(now.statusCode).toBe(200);
    expect(now.json()).toEqual({ sampledAt: null, total: 0, mounts: [] });
    const history = await get(scope.stationId, 'listeners/history?hours=6');
    expect(history.statusCode).toBe(200);
    expect(history.json().points).toHaveLength(180);
    expect((await get(scope.stationId, 'listeners/history?hours=0')).statusCode).toBe(400);
    // Not a member: the station doesn't exist for them.
    expect((await get(stranger.stationId, 'listeners')).statusCode).toBe(404);
  });
});
