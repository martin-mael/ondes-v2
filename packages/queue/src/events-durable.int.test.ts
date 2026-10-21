import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { connectQueue, type QueueConnection } from './connection.ts';
import {
  consumeEventsDurable,
  createEventPublisher,
  deleteEventQueue,
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

const consume = (onEvent: (e: Event) => Promise<void>) =>
  consumeEventsDurable(queue.rabbit, queue.topology, name, eventSchema, onEvent, {
    keyOf: (e) => e.key,
    retryDelaysMs: [20, 20],
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
});
