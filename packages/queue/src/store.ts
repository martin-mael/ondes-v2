import type { IdempotencyMode, JobEnvelope, JobLane, JobRun, JobRunStatus } from '@ondes/shared';

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
   * when the job must not run:
   * - this very job already succeeded (a redelivery);
   * - another job with the same idempotency key is `running` or `retrying`;
   * - with `idempotency: 'once'`, another job with the same key `succeeded`.
   */
  begin(envelope: JobEnvelope, lane: JobLane, now: Date): Promise<BeginResult>;
  markSucceeded(jobId: string, now: Date): Promise<void>;
  markRetrying(jobId: string, error: string, nextAttemptAt: Date): Promise<void>;
  /** Upserts, so jobs rejected before `begin` (bad payload, unknown job) are listed too. */
  markDead(envelope: JobEnvelope, lane: JobLane, error: string, now: Date): Promise<void>;
  get(jobId: string): Promise<JobRun | undefined>;
  list(filter?: JobRunFilter): Promise<JobRun[]>;
}

/** Statuses of *another* run that block a job with the same key. */
export function blockingStatuses(mode: IdempotencyMode): ReadonlySet<JobRunStatus> {
  return mode === 'once' ? BLOCKING_ONCE : BLOCKING_IN_FLIGHT;
}

const BLOCKING_IN_FLIGHT: ReadonlySet<JobRunStatus> = new Set(['running', 'retrying']);
const BLOCKING_ONCE: ReadonlySet<JobRunStatus> = new Set(['running', 'retrying', 'succeeded']);

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

export type InMemoryJobRunStoreOptions = {
  /**
   * Finished (`succeeded` or `dead`) runs kept for duplicate checks and the job list; the
   * oldest are forgotten beyond this. Defaults to 10 000.
   */
  maxFinishedRuns?: number;
};

/**
 * Per-process store for tests and single-process dev. Lookups go through an index by
 * idempotency key, and finished runs are pruned, so a long-running process stays bounded.
 * It can't dedupe across worker replicas: production uses the Postgres store.
 */
export class InMemoryJobRunStore implements JobRunStore {
  readonly #runs = new Map<string, JobRun>();
  readonly #byKey = new Map<string, Set<string>>();
  /** Finished run ids, oldest first (a Set keeps insertion order). */
  readonly #finished = new Set<string>();
  readonly #maxFinished: number;

  constructor(options: InMemoryJobRunStoreOptions = {}) {
    this.#maxFinished = options.maxFinishedRuns ?? 10_000;
  }

  async begin(envelope: JobEnvelope, lane: JobLane, now: Date): Promise<BeginResult> {
    const existing = this.#runs.get(envelope.id);
    if (existing?.status === 'succeeded') return 'duplicate';
    const blocking = blockingStatuses(envelope.idempotency);
    for (const id of this.#byKey.get(envelope.idempotencyKey) ?? []) {
      const run = this.#runs.get(id);
      if (run && id !== envelope.id && blocking.has(run.status)) return 'duplicate';
    }
    const run = newRun(envelope, lane, now);
    // Keep the first start time across retries.
    if (existing) run.startedAt = existing.startedAt;
    this.#put(run);
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
    this.#put({
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
    if (run) this.#put({ ...run, ...patch });
  }

  #put(run: JobRun): void {
    this.#runs.set(run.id, run);
    const ids = this.#byKey.get(run.idempotencyKey) ?? new Set<string>();
    this.#byKey.set(run.idempotencyKey, ids);
    ids.add(run.id);
    this.#finished.delete(run.id);
    if (run.status === 'succeeded' || run.status === 'dead') {
      this.#finished.add(run.id);
      this.#prune();
    }
  }

  #prune(): void {
    for (const id of this.#finished) {
      if (this.#finished.size <= this.#maxFinished) return;
      this.#finished.delete(id);
      const run = this.#runs.get(id);
      this.#runs.delete(id);
      if (!run) continue;
      const ids = this.#byKey.get(run.idempotencyKey);
      ids?.delete(id);
      if (ids?.size === 0) this.#byKey.delete(run.idempotencyKey);
    }
  }
}
