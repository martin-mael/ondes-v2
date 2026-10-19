import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { connectQueue, type QueueConnection } from './connection.ts';
import { createEventPublisher, subscribeEvents } from './events.ts';
import { defineJob, NonRetryableError } from './job.ts';
import { createJobPublisher, type JobPublisher } from './publisher.ts';
import { InMemoryJobRunStore } from './store.ts';
import { deleteTopology } from './topology.ts';
import { createJobWorker, type JobWorker, type Logger } from './worker.ts';

const url = process.env.RABBITMQ_URL ?? 'amqp://ondes:ondes@127.0.0.1:5672/ondes';
const [TIER1, TIER2] = [300, 900];
const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

let queue: QueueConnection;
let publisher: JobPublisher;
const workers: JobWorker[] = [];

beforeAll(async () => {
  // A random prefix isolates this run's exchanges and queues from dev data and other runs.
  queue = await connectQueue(url, {
    prefix: `test-${randomUUID().slice(0, 8)}`,
    retryTiersMs: [TIER1, TIER2],
    maxAttempts: 3,
  });
  publisher = createJobPublisher(queue.rabbit, queue.topology);
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.close()));
});

afterAll(async () => {
  await publisher.close();
  await deleteTopology(queue.rabbit, queue.topology);
  await queue.close();
});

async function startWorker(jobs: Parameters<typeof createJobWorker>[0]['jobs']) {
  const store = new InMemoryJobRunStore();
  const worker = createJobWorker({
    rabbit: queue.rabbit,
    topology: queue.topology,
    store,
    jobs,
    logger: silent,
  });
  workers.push(worker);
  await worker.ready;
  return store;
}

async function waitFor<T>(check: () => Promise<T | undefined> | T | undefined, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Takes one message from the dead-letter queue. */
async function takeDead() {
  return waitFor(
    async () =>
      (await queue.rabbit.basicGet({ queue: queue.topology.deadQueue, noAck: true })) ?? undefined,
  );
}

describe('job framework (RabbitMQ)', () => {
  it('retries a failing job through each tier, then dead-letters it after N attempts', async () => {
    const attempts: { attempt: number; at: number }[] = [];
    const poison = defineJob('poison', z.object({ n: z.int() }), (_payload, ctx) => {
      attempts.push({ attempt: ctx.attempt, at: Date.now() });
      throw new Error('always fails');
    });
    const store = await startWorker([poison]);

    const sent = await publisher.enqueue(poison, { n: 1 });

    const dead = await takeDead();
    expect(dead.body).toMatchObject({ id: sent.id, name: 'poison', attempt: 3 });
    expect(dead.headers).toMatchObject({ 'x-ondes-reason': 'max-attempts' });
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);

    // Each retry waited at least its tier, and less than the next one.
    const [a1, a2, a3] = attempts.map((a) => a.at) as [number, number, number];
    expect(a2 - a1).toBeGreaterThanOrEqual(TIER1 - 20);
    expect(a2 - a1).toBeLessThan(TIER2);
    expect(a3 - a2).toBeGreaterThanOrEqual(TIER2 - 20);

    // It shows up in the admin job list as dead.
    const [run] = await store.list({ status: 'dead' });
    expect(run).toMatchObject({ id: sent.id, attempt: 3, lane: 'bulk' });
    expect(run?.lastError).toContain('always fails');
  });

  it('succeeds on a retry', async () => {
    let calls = 0;
    const flaky = defineJob('flaky', z.object({}), () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
    });
    const store = await startWorker([flaky]);

    const sent = await publisher.enqueue(flaky, {});
    const run = await waitFor(async () => {
      const r = await store.get(sent.id);
      return r?.status === 'succeeded' ? r : undefined;
    });
    expect(run.attempt).toBe(2);
    expect(calls).toBe(2);
  });

  it('drops duplicates by idempotency key', async () => {
    const seen: string[] = [];
    const ingest = defineJob(
      'ingest',
      z.object({ trackId: z.string(), version: z.int() }),
      async (p) => {
        seen.push(`${p.trackId}:${p.version}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
      { idempotencyKey: (p) => `track:${p.trackId}:${p.version}` },
    );
    const store = await startWorker([ingest]);

    // Same key while the first is in flight, and again after it succeeded.
    await publisher.enqueue(ingest, { trackId: 't1', version: 1 });
    await publisher.enqueue(ingest, { trackId: 't1', version: 1 });
    await waitFor(async () => (await store.list({ status: 'succeeded' })).length === 1);
    const last = await publisher.enqueue(ingest, { trackId: 't1', version: 1 });
    // A new version is new work.
    const v2 = await publisher.enqueue(ingest, { trackId: 't1', version: 2 });

    await waitFor(async () => (await store.get(v2.id))?.status === 'succeeded');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen).toEqual(['t1:1', 't1:2']);
    expect(await store.get(last.id)).toBeUndefined();
  });

  it('dead-letters invalid payloads and non-retryable errors without retrying', async () => {
    let calls = 0;
    const strict = defineJob('strict', z.object({ ok: z.boolean() }), ({ ok }) => {
      calls += 1;
      if (!ok) throw new NonRetryableError('bad input');
    });
    const store = await startWorker([strict]);

    // Bypass the publisher's validation to simulate a malformed message.
    await publisher.enqueue(
      { name: 'strict', lane: 'bulk', schema: z.unknown(), idempotencyKey: undefined },
      { ok: 'yes' },
    );
    expect((await takeDead()).headers).toMatchObject({ 'x-ondes-reason': 'invalid-payload' });

    await publisher.enqueue(strict, { ok: false });
    expect((await takeDead()).headers).toMatchObject({ 'x-ondes-reason': 'non-retryable' });

    expect(calls).toBe(1);
    expect((await store.list({ status: 'dead' })).map((r) => r.attempt)).toEqual([1, 1]);
  });

  it('routes jobs to separate high and bulk queues', async () => {
    const urgent = defineJob('urgent', z.object({}), () => {}, { lane: 'high' });
    const slow = defineJob('slow', z.object({}), () => {}, { lane: 'bulk' });

    await publisher.enqueue(urgent, {});
    await publisher.enqueue(slow, {});
    const high = await queue.rabbit.basicGet({
      queue: queue.topology.laneQueue('high'),
      noAck: true,
    });
    const bulk = await queue.rabbit.basicGet({
      queue: queue.topology.laneQueue('bulk'),
      noAck: true,
    });
    expect(high?.body).toMatchObject({ name: 'urgent' });
    expect(bulk?.body).toMatchObject({ name: 'slow' });
  });

  it('fans real-time events out to every subscriber', async () => {
    const schema = z.object({ type: z.literal('now-playing'), title: z.string() });
    const received: [string, string][] = [];
    const subs = ['a', 'b'].map((name) =>
      subscribeEvents(queue.rabbit, queue.topology, schema, (event) => {
        received.push([name, event.title]);
      }),
    );
    await Promise.all(subs.map((s) => s.ready));

    const events = createEventPublisher(queue.rabbit, queue.topology, schema);
    await events.publish({ type: 'now-playing', title: 'Song' });
    await waitFor(() => received.length === 2);
    expect(received.sort()).toEqual([
      ['a', 'Song'],
      ['b', 'Song'],
    ]);

    await events.close();
    await Promise.all(subs.map((s) => s.close()));
  });
});
