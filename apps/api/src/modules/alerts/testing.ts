// Helpers for the alerts integration tests. Not for production code.
import { randomUUID } from 'node:crypto';
import {
  connectQueue,
  createEventPublisher,
  createJobPublisher,
  deleteEventQueue,
  deleteTopology,
  type EventSubscription,
  subscribeEvents,
} from '@ondes/queue';
import type { EngineRealtimeEvent } from '@ondes/shared';
import { z } from 'zod';
import type { Rabbit } from '../../plugins/rabbit.ts';
import { ALERTS_EVENT_QUEUE } from './plugin.ts';

export const rabbitUrl = process.env.RABBITMQ_URL ?? 'amqp://ondes:ondes@127.0.0.1:5672/ondes';

export const testPrefix = () => `test-${randomUUID().slice(0, 8)}`;

/**
 * `app.rabbit` on a queue prefix (random by default), so a test file has its own exchanges
 * and queues on the shared RabbitMQ. Two of them on the same prefix are two api replicas.
 * `close({ cleanup: true })` also deletes the topology and the alerts queue.
 */
export async function createTestRabbit(
  prefix = testPrefix(),
): Promise<Rabbit & { close(options?: { cleanup?: boolean }): Promise<void> }> {
  const queue = await connectQueue(rabbitUrl, { prefix });
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
    async close({ cleanup = true } = {}) {
      await Promise.all([...subscriptions].map((sub) => sub.close()));
      await Promise.all([jobs.close(), events.close()]);
      if (cleanup) {
        await deleteEventQueue(queue.rabbit, queue.topology, ALERTS_EVENT_QUEUE).catch(() => {});
        await deleteTopology(queue.rabbit, queue.topology).catch(() => {});
      }
      await queue.close();
    },
  };
}

/** An engine-origin event as the adapter's ingest publishes it (#28). */
export function engineEvent<T extends EngineRealtimeEvent['type']>(
  stationId: string,
  type: T,
  data: Extract<EngineRealtimeEvent, { type: T }>['data'],
  at = new Date(),
): Extract<EngineRealtimeEvent, { type: T }> {
  return { id: randomUUID(), stationId, at: at.toISOString(), type, data } as Extract<
    EngineRealtimeEvent,
    { type: T }
  >;
}

export async function waitFor<T>(
  what: string,
  find: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
