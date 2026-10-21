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

// --- Durable event consumers -----------------------------------------------------------

export type DurableEventConsumerOptions<E> = {
  /**
   * Orders delivery per key (e.g. the station): events with the same key are handled one at
   * a time, in queue order. Events with different keys run concurrently.
   */
  keyOf: (event: E) => string;
  /** Events handled at once across keys. Default 16. */
  concurrency?: number;
  /** In-process retries of a failed handler, in order, before the delivery is requeued. */
  retryDelaysMs?: readonly number[];
  /** Messages older than this are dropped by the broker. Default 1 hour. */
  messageTtlMs?: number;
  /** Queue length cap (oldest dropped first). Default 100 000. */
  maxLength?: number;
  onError?: (error: unknown, event: E | undefined) => void;
};

/**
 * A durable, named, competing-consumer queue on the events fanout, for side effects that must
 * not be lost or run twice (alerts, actions, emails); the fanout subscriptions above are for
 * the UI. Every process consuming the same `name` shares one quorum queue with a single
 * active consumer: one process at a time gets the events, in publish order, and another takes
 * over if it goes away. Events published while no consumer runs wait in the queue (up to
 * `messageTtlMs`). Deliveries are acked once handled; a handler that still fails after its
 * retries is requeued (the quorum delivery limit drops a poison message eventually).
 * Handlers must be idempotent (deduplicate on the event id): a crash redelivers.
 */
export function consumeEventsDurable<S extends z.ZodType>(
  rabbit: Connection,
  topology: Topology,
  name: string,
  schema: S,
  onEvent: (event: z.output<S>) => Promise<void>,
  options: DurableEventConsumerOptions<z.output<S>>,
): EventSubscription {
  const concurrency = options.concurrency ?? 16;
  const retries = options.retryDelaysMs ?? [200, 1000, 5000];
  const onError = options.onError ?? (() => {});
  const queue = topology.eventQueue(name);
  /** Tail of each key's chain of handlers. */
  const chains = new Map<string, Promise<void>>();

  async function handleWithRetries(event: z.output<S>) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await onEvent(event);
      } catch (error) {
        onError(error, event);
        const delay = retries[attempt];
        if (delay === undefined) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  const consumer: Consumer = rabbit.createConsumer(
    {
      queue,
      queueOptions: {
        durable: true,
        arguments: {
          'x-queue-type': 'quorum',
          'x-single-active-consumer': true,
          'x-message-ttl': options.messageTtlMs ?? 3_600_000,
          'x-max-length': options.maxLength ?? 100_000,
          'x-overflow': 'drop-head',
        },
      },
      queueBindings: [{ queue, exchange: topology.eventsExchange, routingKey: '' }],
      exchanges: [{ exchange: topology.eventsExchange, type: 'fanout', durable: true }],
      qos: { prefetchCount: concurrency },
      concurrency,
      requeue: true,
    },
    async (msg) => {
      const parsed = schema.safeParse(msg.body);
      if (!parsed.success) {
        // Not ours to handle (an event type this consumer doesn't know): ack and move on.
        onError(new Error(`Invalid event: ${z.prettifyError(parsed.error)}`), undefined);
        return;
      }
      const event = parsed.data;
      const key = options.keyOf(event);
      const previous = chains.get(key) ?? Promise.resolve();
      const run = previous.catch(() => {}).then(() => handleWithRetries(event));
      const tail = run.catch(() => {});
      chains.set(key, tail);
      try {
        await run;
      } finally {
        if (chains.get(key) === tail) chains.delete(key);
      }
    },
  );
  consumer.on('error', (error: unknown) => onError(error, undefined));
  const ready = new Promise<void>((resolve) => consumer.once('ready', () => resolve()));
  return { ready, close: () => consumer.close() };
}

/** Deletes a durable event queue (`consumeEventsDurable`). For tests only. */
export async function deleteEventQueue(
  rabbit: Connection,
  topology: Topology,
  name: string,
): Promise<void> {
  await rabbit.queueDelete({ queue: topology.eventQueue(name) });
}
