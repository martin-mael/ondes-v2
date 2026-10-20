import type { JobEnvelope, JobLane, JobRun, JobRunStatus } from '@ondes/shared';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { jobRun } from '../schema/jobs.ts';

// Postgres implementation of `JobRunStore` (the port is defined in `@ondes/queue`; this class
// matches it structurally so `@ondes/db` doesn't depend on the queue package).

export interface JobRunFilter {
  status?: JobRunStatus;
  name?: string;
  stationId?: string;
  /** Newest first; defaults to 100. */
  limit?: number;
}

const IN_FLIGHT: JobRunStatus[] = ['running', 'retrying'];
const ONCE: JobRunStatus[] = ['running', 'retrying', 'succeeded'];

/** Postgres unique violation: the in-flight key index caught a concurrent duplicate. */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
}

type Row = typeof jobRun.$inferSelect;

function toJobRun(row: Row): JobRun {
  return {
    id: row.id,
    name: row.name,
    lane: row.lane,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    attempt: row.attempt,
    orgId: row.orgId,
    stationId: row.stationId,
    lastError: row.lastError,
    enqueuedAt: row.enqueuedAt.toISOString(),
    startedAt: row.startedAt.toISOString(),
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/**
 * Job status shared by every worker replica. `begin` takes a transaction-scoped advisory
 * lock on the idempotency key, so two replicas receiving duplicates at the same moment
 * can't both start; the partial unique index on in-flight keys backs it up.
 */
export class PostgresJobRunStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async begin(envelope: JobEnvelope, lane: JobLane, now: Date): Promise<'started' | 'duplicate'> {
    try {
      return await this.#db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${envelope.idempotencyKey}, 0))`,
        );
        const [existing] = await tx
          .select({ status: jobRun.status })
          .from(jobRun)
          .where(eq(jobRun.id, envelope.id));
        if (existing?.status === 'succeeded') return 'duplicate';

        const blocking = envelope.idempotency === 'once' ? ONCE : IN_FLIGHT;
        const [other] = await tx
          .select({ id: jobRun.id })
          .from(jobRun)
          .where(
            and(
              eq(jobRun.idempotencyKey, envelope.idempotencyKey),
              ne(jobRun.id, envelope.id),
              inArray(jobRun.status, blocking),
            ),
          )
          .limit(1);
        if (other) return 'duplicate';

        if (existing) {
          // A retry of this job: keep the first start time.
          await tx
            .update(jobRun)
            .set({
              status: 'running',
              attempt: envelope.attempt,
              lane,
              nextAttemptAt: null,
              finishedAt: null,
            })
            .where(eq(jobRun.id, envelope.id));
        } else {
          await tx.insert(jobRun).values({
            id: envelope.id,
            name: envelope.name,
            lane,
            idempotencyKey: envelope.idempotencyKey,
            idempotency: envelope.idempotency,
            status: 'running',
            attempt: envelope.attempt,
            orgId: envelope.orgId ?? null,
            stationId: envelope.stationId ?? null,
            enqueuedAt: new Date(envelope.enqueuedAt),
            startedAt: now,
          });
        }
        return 'started';
      });
    } catch (error) {
      if (isUniqueViolation(error)) return 'duplicate';
      throw error;
    }
  }

  async markSucceeded(jobId: string, now: Date): Promise<void> {
    await this.#db
      .update(jobRun)
      .set({ status: 'succeeded', nextAttemptAt: null, finishedAt: now })
      .where(eq(jobRun.id, jobId));
  }

  async markRetrying(jobId: string, error: string, nextAttemptAt: Date): Promise<void> {
    await this.#db
      .update(jobRun)
      .set({ status: 'retrying', lastError: error, nextAttemptAt })
      .where(eq(jobRun.id, jobId));
  }

  async markDead(envelope: JobEnvelope, lane: JobLane, error: string, now: Date): Promise<void> {
    const dead = {
      status: 'dead' as const,
      attempt: envelope.attempt,
      lastError: error,
      nextAttemptAt: null,
      finishedAt: now,
    };
    await this.#db
      .insert(jobRun)
      .values({
        id: envelope.id,
        name: envelope.name,
        lane,
        idempotencyKey: envelope.idempotencyKey,
        idempotency: envelope.idempotency,
        orgId: envelope.orgId ?? null,
        stationId: envelope.stationId ?? null,
        enqueuedAt: new Date(envelope.enqueuedAt),
        startedAt: now,
        ...dead,
      })
      .onConflictDoUpdate({ target: jobRun.id, set: dead });
  }

  async get(jobId: string): Promise<JobRun | undefined> {
    const [row] = await this.#db.select().from(jobRun).where(eq(jobRun.id, jobId));
    return row && toJobRun(row);
  }

  async list(filter: JobRunFilter = {}): Promise<JobRun[]> {
    const rows = await this.#db
      .select()
      .from(jobRun)
      .where(
        and(
          filter.status ? eq(jobRun.status, filter.status) : undefined,
          filter.name ? eq(jobRun.name, filter.name) : undefined,
          filter.stationId ? eq(jobRun.stationId, filter.stationId) : undefined,
        ),
      )
      .orderBy(desc(jobRun.enqueuedAt))
      .limit(filter.limit ?? 100);
    return rows.map(toJobRun);
  }
}
