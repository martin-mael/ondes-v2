import { randomUUID } from 'node:crypto';
import type { JobEnvelope } from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresJobRunStore } from './repos/jobs.ts';
import { createTestDatabase, type TestDatabase } from './testing.ts';

const t0 = new Date('2026-10-25T00:30:00Z');

function envelope(overrides: Partial<JobEnvelope> = {}): JobEnvelope {
  return {
    id: randomUUID(),
    name: 'ingest',
    idempotencyKey: `key:${randomUUID()}`,
    idempotency: 'in_flight',
    attempt: 1,
    enqueuedAt: t0.toISOString(),
    payload: {},
    ...overrides,
  };
}

describe('PostgresJobRunStore', () => {
  let tdb: TestDatabase;
  let store: PostgresJobRunStore;
  beforeAll(async () => {
    tdb = await createTestDatabase();
    store = new PostgresJobRunStore(tdb.db);
  });
  afterAll(() => tdb?.drop());

  it('in_flight: blocks the same key only while a run is in flight', async () => {
    const first = envelope();
    const key = first.idempotencyKey;
    expect(await store.begin(first, 'bulk', t0)).toBe('started');
    expect(await store.begin(envelope({ idempotencyKey: key }), 'bulk', t0)).toBe('duplicate');
    await store.markRetrying(first.id, 'boom', t0);
    expect(await store.begin(envelope({ idempotencyKey: key }), 'bulk', t0)).toBe('duplicate');
    await store.markSucceeded(first.id, t0);
    expect(await store.begin(envelope({ idempotencyKey: key }), 'bulk', t0)).toBe('started');
  });

  it('once: also blocks the key after a run succeeded', async () => {
    const first = envelope({ idempotency: 'once' });
    const again = () => envelope({ idempotencyKey: first.idempotencyKey, idempotency: 'once' });
    await store.begin(first, 'bulk', t0);
    await store.markSucceeded(first.id, t0);
    expect(await store.begin(again(), 'bulk', t0)).toBe('duplicate');
  });

  it('lets a job retry, keeps its first start, and drops it once succeeded', async () => {
    const job = envelope();
    await store.begin(job, 'high', t0);
    await store.markRetrying(job.id, 'boom', new Date(t0.getTime() + 10_000));
    const later = new Date(t0.getTime() + 20_000);
    expect(await store.begin({ ...job, attempt: 2 }, 'high', later)).toBe('started');
    expect(await store.get(job.id)).toMatchObject({
      status: 'running',
      attempt: 2,
      startedAt: t0.toISOString(),
      nextAttemptAt: null,
    });
    await store.markSucceeded(job.id, later);
    expect(await store.begin({ ...job, attempt: 2 }, 'high', later)).toBe('duplicate');
  });

  it('starts exactly one of several concurrent duplicates (worker replicas)', async () => {
    const key = `race:${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.begin(envelope({ idempotencyKey: key }), 'bulk', t0)),
    );
    expect(results.filter((r) => r === 'started')).toHaveLength(1);
  });

  it('records dead jobs, even ones rejected before begin, and lists them', async () => {
    const stationId = randomUUID();
    const job = envelope({ stationId });
    await store.markDead(job, 'bulk', 'invalid payload', t0);
    const [run] = await store.list({ status: 'dead', stationId });
    expect(run).toMatchObject({ id: job.id, status: 'dead', lastError: 'invalid payload' });
    // A fresh job with the key of a dead one may run.
    expect(await store.begin(envelope({ idempotencyKey: job.idempotencyKey }), 'bulk', t0)).toBe(
      'started',
    );
  });
});
