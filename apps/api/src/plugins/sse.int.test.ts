import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { addMembership, createOrganization, createStation, unsafeScope } from '@ondes/db';
import { createTestDatabase } from '@ondes/db/testing';
import {
  connectQueue,
  createEventPublisher,
  createJobPublisher,
  deleteTopology,
  type QueueConnection,
  subscribeEvents,
} from '@ondes/queue';
import type { Actor, Role } from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../app.ts';
import { signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../modules/auth/testing.ts';
import { createMemoryMailer } from './mail.ts';
import type { Rabbit } from './rabbit.ts';

// The SSE stream end to end: events published on the RabbitMQ fanout reach the browsers of
// their station that hold the event's read permission, and nobody else.

const url = process.env.RABBITMQ_URL ?? 'amqp://ondes:ondes@127.0.0.1:5672/ondes';
const system: Actor = { type: 'system', name: 'test' };

let t: TestApp;
let queue: QueueConnection;
let rabbit: Rabbit;
let base: string;
let stationA: string;
let stationB: string;
const cookies = {} as Record<'owner' | 'programmer' | 'viewer' | 'outsider', string>;

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

beforeAll(async () => {
  const tdb = await createTestDatabase();
  const mailer = createMemoryMailer();
  rabbit = await testRabbit();
  const app = await buildApp({
    db: { client: tdb },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    rabbit: { rabbit },
    sse: { heartbeatMs: 50, clockMs: 60_000 },
    fastify: { logger: false },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  await app.sse.ready;
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  t = {
    app,
    tdb,
    outbox: mailer.outbox,
    close: async () => {
      await app.close();
      await rabbit.close();
      await tdb.drop();
    },
  };

  const org = await createOrganization(tdb.db, system, { slug: 'sse', name: 'SSE' });
  const ctx = { actor: system, scope: unsafeScope(org.id) };
  const station = (slug: string) =>
    createStation(tdb.db, ctx, { slug, name: slug, timezone: 'Europe/Paris' });
  stationA = (await station('sse-a')).id;
  stationB = (await station('sse-b')).id;
  const member = async (key: keyof typeof cookies, role: Role, stationId: string | null) => {
    const { userId, cookie } = await signUpAndLogin(t, `${key}@sse.test`);
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
});
afterAll(() => t?.close());

type Frame = { id?: string; data?: unknown; comment?: boolean };

/** Opens a stream and parses its frames as they arrive. */
async function open(stationId: string, cookie?: string, lastEventId?: string) {
  const controller = new AbortController();
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = `ondes_session=${cookie}`;
  if (lastEventId) headers['last-event-id'] = lastEventId;
  const res = await fetch(`${base}/api/v1/stations/${stationId}/events`, {
    headers,
    signal: controller.signal,
  });
  const frames: Frame[] = [];
  const waiters = new Set<() => void>();
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
          for (const wake of waiters) wake();
        }
      } catch {
        // aborted
      }
    })();
  }
  const types = () =>
    frames.flatMap((f) => (f.data ? [(f.data as { type: string }).type] : [])) as string[];
  return {
    res,
    frames,
    types,
    /** Resolves once a frame matches (or fails after 5 s). */
    async until(match: (frame: Frame) => boolean): Promise<Frame> {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const found = frames.find(match);
        if (found) return found;
        if (Date.now() > deadline)
          throw new Error(`no matching frame in ${JSON.stringify(frames)}`);
        await new Promise<void>((resolve) => {
          const wake = () => {
            waiters.delete(wake);
            resolve();
          };
          waiters.add(wake);
          setTimeout(wake, 100);
        });
      }
    },
    close: () => controller.abort(),
  };
}

const event = (stationId: string, type: string, data: unknown = {}) => ({
  id: randomUUID(),
  stationId,
  at: new Date().toISOString(),
  type,
  data,
});
const withId = (id: string) => (f: Frame) => f.id === id;

describe('GET /api/v1/stations/:stationId/events', () => {
  it('needs a session and a membership that reaches the station', async () => {
    expect((await open(stationA)).res.status).toBe(401);
    const outside = await open(stationA, cookies.outsider);
    expect(outside.res.status).toBe(404);
  });

  it('starts with the server clock and keeps the stream alive with heartbeats', async () => {
    const s = await open(stationA, cookies.viewer);
    expect(s.res.headers.get('content-type')).toContain('text/event-stream');
    const clock = await s.until((f) => (f.data as { type?: string })?.type === 'server.clock');
    expect(clock.id).toBeUndefined();
    await s.until((f) => f.comment === true);
    s.close();
  });

  it("forwards only the station's events the caller may read", async () => {
    const owner = await open(stationA, cookies.owner);
    const programmer = await open(stationA, cookies.programmer);
    const viewer = await open(stationA, cookies.viewer);
    const other = await open(stationB, cookies.outsider);
    for (const s of [owner, programmer, viewer, other]) {
      await s.until((f) => (f.data as { type?: string })?.type === 'server.clock');
    }

    const engineB = event(stationB, 'engine.up', { bootId: 'b', version: '2.4.2' });
    const alertA = event(stationA, 'alert.raised', { level: 'warning' });
    const secretA = event(stationA, 'secret.leaked');
    const engineA = event(stationA, 'engine.up', { bootId: 'a', version: '2.4.2' });
    for (const e of [engineB, alertA, secretA, engineA]) await rabbit.events.publish(e);
    // A malformed event is dropped without breaking the stream.
    await rabbit.events.publish({ type: 'engine.up' });
    const last = event(stationA, 'engine.down', { bootId: 'a', reason: 'timeout' });
    await rabbit.events.publish(last);

    // Fanout order is kept, so once `last` arrived everything before it was handled.
    for (const s of [owner, programmer, viewer]) await s.until(withId(last.id));
    await other.until(withId(engineB.id));

    const ids = (s: typeof owner) => s.frames.flatMap((f) => (f.id ? [f.id] : []));
    expect(ids(owner)).toEqual([alertA.id, engineA.id, last.id]);
    expect(ids(programmer)).toEqual([alertA.id, engineA.id, last.id]);
    // Viewers have engine:read but not alert:read.
    expect(ids(viewer)).toEqual([engineA.id, last.id]);
    expect(ids(other)).toEqual([engineB.id]);
    expect(viewer.frames.find(withId(engineA.id))?.data).toEqual(engineA);

    for (const s of [owner, programmer, viewer, other]) s.close();
  });

  it('replays what the client missed after Last-Event-ID', async () => {
    const live = await open(stationA, cookies.programmer);
    await live.until((f) => (f.data as { type?: string })?.type === 'server.clock');
    const events = [1, 2, 3].map((n) =>
      event(stationA, 'engine.up', { bootId: `${n}`, version: 'x' }),
    );
    for (const e of events) await rabbit.events.publish(e);
    await live.until(withId(events[2]?.id ?? ''));
    live.close();

    const resumed = await open(stationA, cookies.programmer, events[0]?.id);
    await resumed.until(withId(events[2]?.id ?? ''));
    expect(resumed.frames.flatMap((f) => (f.id ? [f.id] : []))).toEqual([
      events[1]?.id,
      events[2]?.id,
    ]);
    resumed.close();
  });
});
