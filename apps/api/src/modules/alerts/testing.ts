// Helpers for the alerts integration tests. Not for production code.
import { randomUUID } from 'node:crypto';
import {
  connectQueue,
  createEventPublisher,
  createJobPublisher,
  deleteTopology,
  type EventSubscription,
  subscribeEvents,
} from '@ondes/queue';
import type { EngineRealtimeEvent } from '@ondes/shared';
import { z } from 'zod';
import type { Rabbit } from '../../plugins/rabbit.ts';

export const rabbitUrl = process.env.RABBITMQ_URL ?? 'amqp://ondes:ondes@127.0.0.1:5672/ondes';

/**
 * `app.rabbit` on a random queue prefix, so a test file has its own events exchange on the
 * shared RabbitMQ. `close()` also deletes the topology.
 */
export async function createTestRabbit(): Promise<Rabbit> {
  const queue = await connectQueue(rabbitUrl, { prefix: `test-${randomUUID().slice(0, 8)}` });
  const jobs = createJobPublisher(queue.rabbit, queue.topology);
  const events = createEventPublisher(queue.rabbit, queue.topology, z.unknown());
  const subscriptions = new Set<EventSubscription>();
  return {
    queue,
    jobs,
    events,
    subscribeEvents(onEvent) {
      const sub = subscribeEvents(queue.rabbit, queue.topology, z.unknown(), onEvent);
      subscriptions.add(sub);
      return sub;
    },
    async close() {
      await Promise.all([...subscriptions].map((sub) => sub.close()));
      await Promise.all([jobs.close(), events.close()]);
      await deleteTopology(queue.rabbit, queue.topology).catch(() => {});
      await queue.close();
    },
  };
}

/** An engine-origin event as the adapter's ingest publishes it (#28). */
export function engineEvent<T extends EngineRealtimeEvent['type']>(
  stationId: string,
  type: T,
  data: Extract<EngineRealtimeEvent, { type: T }>['data'],
): Extract<EngineRealtimeEvent, { type: T }> {
  return { id: randomUUID(), stationId, at: new Date().toISOString(), type, data } as Extract<
    EngineRealtimeEvent,
    { type: T }
  >;
}

export async function waitFor<T>(
  what: string,
  find: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
