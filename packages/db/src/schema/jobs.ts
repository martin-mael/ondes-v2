import type { IdempotencyMode, JobLane, JobRunStatus } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

// Job runs (#8): one row per enqueued job, written by the worker's `PostgresJobRunStore`.
// Contracts: packages/shared/src/contracts/jobs.ts. No foreign keys, like `audit_log`: job
// history outlives the stations it was about.

export const jobRun = pgTable(
  'job_run',
  {
    /** The envelope id: unique per enqueue, kept across retries. */
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    lane: text('lane').$type<JobLane>().notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    idempotency: text('idempotency').$type<IdempotencyMode>().notNull(),
    status: text('status').$type<JobRunStatus>().notNull(),
    attempt: integer('attempt').notNull(),
    orgId: uuid('org_id'),
    stationId: uuid('station_id'),
    lastError: text('last_error'),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    // At most one in-flight run per key, whatever the mode: the store's check is backed by
    // the database, not only by its advisory lock.
    uniqueIndex('job_run_in_flight_key')
      .on(t.idempotencyKey)
      .where(sql`${t.status} in ('running', 'retrying')`),
    index('job_run_key_status_idx').on(t.idempotencyKey, t.status),
    index('job_run_status_enqueued_idx').on(t.status, t.enqueuedAt),
    index('job_run_station_enqueued_idx').on(t.stationId, t.enqueuedAt),
  ],
);
