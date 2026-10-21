import type { JobLane } from '@ondes/shared';
import type { Connection } from 'rabbitmq-client';

export const JOB_LANES = ['high', 'bulk', 'notify'] as const satisfies readonly JobLane[];

/** Default retry tiers: wait 10 s, then 1 min, then 10 min, then dead-letter. */
export const DEFAULT_RETRY_TIERS_MS = [10_000, 60_000, 600_000] as const;

export type TopologyOptions = {
  /** Prefix for every exchange and queue name. Tests use a random one to stay isolated. */
  prefix?: string;
  /**
   * Delay before each retry, in order. Attempt n (1-based) that fails waits
   * `retryTiersMs[n - 1]` (the last tier repeats if `maxAttempts` exceeds the tier count).
   */
  retryTiersMs?: readonly number[];
  /** Total attempts, first delivery included, before a job goes to the DLQ. */
  maxAttempts?: number;
  /**
   * Broker-side safety net for messages that are never acked or rejected (worker crash
   * loops): quorum queues dead-letter them after this many redeliveries.
   */
  deliveryLimit?: number;
};

export type Topology = {
  prefix: string;
  retryTiersMs: readonly number[];
  maxAttempts: number;
  deliveryLimit: number;
  /** Direct exchange; routing key = lane. */
  jobsExchange: string;
  /** Direct exchange; routing key = `<lane>.<delayMs>`. */
  retryExchange: string;
  /** Fanout exchange in front of the dead-letter queue. */
  deadExchange: string;
  deadQueue: string;
  /** Fanout exchange for real-time events (consumed by the api's SSE plugin). */
  eventsExchange: string;
  /** Durable, named queue bound to the events exchange (`consumeEventsDurable`). */
  eventQueue: (name: string) => string;
  laneQueue: (lane: JobLane) => string;
  retryQueue: (lane: JobLane, delayMs: number) => string;
  retryRoutingKey: (lane: JobLane, delayMs: number) => string;
  /** Delay before the retry that follows the failed attempt `attempt` (1-based). */
  retryDelayFor: (attempt: number) => number;
};

export function createTopology(options: TopologyOptions = {}): Topology {
  const prefix = options.prefix ?? 'ondes';
  const retryTiersMs = options.retryTiersMs ?? DEFAULT_RETRY_TIERS_MS;
  if (retryTiersMs.length === 0 || retryTiersMs.some((ms) => !Number.isInteger(ms) || ms <= 0)) {
    throw new Error('retryTiersMs must be a non-empty list of positive integers');
  }
  const maxAttempts = options.maxAttempts ?? retryTiersMs.length + 1;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }
  return {
    prefix,
    retryTiersMs,
    maxAttempts,
    deliveryLimit: options.deliveryLimit ?? 5,
    jobsExchange: `${prefix}.jobs`,
    retryExchange: `${prefix}.jobs.retry`,
    deadExchange: `${prefix}.jobs.dead`,
    deadQueue: `${prefix}.jobs.dead`,
    eventsExchange: `${prefix}.events`,
    eventQueue: (name) => `${prefix}.events.${name}`,
    laneQueue: (lane) => `${prefix}.jobs.${lane}`,
    // The delay is part of the name: a queue's TTL can't change once declared, so new
    // tiers get new queues instead of a PRECONDITION_FAILED on redeclare.
    retryQueue: (lane, delayMs) => `${prefix}.jobs.${lane}.retry.${delayMs}ms`,
    retryRoutingKey: (lane, delayMs) => `${lane}.${delayMs}`,
    retryDelayFor: (attempt) =>
      retryTiersMs[Math.min(attempt, retryTiersMs.length) - 1] ?? retryTiersMs[0] ?? 0,
  };
}

// Quorum queues dead-letter at most once by default; at-least-once needs reject-publish.
const AT_LEAST_ONCE_DLX = {
  'x-dead-letter-strategy': 'at-least-once',
  'x-overflow': 'reject-publish',
} as const;

/**
 * Declares every exchange, queue and binding (idempotent). Lane queues dead-letter to the
 * DLQ; each retry queue holds messages for its TTL, then dead-letters them back to their
 * lane. Every job queue is a durable quorum queue.
 */
export async function declareTopology(rabbit: Connection, topology: Topology): Promise<void> {
  const t = topology;
  await rabbit.exchangeDeclare({ exchange: t.jobsExchange, type: 'direct', durable: true });
  await rabbit.exchangeDeclare({ exchange: t.retryExchange, type: 'direct', durable: true });
  await rabbit.exchangeDeclare({ exchange: t.deadExchange, type: 'fanout', durable: true });
  await rabbit.exchangeDeclare({ exchange: t.eventsExchange, type: 'fanout', durable: true });

  await rabbit.queueDeclare({
    queue: t.deadQueue,
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await rabbit.queueBind({ queue: t.deadQueue, exchange: t.deadExchange, routingKey: '' });

  const delays = [...new Set(t.retryTiersMs)];
  for (const lane of JOB_LANES) {
    const queue = t.laneQueue(lane);
    await rabbit.queueDeclare({
      queue,
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-dead-letter-exchange': t.deadExchange,
        'x-delivery-limit': t.deliveryLimit,
        ...AT_LEAST_ONCE_DLX,
      },
    });
    await rabbit.queueBind({ queue, exchange: t.jobsExchange, routingKey: lane });

    for (const delayMs of delays) {
      const retryQueue = t.retryQueue(lane, delayMs);
      await rabbit.queueDeclare({
        queue: retryQueue,
        durable: true,
        arguments: {
          'x-queue-type': 'quorum',
          'x-message-ttl': delayMs,
          'x-dead-letter-exchange': t.jobsExchange,
          'x-dead-letter-routing-key': lane,
          ...AT_LEAST_ONCE_DLX,
        },
      });
      await rabbit.queueBind({
        queue: retryQueue,
        exchange: t.retryExchange,
        routingKey: t.retryRoutingKey(lane, delayMs),
      });
    }
  }
}

/** Deletes everything `declareTopology` created. For tests only. */
export async function deleteTopology(rabbit: Connection, topology: Topology): Promise<void> {
  const t = topology;
  for (const lane of JOB_LANES) {
    await rabbit.queueDelete({ queue: t.laneQueue(lane) });
    for (const delayMs of new Set(t.retryTiersMs)) {
      await rabbit.queueDelete({ queue: t.retryQueue(lane, delayMs) });
    }
  }
  await rabbit.queueDelete({ queue: t.deadQueue });
  for (const exchange of [t.jobsExchange, t.retryExchange, t.deadExchange, t.eventsExchange]) {
    await rabbit.exchangeDelete({ exchange });
  }
}
