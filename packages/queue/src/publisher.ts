import { randomUUID } from 'node:crypto';
import type { JobEnvelope, JobLane } from '@ondes/shared';
import type { Connection } from 'rabbitmq-client';
import type { z } from 'zod';
import { defaultIdempotencyKey } from './idempotency.ts';
import type { JobDefinition } from './job.ts';
import type { Topology } from './topology.ts';

/**
 * What a publisher needs from a job: no handler, so the api can enqueue a job without
 * importing the worker's code. A `JobDefinition` is also a `JobType`.
 */
export type JobType<S extends z.ZodType = z.ZodType> = Pick<
  JobDefinition<S>,
  'name' | 'schema' | 'lane' | 'idempotencyKey'
>;

/** Declares a job type for publishers; the worker pairs it with a handler via `defineJob`. */
export function jobType<S extends z.ZodType>(
  name: string,
  schema: S,
  options: { lane?: JobLane; idempotencyKey?: (payload: z.output<S>) => string } = {},
): JobType<S> {
  return { name, schema, lane: options.lane ?? 'bulk', idempotencyKey: options.idempotencyKey };
}

export type EnqueueOptions = {
  /** Overrides the job's own key derivation, e.g. `track:<id>:<version>`. */
  idempotencyKey?: string;
  orgId?: string;
  stationId?: string;
};

export type JobPublisher = {
  /** Validates the payload, then publishes with a broker confirm. Returns the envelope sent. */
  enqueue<S extends z.ZodType>(
    job: JobType<S>,
    payload: z.input<S>,
    options?: EnqueueOptions,
  ): Promise<JobEnvelope>;
  close(): Promise<void>;
};

export function createJobPublisher(rabbit: Connection, topology: Topology): JobPublisher {
  const publisher = rabbit.createPublisher({ confirm: true, maxAttempts: 3 });
  return {
    async enqueue(job, input, options = {}) {
      const payload = job.schema.parse(input);
      const envelope: JobEnvelope = {
        id: randomUUID(),
        name: job.name,
        idempotencyKey:
          options.idempotencyKey ??
          job.idempotencyKey?.(payload) ??
          defaultIdempotencyKey(job.name, payload),
        attempt: 1,
        enqueuedAt: new Date().toISOString(),
        orgId: options.orgId,
        stationId: options.stationId,
        payload,
      };
      await publisher.send(
        {
          exchange: topology.jobsExchange,
          routingKey: job.lane,
          durable: true,
          mandatory: true,
          messageId: envelope.id,
          type: envelope.name,
        },
        envelope,
      );
      return envelope;
    },
    close: () => publisher.close(),
  };
}
