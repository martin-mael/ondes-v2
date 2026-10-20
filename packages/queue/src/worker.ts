import { type JobEnvelope, type JobLane, jobEnvelopeSchema } from '@ondes/shared';
import type { AsyncMessage, Connection, Consumer } from 'rabbitmq-client';
import { z } from 'zod';
import { type JobDefinition, NonRetryableError } from './job.ts';
import type { JobRunStore } from './store.ts';
import type { Topology } from './topology.ts';

export type Logger = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

const jsonLogger: Logger = {
  info: (obj, msg) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
  warn: (obj, msg) => console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
  error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
};

export type JobWorkerOptions = {
  rabbit: Connection;
  topology: Topology;
  store: JobRunStore;
  // biome-ignore lint/suspicious/noExplicitAny: definitions with different payload types.
  jobs: readonly JobDefinition<any>[];
  /** Lanes to consume; defaults to the lanes of the registered jobs. */
  lanes?: readonly JobLane[];
  /** Handlers running at once, per lane. Defaults: high 4, bulk 2. */
  concurrency?: Partial<Record<JobLane, number>>;
  logger?: Logger;
  now?: () => Date;
};

export type JobWorker = {
  /** Resolves once every lane consumer is ready. */
  ready: Promise<void>;
  /** Stops consuming, aborts running handlers' signals and waits for them to settle. */
  close(): Promise<void>;
};

const DEFAULT_CONCURRENCY: Record<JobLane, number> = { high: 4, bulk: 2 };

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return z.prettifyError(error);
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

export function createJobWorker(options: JobWorkerOptions): JobWorker {
  const { rabbit, topology: t, store } = options;
  const logger = options.logger ?? jsonLogger;
  const now = options.now ?? (() => new Date());
  const registry = new Map<string, JobDefinition>();
  for (const job of options.jobs) {
    if (registry.has(job.name)) throw new Error(`Job "${job.name}" is registered twice`);
    registry.set(job.name, job);
  }
  const lanes = options.lanes ?? [...new Set(options.jobs.map((job) => job.lane))];
  const shutdown = new AbortController();
  const publisher = rabbit.createPublisher({ confirm: true, maxAttempts: 3 });

  async function sendToDead(
    body: unknown,
    lane: JobLane,
    reason: string,
    error: string,
  ): Promise<void> {
    await publisher.send(
      {
        exchange: t.deadExchange,
        routingKey: '',
        durable: true,
        headers: {
          'x-ondes-lane': lane,
          'x-ondes-reason': reason,
          // Header values must stay small; the full error is in the job-run store.
          'x-ondes-error': error.slice(0, 1000),
        },
      },
      body as object,
    );
  }

  async function dead(envelope: JobEnvelope, lane: JobLane, reason: string, error: string) {
    await sendToDead(envelope, lane, reason, error);
    await store.markDead(envelope, lane, error, now());
    logger.error(
      { jobId: envelope.id, job: envelope.name, attempt: envelope.attempt, reason },
      'job dead-lettered',
    );
  }

  async function handle(lane: JobLane, msg: AsyncMessage): Promise<void> {
    const parsedEnvelope = jobEnvelopeSchema.safeParse(msg.body);
    if (!parsedEnvelope.success) {
      await sendToDead(msg.body, lane, 'invalid-envelope', z.prettifyError(parsedEnvelope.error));
      logger.error({ lane }, 'invalid job envelope dead-lettered');
      return;
    }
    const envelope = parsedEnvelope.data;
    const job = registry.get(envelope.name);
    if (!job) {
      await dead(envelope, lane, 'unknown-job', `No job named "${envelope.name}" in this worker`);
      return;
    }
    const payload = job.schema.safeParse(envelope.payload);
    if (!payload.success) {
      await dead(envelope, lane, 'invalid-payload', z.prettifyError(payload.error));
      return;
    }

    if ((await store.begin(envelope, lane, now())) === 'duplicate') {
      logger.info(
        { jobId: envelope.id, job: envelope.name, idempotencyKey: envelope.idempotencyKey },
        'duplicate job dropped',
      );
      return;
    }

    try {
      await job.handler(payload.data, {
        jobId: envelope.id,
        idempotencyKey: envelope.idempotencyKey,
        attempt: envelope.attempt,
        isLastAttempt: envelope.attempt >= t.maxAttempts,
        orgId: envelope.orgId,
        stationId: envelope.stationId,
        signal: shutdown.signal,
      });
    } catch (error) {
      const message = errorMessage(error);
      if (error instanceof NonRetryableError) {
        await dead(envelope, lane, 'non-retryable', message);
      } else if (envelope.attempt >= t.maxAttempts) {
        await dead(envelope, lane, 'max-attempts', message);
      } else {
        const delayMs = t.retryDelayFor(envelope.attempt);
        await store.markRetrying(envelope.id, message, new Date(now().getTime() + delayMs));
        await publisher.send(
          {
            exchange: t.retryExchange,
            routingKey: t.retryRoutingKey(lane, delayMs),
            durable: true,
            messageId: envelope.id,
            type: envelope.name,
          },
          { ...envelope, attempt: envelope.attempt + 1 } satisfies JobEnvelope,
        );
        logger.warn(
          {
            jobId: envelope.id,
            job: envelope.name,
            attempt: envelope.attempt,
            delayMs,
            error: message,
          },
          'job failed, retry scheduled',
        );
      }
      return;
    }
    await store.markSucceeded(envelope.id, now());
  }

  const consumers: Consumer[] = lanes.map((lane) => {
    const concurrency = options.concurrency?.[lane] ?? DEFAULT_CONCURRENCY[lane];
    // Every outcome (success, retry, dead) acks the delivery once its follow-up message is
    // confirmed. If that fails, the handler throws and the delivery is requeued; the quorum
    // delivery limit dead-letters it if the failure persists.
    const consumer = rabbit.createConsumer(
      {
        queue: t.laneQueue(lane),
        queueOptions: { passive: true },
        qos: { prefetchCount: concurrency },
        concurrency,
        requeue: true,
      },
      (msg) => handle(lane, msg),
    );
    consumer.on('error', (error: unknown) =>
      logger.error({ lane, error: errorMessage(error) }, 'consumer error'),
    );
    return consumer;
  });

  const ready = Promise.all(
    consumers.map((c) => new Promise<void>((resolve) => c.once('ready', () => resolve()))),
  ).then(() => undefined);

  return {
    ready,
    async close() {
      shutdown.abort();
      // Consumer.close() waits for in-flight handlers before closing the channel.
      await Promise.all(consumers.map((c) => c.close()));
      await publisher.close();
    },
  };
}
