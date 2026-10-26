import { addMembership, createOrganization, createStation, unsafeScope } from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import type { Actor } from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { createMemoryMailer } from '../../plugins/mail.ts';
import { cookieHeader, signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../auth/testing.ts';
import { EngineUnavailableError } from '../engine/adapter/index.ts';

// The pre-listen route (#71) over a fake engine: permissions, the proxied stream, and the
// answers when nobody streams or the engine is away. The real engine side is
// prelisten.engine.int.test.ts. Needs Postgres (`pnpm dev:up`).

const system: Actor = { type: 'system', name: 'test' };
const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4]);

let tdb: TestDatabase;
let app: FastifyInstance;
let orgId: string;
let manager: { userId: string; cookie: string };
let viewer: { userId: string; cookie: string };
/** What the fake engine answers, per station. */
const engines = new Map<string, 'stream' | 'nobody' | 'down' | 'endless'>();

beforeAll(async () => {
  tdb = await createTestDatabase();
  const mailer = createMemoryMailer();
  app = await buildApp({
    db: { client: tdb },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    alerts: { sweepIntervalMs: 0 },
    prelisten: {
      engineFor: async (stationId) => {
        const mode = engines.get(stationId);
        if (!mode) return undefined;
        return {
          async listen(input, signal) {
            if (mode === 'down')
              throw new EngineUnavailableError('timeout', 'timed out', {
                stationId,
                route: 'GET /prelisten/1',
              });
            if (mode === 'nobody' || input !== 1) return null;
            if (mode === 'endless') {
              // A live stream: a frame every 50 ms until the client hangs up.
              let timer: NodeJS.Timeout | undefined;
              const body = new ReadableStream<Uint8Array>({
                start(controller) {
                  timer = setInterval(() => controller.enqueue(new Uint8Array(MP3)), 50);
                  signal?.addEventListener('abort', () => {
                    clearInterval(timer);
                    try {
                      controller.close();
                    } catch {} // Already cancelled by the reader.
                  });
                },
                cancel() {
                  clearInterval(timer);
                },
              });
              return new Response(body, { headers: { 'content-type': 'audio/mpeg' } });
            }
            return new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } });
          },
        };
      },
    },
    fastify: { logger: false },
  });
  await app.ready();
  orgId = (await createOrganization(tdb.db, system, { slug: 'prelisten', name: 'P' })).id;
  const t = { app, tdb, outbox: mailer.outbox } as unknown as TestApp;
  manager = await signUpAndLogin(t, 'manager@prelisten.test');
  viewer = await signUpAndLogin(t, 'viewer@prelisten.test');
}, 60_000);

afterAll(async () => {
  await app?.close();
  await tdb?.drop();
}, 60_000);

let n = 0;
let lastStationId = '';
async function newStation(mode?: 'stream' | 'nobody' | 'down' | 'endless') {
  const ctx = { actor: system, scope: unsafeScope(orgId) };
  const st = await createStation(tdb.db, ctx, {
    slug: `prelisten-${++n}`,
    name: 'P',
    timezone: 'Europe/Paris',
  });
  for (const [who, role] of [
    [manager, 'station_manager'],
    [viewer, 'viewer'],
  ] as const) {
    await addMembership(tdb.db, ctx, {
      level: 'station',
      userId: who.userId,
      stationId: st.id,
      role,
    });
  }
  if (mode) engines.set(st.id, mode);
  lastStationId = st.id;
  return (input: number, cookie = manager.cookie) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/stations/${st.id}/live/inputs/${input}/listen`,
      headers: cookieHeader(cookie),
    });
}

describe('pre-listen route', () => {
  it('proxies the input’s MP3 stream to members with live:read', async () => {
    const listen = await newStation('stream');
    const res = await listen(1);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.rawPayload).toEqual(MP3);
    expect((await listen(1, viewer.cookie)).statusCode).toBe(403);
    expect((await listen(0)).statusCode).toBe(400);
  });

  it('404 when nobody streams, 503 when the engine is away or not running', async () => {
    expect((await (await newStation('stream'))(2)).statusCode).toBe(404);
    expect((await (await newStation('nobody'))(1)).json()).toMatchObject({
      error: 'not_connected',
    });
    expect((await (await newStation('down'))(1)).statusCode).toBe(503);
    expect((await (await newStation())(1)).statusCode).toBe(503);
  });

  it('caps the streams open at once per member (2), released when they hang up', async () => {
    await newStation('endless');
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `${address}/api/v1/stations/${lastStationId}/live/inputs/1/listen`;
    const open = () => {
      const controller = new AbortController();
      const res = fetch(url, {
        headers: cookieHeader(manager.cookie),
        signal: controller.signal,
      });
      return { res, close: () => controller.abort() };
    };
    const a = open();
    const b = open();
    expect((await a.res).status).toBe(200);
    expect((await b.res).status).toBe(200);
    const c = open();
    const refused = await c.res;
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: 'too_many_streams' });
    a.close();
    await (await a.res).body?.cancel().catch(() => {});
    // The server sees the hang-up shortly after.
    let again: Response | undefined;
    for (let i = 0; i < 40; i++) {
      const d = open();
      again = await d.res;
      if (again.status === 200) {
        d.close();
        break;
      }
      await again.text();
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(again?.status).toBe(200);
    b.close();
    // Keep-alive sockets of this test's fetches would hold `app.close()` up.
    app.server.closeAllConnections();
  }, 30_000);
});
