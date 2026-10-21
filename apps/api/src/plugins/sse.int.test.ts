import { randomUUID } from 'node:crypto';
import { get, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  addMembership,
  createApiKey,
  createOrganization,
  createStation,
  session,
  unsafeScope,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import {
  connectQueue,
  createEventPublisher,
  createJobPublisher,
  deleteTopology,
  type QueueConnection,
  subscribeEvents,
} from '@ondes/queue';
import type { Actor, Role } from '@ondes/shared';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../app.ts';
import {
  cookieHeader,
  login,
  signUpAndLogin,
  TEST_AUTH_CONFIG,
  type TestApp,
} from '../modules/auth/testing.ts';
import { createMemoryMailer } from './mail.ts';
import type { Rabbit } from './rabbit.ts';
import type { SseOptions } from './sse.ts';

// The SSE stream end to end: events published on the RabbitMQ fanout reach the browsers of
// their station that hold the event's read permission, and nobody else.

const url = process.env.RABBITMQ_URL ?? 'amqp://ondes:ondes@127.0.0.1:5672/ondes';
const system: Actor = { type: 'system', name: 'test' };
const password = 'a long enough password';

let tdb: TestDatabase;
let queue: QueueConnection;
let rabbit: Rabbit;
let t: TestApp;
const apps: FastifyInstance[] = [];
let stationA: string;
let stationB: string;
const cookies = {} as Record<'owner' | 'programmer' | 'viewer' | 'outsider', string>;
const keys = {} as Record<'engineReader' | 'stationOnly', string>;

/** A Rabbit on a random topology prefix, so the test doesn't see or feed the dev stack. */
async function testRabbit(): Promise<Rabbit> {
  queue = await connectQueue(url, { prefix: `test-${randomUUID().slice(0, 8)}` });
  const jobs = createJobPublisher(queue.rabbit, queue.topology);
  const events = createEventPublisher(queue.rabbit, queue.topology, z.unknown());
  const subs: { close(): Promise<void> }[] = [];
  return {
    queue,
    jobs,
    events,
    subscribeEvents(onEvent) {
      const sub = subscribeEvents(queue.rabbit, queue.topology, z.unknown(), onEvent);
      subs.push(sub);
      return sub;
    },
    async close() {
      await Promise.all(subs.map((s) => s.close()));
      await Promise.all([jobs.close(), events.close()]);
      await deleteTopology(queue.rabbit, queue.topology);
      await queue.close();
    },
  };
}

/** An api on the shared database and fanout, listening on a random port. */
async function startApp(sse: Partial<SseOptions> = {}) {
  const mailer = createMemoryMailer();
  const app = await buildApp({
    db: { client: tdb },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    rabbit: { rabbit },
    sse: { heartbeatMs: 50, clockMs: 60_000, ...sse },
    fastify: { logger: false },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  await app.sse.ready;
  apps.push(app);
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { app, base, outbox: mailer.outbox };
}

let main: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  tdb = await createTestDatabase();
  rabbit = await testRabbit();
  main = await startApp();
  t = { app: main.app, tdb, outbox: main.outbox, close: async () => {} };

  const org = await createOrganization(tdb.db, system, { slug: 'sse', name: 'SSE' });
  const ctx = { actor: system, scope: unsafeScope(org.id) };
  const station = (slug: string) =>
    createStation(tdb.db, ctx, { slug, name: slug, timezone: 'Europe/Paris' });
  stationA = (await station('sse-a')).id;
  stationB = (await station('sse-b')).id;
  const member = async (key: keyof typeof cookies, role: Role, stationId: string | null) => {
    const { userId, cookie } = await signUpAndLogin(t, `${key}@sse.test`, password);
    cookies[key] = cookie;
    await addMembership(
      tdb.db,
      ctx,
      stationId === null
        ? { level: 'org', userId, role: role as 'owner' }
        : { level: 'station', userId, stationId, role: role as 'viewer' },
    );
  };
  await member('owner', 'owner', null);
  await member('programmer', 'programmer', stationA);
  await member('viewer', 'viewer', stationA);
  await member('outsider', 'programmer', stationB);
  // System-made keys (no creator) keep their scopes as is.
  const key = async (scopes: string[]) =>
    (await createApiKey(tdb.db, ctx, { name: scopes.join(' '), stationId: stationA, scopes }))
      .token;
  keys.engineReader = await key(['station:read', 'engine:read']);
  keys.stationOnly = await key(['station:read']);
});
afterAll(async () => {
  for (const app of apps) await app.close();
  await rabbit?.close();
  await tdb?.drop();
});

type Frame = { id?: string; data?: unknown; comment?: boolean };
type Auth = { cookie: string } | { apiKey: string } | null;

async function waitFor<T>(probe: () => T | undefined | false, message: () => string) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(message());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Opens a stream and parses its frames as they arrive. */
async function open(
  stationId: string,
  auth: Auth,
  opts: { base?: string; lastEventId?: string; query?: string } = {},
) {
  const controller = new AbortController();
  const headers: Record<string, string> = {};
  if (auth && 'cookie' in auth) headers.cookie = `ondes_session=${auth.cookie}`;
  if (auth && 'apiKey' in auth) headers.authorization = `Bearer ${auth.apiKey}`;
  if (opts.lastEventId) headers['last-event-id'] = opts.lastEventId;
  const res = await fetch(
    `${opts.base ?? main.base}/api/v1/stations/${stationId}/events${opts.query ?? ''}`,
    { headers, signal: controller.signal },
  );
  const frames: Frame[] = [];
  let ended = false;
  if (res.ok && res.body) {
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          let end = buffer.indexOf('\n\n');
          while (end >= 0) {
            const frame: Frame = {};
            for (const line of buffer.slice(0, end).split('\n')) {
              if (line.startsWith(':')) frame.comment = true;
              else if (line.startsWith('id: ')) frame.id = line.slice(4);
              else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
            }
            frames.push(frame);
            buffer = buffer.slice(end + 2);
            end = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // aborted
      } finally {
        ended = true;
      }
    })();
  } else {
    ended = true;
  }
  return {
    res,
    frames,
    ids: () => frames.flatMap((f) => (f.id ? [f.id] : [])),
    ended: () => ended,
    /** Resolves once a frame matches (or fails after 5 s). */
    until: (match: (frame: Frame) => boolean) =>
      waitFor(
        () => frames.find(match),
        () => `no matching frame in ${JSON.stringify(frames)}`,
      ),
    close: () => controller.abort(),
  };
}

const isClock = (f: Frame) => (f.data as { type?: string } | undefined)?.type === 'server.clock';
const withId = (id: string) => (f: Frame) => f.id === id;
const ended = (s: { ended(): boolean }) => waitFor(s.ended, () => 'stream still open');

const engineUp = (stationId: string) => ({
  id: randomUUID(),
  stationId,
  at: new Date().toISOString(),
  type: 'engine.up' as const,
  data: { bootId: 'boot', version: '2.4.2' },
});

describe('GET /api/v1/stations/:stationId/events', () => {
  it('needs a session or key that reaches the station', async () => {
    expect((await open(stationA, null)).res.status).toBe(401);
    expect((await open(stationA, { cookie: cookies.outsider })).res.status).toBe(404);
    const access = await main.app.inject({
      url: `/api/v1/stations/${stationA}/events/access`,
      headers: cookieHeader(cookies.viewer),
    });
    expect(access.statusCode).toBe(200);
    expect(access.json().permissions).toContain('engine:read');
  });

  it('starts with the server clock and keeps the stream alive with heartbeats', async () => {
    const s = await open(stationA, { cookie: cookies.viewer });
    expect(s.res.headers.get('content-type')).toContain('text/event-stream');
    expect(s.res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await s.until(isClock)).id).toBeUndefined();
    await s.until((f) => f.comment === true);
    s.close();
  });

  it('forwards only declared events of the station, to callers who may read them', async () => {
    const owner = await open(stationA, { cookie: cookies.owner });
    const viewer = await open(stationA, { cookie: cookies.viewer });
    const reader = await open(stationA, { apiKey: keys.engineReader });
    const stationOnly = await open(stationA, { apiKey: keys.stationOnly });
    const other = await open(stationB, { cookie: cookies.outsider });
    const all = [owner, viewer, reader, stationOnly, other];
    for (const s of all) await s.until(isClock);

    const forB = engineUp(stationB);
    // Undeclared types never leave the api, even under a known domain.
    const undeclared = { ...engineUp(stationA), type: 'station.deleted' };
    const undeclaredEngine = { ...engineUp(stationA), type: 'engine.secret' };
    const declared = engineUp(stationA);
    const withExtras = { ...declared, secret: 'top', data: { ...declared.data, token: 'leak' } };
    const last = engineUp(stationA);
    for (const e of [forB, undeclared, undeclaredEngine, withExtras, { type: 'engine.up' }, last]) {
      await rabbit.events.publish(e);
    }

    // Fanout order is kept, so once `last` arrived everything before it was handled.
    for (const s of [owner, viewer, reader]) await s.until(withId(last.id));
    await other.until(withId(forB.id));
    await new Promise((resolve) => setTimeout(resolve, 100));

    for (const s of [owner, viewer, reader]) expect(s.ids()).toEqual([declared.id, last.id]);
    // The key without engine:read only gets its clock and heartbeats.
    expect(stationOnly.ids()).toEqual([]);
    expect(other.ids()).toEqual([forB.id]);
    // Re-serialised through the contract: undeclared fields are gone.
    expect(viewer.frames.find(withId(declared.id))?.data).toEqual(declared);
    for (const s of all) s.close();
  });

  it('replays what the client missed after Last-Event-ID (header or query)', async () => {
    const live = await open(stationA, { cookie: cookies.programmer });
    await live.until(isClock);
    const events = [engineUp(stationA), engineUp(stationA), engineUp(stationA)];
    const [first, second, third] = events.map((e) => e.id);
    await rabbit.events.publish(events[0]);
    await rabbit.events.publish(engineUp(stationB));
    await rabbit.events.publish(events[1]);
    await rabbit.events.publish(events[2]);
    await live.until(withId(third ?? ''));
    live.close();

    const auth = { cookie: cookies.programmer };
    const byHeader = await open(stationA, auth, { lastEventId: first });
    await byHeader.until(withId(third ?? ''));
    expect(byHeader.ids()).toEqual([second, third]);
    const byQuery = await open(stationA, auth, { query: `?lastEventId=${first}` });
    await byQuery.until(withId(third ?? ''));
    expect(byQuery.ids()).toEqual([second, third]);
    byHeader.close();
    byQuery.close();
  });

  it('forgets closed connections', async () => {
    const streams = await Promise.all(
      [1, 2, 3].map(() => open(stationA, { cookie: cookies.owner })),
    );
    for (const s of streams) await s.until(isClock);
    expect(main.app.sse.clients).toBe(3);
    for (const s of streams) s.close();
    await waitFor(
      () => main.app.sse.clients === 0,
      () => `${main.app.sse.clients} clients left`,
    );
  });
});

describe('stream lifetime', () => {
  it('ends streams after maxStreamMs; the client resumes where it was', async () => {
    const short = await startApp({ maxStreamMs: 300, maxStreamJitter: 0 });
    const auth = { cookie: cookies.programmer };
    const first = await open(stationA, auth, { base: short.base });
    await first.until(isClock);
    const seen = engineUp(stationA);
    await rabbit.events.publish(seen);
    await first.until(withId(seen.id));
    await ended(first);
    const missed = engineUp(stationA);
    await rabbit.events.publish(missed);

    const resumed = await open(stationA, auth, { base: short.base, lastEventId: seen.id });
    await resumed.until(withId(missed.id));
    resumed.close();
  });

  it('closes the stream when its session expires', async () => {
    const { cookie } = await login(t, 'viewer@sse.test', password);
    // The newest session is the one just created.
    const [row] = await tdb.db.select().from(session).orderBy(desc(session.createdAt)).limit(1);
    await tdb.db
      .update(session)
      .set({ expiresAt: new Date(Date.now() + 500) })
      .where(eq(session.id, row?.id ?? ''));
    const s = await open(stationA, { cookie });
    await s.until(isClock);
    await ended(s);
  });

  it('closes the stream at the next check once the session is revoked', async () => {
    const checked = await startApp({ revalidateMs: 100 });
    const { cookie } = await login(t, 'programmer@sse.test', password);
    const s = await open(stationA, { cookie }, { base: checked.base });
    await s.until(isClock);
    const logout = await main.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: cookieHeader(cookie),
    });
    expect(logout.statusCode).toBe(204);
    await ended(s);
    expect(checked.app.sse.clients).toBe(0);
  });

  it('caps open streams per credential, closing the oldest', async () => {
    const capped = await startApp({ maxStreamsPerCredential: 2 });
    const auth = { apiKey: keys.engineReader };
    const first = await open(stationA, auth, { base: capped.base });
    await first.until(isClock);
    const second = await open(stationA, auth, { base: capped.base });
    await second.until(isClock);
    const third = await open(stationA, auth, { base: capped.base });
    await third.until(isClock);
    await ended(first);
    expect(second.ended()).toBe(false);
    expect(capped.app.sse.clients).toBe(2);
    second.close();
    third.close();
  });

  it('drops a client that stops reading', async () => {
    const strict = await startApp({ maxBufferedBytes: 64 * 1024 });
    // A raw request whose response is never read: the socket buffers fill, then Node's.
    const stalled = await new Promise<IncomingMessage>((resolve, reject) => {
      get(
        `${strict.base}/api/v1/stations/${stationA}/events`,
        { headers: { cookie: `ondes_session=${cookies.owner}` } },
        resolve,
      ).on('error', reject);
    });
    stalled.pause();
    expect(stalled.statusCode).toBe(200);
    await waitFor(
      () => strict.app.sse.clients === 1,
      () => 'stream not open',
    );

    const filler = [['x-filler', 'y'.repeat(256 * 1024)]];
    for (let seq = 1; seq <= 80 && strict.app.sse.clients > 0; seq++) {
      await rabbit.events.publish({
        ...engineUp(stationA),
        type: 'engine.live.connected',
        data: { bootId: 'boot', seq, headers: filler },
      });
    }
    await waitFor(
      () => strict.app.sse.clients === 0,
      () => 'slow client still connected',
    );
    stalled.destroy();
  });
});
