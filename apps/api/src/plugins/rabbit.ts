import {
  connectQueue,
  createEventPublisher,
  createJobPublisher,
  type EventPublisher,
  type EventSubscription,
  type JobPublisher,
  type QueueConnection,
  subscribeEvents,
} from '@ondes/queue';
import { z } from 'zod';

/**
 * RabbitMQ access for the api (#8): enqueue jobs, publish real-time events, and subscribe to
 * the event fanout (the SSE plugin's source). Framework-agnostic for now: once the Fastify
 * server lands, it registers this as a plugin (`app.decorate('rabbit', ...)`, closed in
 * `onClose`).
 */
export type Rabbit = {
  queue: QueueConnection;
  jobs: JobPublisher;
  /** Untyped until `contracts/events.ts` exists; the SSE plugin will narrow it. */
  events: EventPublisher<unknown>;
  subscribeEvents(onEvent: (event: unknown) => void | Promise<void>): EventSubscription;
  close(): Promise<void>;
};

export async function createRabbit(url: string): Promise<Rabbit> {
  const queue = await connectQueue(url, { connectionName: 'ondes-api' });
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
      return {
        ready: sub.ready,
        close: async () => {
          subscriptions.delete(sub);
          await sub.close();
        },
      };
    },
    async close() {
      await Promise.all([...subscriptions].map((sub) => sub.close()));
      await Promise.all([jobs.close(), events.close()]);
      await queue.close();
    },
  };
}
