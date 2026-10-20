import type { JobEnvelope, JobLane, JobRun, JobRunStatus } from '@ondes/shared';

export type BeginResult = 'started' | 'duplicate';

export type JobRunFilter = {
  status?: JobRunStatus;
  name?: string;
  stationId?: string;
  /** Newest first; defaults to 100. */
  limit?: number;
};

/**
 * Persistence port for job status: idempotency checks plus the admin job list.
 * The in-memory implementation below serves tests and single-process dev; a Postgres
 * implementation (`job_run` table in `packages/db/src/schema/jobs.ts`) follows #5.
 */
export interface JobRunStore {
  /**
   * Atomically records that an attempt starts. Returns `duplicate`, and records nothing,
   * when the job must not run: another job with the same idempotency key is running,
   * retrying or succeeded, or this very job already succeeded (a redelivery).
   */
  begin(envelope: JobEnvelope, lane: JobLane, now: Date): Promise<BeginResult>;
  markSucceeded(jobId: string, now: Date): Promise<void>;
  markRetrying(jobId: string, error: string, nextAttemptAt: Date): Promise<void>;
  /** Upserts, so jobs rejected before `begin` (bad payload, unknown job) are listed too. */
  markDead(envelope: JobEnvelope, lane: JobLane, error: string, now: Date): Promise<void>;
  get(jobId: string): Promise<JobRun | undefined>;
  list(filter?: JobRunFilter): Promise<JobRun[]>;
}

const BLOCKING: ReadonlySet<JobRunStatus> = new Set(['running', 'retrying', 'succeeded']);

function newRun(envelope: JobEnvelope, lane: JobLane, now: Date): JobRun {
  return {
    id: envelope.id,
    name: envelope.name,
    lane,
    idempotencyKey: envelope.idempotencyKey,
    status: 'running',
    attempt: envelope.attempt,
    orgId: envelope.orgId ?? null,
    stationId: envelope.stationId ?? null,
    lastError: null,
    enqueuedAt: envelope.enqueuedAt,
    startedAt: now.toISOString(),
    nextAttemptAt: null,
    finishedAt: null,
  };
}

export class InMemoryJobRunStore implements JobRunStore {
  readonly #runs = new Map<string, JobRun>();

  async begin(envelope: JobEnvelope, lane: JobLane, now: Date): Promise<BeginResult> {
    const existing = this.#runs.get(envelope.id);
    if (existing?.status === 'succeeded') return 'duplicate';
    for (const run of this.#runs.values()) {
      if (
        run.id !== envelope.id &&
        run.idempotencyKey === envelope.idempotencyKey &&
        BLOCKING.has(run.status)
      ) {
        return 'duplicate';
      }
    }
    const run = newRun(envelope, lane, now);
    // Keep the first start time across retries.
    if (existing) run.startedAt = existing.startedAt;
    this.#runs.set(run.id, run);
    return 'started';
  }

  async markSucceeded(jobId: string, now: Date): Promise<void> {
    this.#update(jobId, {
      status: 'succeeded',
      nextAttemptAt: null,
      finishedAt: now.toISOString(),
    });
  }

  async markRetrying(jobId: string, error: string, nextAttemptAt: Date): Promise<void> {
    this.#update(jobId, {
      status: 'retrying',
      lastError: error,
      nextAttemptAt: nextAttemptAt.toISOString(),
    });
  }

  async markDead(envelope: JobEnvelope, lane: JobLane, error: string, now: Date): Promise<void> {
    const run = this.#runs.get(envelope.id) ?? newRun(envelope, lane, now);
    this.#runs.set(run.id, {
      ...run,
      status: 'dead',
      attempt: envelope.attempt,
      lastError: error,
      nextAttemptAt: null,
      finishedAt: now.toISOString(),
    });
  }

  async get(jobId: string): Promise<JobRun | undefined> {
    const run = this.#runs.get(jobId);
    return run && { ...run };
  }

  async list(filter: JobRunFilter = {}): Promise<JobRun[]> {
    return [...this.#runs.values()]
      .filter(
        (run) =>
          (!filter.status || run.status === filter.status) &&
          (!filter.name || run.name === filter.name) &&
          (!filter.stationId || run.stationId === filter.stationId),
      )
      .sort((a, b) => b.enqueuedAt.localeCompare(a.enqueuedAt))
      .slice(0, filter.limit ?? 100)
      .map((run) => ({ ...run }));
  }

  #update(jobId: string, patch: Partial<JobRun>): void {
    const run = this.#runs.get(jobId);
    if (run) this.#runs.set(jobId, { ...run, ...patch });
  }
}
