import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { connectQueue, type QueueConnection } from './connection.ts';
import {
  consumeEventsDurable,
  createEventPublisher,
  deleteEventQueue,
  EventDroppedError,
  type EventPublisher,
} from './events.ts';
import { deleteTopology } from './topology.ts';

// consumeEventsDurable against RabbitMQ: competing consumers on one durable queue, one active
// at a time, order per key, events kept while nobody consumes, retries.

const url = process.env.RABBITMQ_URL ?? 'amqp://ondes:ondes@127.0.0.1:5672/ondes';
const eventSchema = z.object({ key: z.string(), n: z.int() });
type Event = z.infer<typeof eventSchema>;

let queue: QueueConnection;
let publisher: EventPublisher<Event>;
const name = 'durable-test';

beforeAll(async () => {
  queue = await connectQueue(url, { prefix: `test-${randomUUID().slice(0, 8)}` });
  publisher = createEventPublisher(queue.rabbit, queue.topology, eventSchema);
});

afterAll(async () => {
  await publisher.close();
  await deleteEventQueue(queue.rabbit, queue.topology, name);
  await deleteTopology(queue.rabbit, queue.topology);
  await queue.close();
});

const consume = (
  onEvent: (e: Event) => Promise<void>,
  options: { retryDelaysMs?: readonly number[]; onError?: (error: unknown) => void } = {},
) =>
  consumeEventsDurable(queue.rabbit, queue.topology, name, eventSchema, onEvent, {
    keyOf: (e) => e.key,
    retryDelaysMs: [20, 20],
    ...options,
  });

async function until(check: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('consumeEventsDurable', () => {
  it('one active consumer, in order per key, keeps events while nobody consumes, retries', async () => {
    const seen: Array<{ consumer: string; event: Event }> = [];
    const handler = (consumer: string) => async (event: Event) => {
      // Slow handling for key "a" must not reorder it, and must not hold up key "b".
      if (event.key === 'a') await new Promise((r) => setTimeout(r, 30 - event.n * 5));
      seen.push({ consumer, event });
    };
    const first = consume(handler('first'));
    const second = consume(handler('second'));
    await Promise.all([first.ready, second.ready]);

    for (let n = 0; n < 5; n++) {
      await publisher.publish({ key: 'a', n });
      await publisher.publish({ key: 'b', n });
    }
    await until(() => seen.length === 10);
    // Single active consumer: everything went to one of them.
    expect(new Set(seen.map((s) => s.consumer)).size).toBe(1);
    for (const key of ['a', 'b']) {
      expect(seen.filter((s) => s.event.key === key).map((s) => s.event.n)).toEqual([
        0, 1, 2, 3, 4,
      ]);
    }

    // Nobody consuming: the queue keeps them for the next consumer.
    await first.close();
    await second.close();
    await publisher.publish({ key: 'a', n: 10 });
    let failures = 0;
    const late: Event[] = [];
    const third = consume(async (event) => {
      if (failures++ < 2) throw new Error('flaky');
      late.push(event);
    });
    await third.ready;
    await until(() => late.length === 1);
    expect(late).toEqual([{ key: 'a', n: 10 }]);
    expect(failures).toBe(3);
    await third.close();
  });

  it('a failing event blocks its key, not the others, until it succeeds', async () => {
    const seen: string[] = [];
    let failures = 0;
    const sub = consume(
      async (event) => {
        if (event.key === 'x' && event.n === 1 && failures < 3) {
          failures++;
          throw new Error('flaky');
        }
        seen.push(`${event.key}${event.n}`);
      },
      { retryDelaysMs: [150, 150, 150, 150] },
    );
    await sub.ready;
    await publisher.publish({ key: 'x', n: 1 });
    await publisher.publish({ key: 'x', n: 2 });
    await publisher.publish({ key: 'y', n: 1 });
    // y1 doesn't wait for x1's retries.
    await until(() => seen.includes('y1'));
    expect(seen).toEqual(['y1']);
    await until(() => seen.length === 3);
    expect(failures).toBe(3);
    // x2 only ran after x1 succeeded.
    expect(seen).toEqual(['y1', 'x1', 'x2']);
    await sub.close();
  });

  it('gives a failing event up after its retries, then moves its key on', async () => {
    const seen: string[] = [];
    const errors: unknown[] = [];
    const sub = consume(
      async (event) => {
        if (event.n === 1) throw new Error('poison');
        seen.push(`${event.key}${event.n}`);
      },
      { retryDelaysMs: [20, 20], onError: (error) => errors.push(error) },
    );
    await sub.ready;
    await publisher.publish({ key: 'z', n: 1 });
    await publisher.publish({ key: 'z', n: 2 });
    await until(() => seen.length === 1);
    expect(seen).toEqual(['z2']);
    const dropped = errors.filter((e) => e instanceof EventDroppedError);
    expect(dropped).toHaveLength(1);
    expect((dropped[0] as EventDroppedError).attempts).toBe(3);
    await sub.close();
  });
});
