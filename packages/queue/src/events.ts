import type { Connection, Consumer } from 'rabbitmq-client';
import { z } from 'zod';
import type { Topology } from './topology.ts';

/**
 * Real-time event fanout: every subscriber gets its own exclusive, auto-deleted queue bound
 * to the events exchange, so each api instance (and its SSE clients) sees every event.
 * Events are transient by design: a subscriber that is down misses them, and clients
 * resync over HTTP. Event names and payloads are defined in
 * `packages/shared/src/contracts/events.ts` and passed in as `schema`.
 */
export type EventPublisher<E> = {
  publish(event: E): Promise<void>;
  close(): Promise<void>;
};

export function createEventPublisher<S extends z.ZodType>(
  rabbit: Connection,
  topology: Topology,
  schema: S,
): EventPublisher<z.input<S>> {
  const publisher = rabbit.createPublisher({ confirm: true, maxAttempts: 2 });
  return {
    async publish(event) {
      await publisher.send(
        { exchange: topology.eventsExchange, routingKey: '' },
        schema.parse(event) as object,
      );
    },
    close: () => publisher.close(),
  };
}

export type EventSubscription = {
  /** Resolves once the subscriber's queue is bound and consuming. */
  ready: Promise<void>;
  close(): Promise<void>;
};

export function subscribeEvents<S extends z.ZodType>(
  rabbit: Connection,
  topology: Topology,
  schema: S,
  onEvent: (event: z.output<S>) => void | Promise<void>,
  onError: (error: unknown) => void = () => {},
): EventSubscription {
  const consumer: Consumer = rabbit.createConsumer(
    {
      queue: '',
      queueOptions: { exclusive: true, autoDelete: true, durable: false },
      exchanges: [{ exchange: topology.eventsExchange, type: 'fanout', durable: true }],
      // Without a queue name, the binding applies to the queue just declared on this channel.
      queueBindings: [{ exchange: topology.eventsExchange, routingKey: '' }],
      noAck: true,
    },
    async (msg) => {
      const parsed = schema.safeParse(msg.body);
      if (!parsed.success) {
        onError(new Error(`Invalid event: ${z.prettifyError(parsed.error)}`));
        return;
      }
      await onEvent(parsed.data);
    },
  );
  consumer.on('error', onError);
  const ready = new Promise<void>((resolve) => consumer.once('ready', () => resolve()));
  return { ready, close: () => consumer.close() };
}
