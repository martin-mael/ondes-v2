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
   * a time, in queue order, and a failing event blocks its key until it succeeds or is given
   * up. Events with different keys run concurrently.
   */
  keyOf: (event: E) => string;
  /** Handlers running at once across keys. Default 16. */
  concurrency?: number;
  /**
   * Deliveries held in process (handled, or waiting behind their key). A key blocked on a
   * failing event holds one per waiting event: other keys keep flowing until this many are
   * held. Default 256 (at least `concurrency`).
   */
  prefetch?: number;
  /**
   * Delays between attempts of a failing event, retried in place. Default: exponential from
   * 200 ms, doubling, capped at 30 s, until `maxAttempts` or `maxRetryMs`.
   * An explicit list gives up once it is exhausted.
   */
  retryDelaysMs?: readonly number[];
  /** Attempts before a failing event is given up. Default 20. */
  maxAttempts?: number;
  /** Time spent retrying one event before it is given up. Default 15 minutes. */
  maxRetryMs?: number;
  /** Messages older than this are dropped by the broker. Default 1 hour. */
  messageTtlMs?: number;
  /** Queue length cap (oldest dropped first). Default 100 000. */
  maxLength?: number;
  /**
   * Every failed attempt, and an `EventDroppedError` when an event is given up. `event` is
   * undefined for messages that don't match the schema (acked and skipped).
   */
  onError?: (error: unknown, event: E | undefined) => void;
};

/** A durable event that kept failing was given up (acked without being handled). */
export class EventDroppedError extends Error {
  readonly attempts: number;
  constructor(attempts: number, cause: unknown) {
    super(`Event dropped after ${attempts} failed attempts`, { cause });
    this.name = 'EventDroppedError';
    this.attempts = attempts;
  }
}

/** The consumer is closing: the delivery goes back to the queue, unhandled. */
class ConsumerClosingError extends Error {
  constructor() {
    super('Durable event consumer is closing');
    this.name = 'ConsumerClosingError';
  }
}

const backoffDelay = (attempt: number) => Math.min(200 * 2 ** attempt, 30_000);

/**
 * A durable, named, competing-consumer queue on the events fanout, for side effects that must
 * not be lost or run twice (alerts, actions, emails); the fanout subscriptions above are for
 * the UI. Every process consuming the same `name` shares one quorum queue with a single
 * active consumer: one process at a time gets the events, in publish order, and another takes
 * over if it goes away. Events published while no consumer runs wait in the queue (up to
 * `messageTtlMs`).
 *
 * Order per key holds through failures: a failing event is retried in place (backoff, see
 * `retryDelaysMs`) while the later events of its key wait behind it, so nothing of that key
 * runs before it or overtakes it. Deliveries are acked once handled. An event that still
 * fails after `maxAttempts` / `maxRetryMs` is given up: acked, reported to `onError` as an
 * `EventDroppedError`, and its key moves on. Closing the consumer stops the retries and
 * requeues what wasn't handled. Handlers must be idempotent (deduplicate on the event id): a
 * crash redelivers.
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
  const prefetch = Math.max(options.prefetch ?? 256, concurrency);
  const delays = options.retryDelaysMs;
  const maxAttempts = delays ? delays.length + 1 : (options.maxAttempts ?? 20);
  const maxRetryMs = options.maxRetryMs ?? 15 * 60 * 1000;
  const onError = options.onError ?? (() => {});
  const queue = topology.eventQueue(name);
  /** Tail of each key's chain of handlers. */
  const chains = new Map<string, Promise<void>>();
  let closing = false;
  /** Wakes the retry sleeps when the consumer closes. */
  const sleepers = new Set<() => void>();

  // At most `concurrency` handlers run; deliveries waiting behind their key don't count.
  let running = 0;
  const slots: Array<() => void> = [];
  async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (running >= concurrency) await new Promise<void>((resolve) => slots.push(resolve));
    running++;
    try {
      return await fn();
    } finally {
      running--;
      slots.shift()?.();
    }
  }

  function sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      sleepers.add(wake);
    });
  }

  /** Resolves once handled or given up; throws only when closing (the delivery is requeued). */
  async function handleInPlace(event: z.output<S>) {
    const firstAt = Date.now();
    for (let attempt = 0; ; attempt++) {
      if (closing) throw new ConsumerClosingError();
      try {
        await withSlot(() => onEvent(event));
        return;
      } catch (error) {
        onError(error, event);
        const delay = delays ? delays[attempt] : backoffDelay(attempt);
        if (
          delay === undefined ||
          attempt + 1 >= maxAttempts ||
          Date.now() - firstAt + delay > maxRetryMs
        ) {
          onError(new EventDroppedError(attempt + 1, error), event);
          return;
        }
        await sleep(delay);
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
      qos: { prefetchCount: prefetch },
      concurrency: prefetch,
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
      // A previous event that failed while closing was requeued: this one must not run ahead
      // of it, so it is requeued too.
      const run = previous.then(() => handleInPlace(event));
      const tail = run.catch(() => {
        throw new ConsumerClosingError();
      });
      tail.catch(() => {});
      chains.set(key, tail);
      try {
        await run;
      } finally {
        if (chains.get(key) === tail) chains.delete(key);
      }
    },
  );
  consumer.on('error', (error: unknown) => {
    if (!(error instanceof ConsumerClosingError)) onError(error, undefined);
  });
  const ready = new Promise<void>((resolve) => consumer.once('ready', () => resolve()));
  return {
    ready,
    async close() {
      closing = true;
      for (const wake of [...sleepers]) wake();
      await consumer.close();
    },
  };
}

/** Deletes a durable event queue (`consumeEventsDurable`). For tests only. */
export async function deleteEventQueue(
  rabbit: Connection,
  topology: Topology,
  name: string,
): Promise<void> {
  await rabbit.queueDelete({ queue: topology.eventQueue(name) });
}
