import type { JobEnvelope, JobLane } from '@ondes/shared';
import type { z } from 'zod';

export type JobContext = {
  /** The job's id; the same for every attempt of one enqueue. */
  jobId: string;
  idempotencyKey: string;
  /** 1-based attempt number. */
  attempt: number;
  /** True when this is the last attempt before the DLQ. */
  isLastAttempt: boolean;
  orgId: string | undefined;
  stationId: string | undefined;
  /** Aborted when the worker shuts down; long handlers should stop early. */
  signal: AbortSignal;
};

export type JobHandler<P> = (payload: P, ctx: JobContext) => Promise<void> | void;

export type JobDefinition<S extends z.ZodType = z.ZodType> = {
  readonly name: string;
  readonly schema: S;
  readonly lane: JobLane;
  readonly handler: JobHandler<z.output<S>>;
  /** Derives the idempotency key from the payload when the publisher doesn't give one. */
  readonly idempotencyKey: ((payload: z.output<S>) => string) | undefined;
};

export type DefineJobOptions<S extends z.ZodType> = {
  /** Defaults to `bulk`. */
  lane?: JobLane;
  /** e.g. `(p) => \`track:${p.trackId}:${p.version}\``. Defaults to a hash of the payload. */
  idempotencyKey?: (payload: z.output<S>) => string;
};

const JOB_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Declares a job type. The worker discovers each job from the default export of
 * `apps/worker/src/jobs/<job>/index.ts`, and publishers import the same definition so the
 * payload type is shared.
 */
export function defineJob<S extends z.ZodType>(
  name: string,
  schema: S,
  handler: JobHandler<z.output<S>>,
  options: DefineJobOptions<S> = {},
): JobDefinition<S> {
  if (!JOB_NAME.test(name)) {
    throw new Error(`Invalid job name "${name}": use kebab-case, e.g. "log-generate"`);
  }
  return {
    name,
    schema,
    lane: options.lane ?? 'bulk',
    handler,
    idempotencyKey: options.idempotencyKey,
  };
}

/** Throw from a handler to send the job straight to the DLQ, skipping the retry tiers. */
export class NonRetryableError extends Error {
  override name = 'NonRetryableError';
}

export type { JobEnvelope };
