import { randomUUID } from 'node:crypto';
import type { JobEnvelope } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { InMemoryJobRunStore } from './store.ts';

const t0 = new Date('2026-10-25T00:30:00Z');

function envelope(overrides: Partial<JobEnvelope> = {}): JobEnvelope {
  return {
    id: randomUUID(),
    name: 'ingest',
    idempotencyKey: 'track:1:v1',
    idempotency: 'in_flight',
    attempt: 1,
    enqueuedAt: t0.toISOString(),
    payload: {},
    ...overrides,
  };
}

describe('InMemoryJobRunStore', () => {
  it('in_flight: drops another job with the same key only while the first is in flight', async () => {
    const store = new InMemoryJobRunStore();
    const first = envelope();
    expect(await store.begin(first, 'bulk', t0)).toBe('started');
    expect(await store.begin(envelope(), 'bulk', t0)).toBe('duplicate');
    await store.markRetrying(first.id, 'boom', t0);
    expect(await store.begin(envelope(), 'bulk', t0)).toBe('duplicate');
    await store.markSucceeded(first.id, t0);
    // Same work enqueued again later (e.g. regenerate a log): it runs.
    expect(await store.begin(envelope(), 'bulk', t0)).toBe('started');
    expect(await store.list()).toHaveLength(2);
  });

  it('once: also drops another job with the same key after one succeeded', async () => {
    const store = new InMemoryJobRunStore();
    const first = envelope({ idempotency: 'once' });
    expect(await store.begin(first, 'bulk', t0)).toBe('started');
    expect(await store.begin(envelope({ idempotency: 'once' }), 'bulk', t0)).toBe('duplicate');
    await store.markSucceeded(first.id, t0);
    expect(await store.begin(envelope({ idempotency: 'once' }), 'bulk', t0)).toBe('duplicate');
  });

  it('forgets the oldest finished runs beyond maxFinishedRuns', async () => {
    const store = new InMemoryJobRunStore({ maxFinishedRuns: 2 });
    const jobs = [1, 2, 3].map((n) => envelope({ idempotencyKey: `k${n}`, idempotency: 'once' }));
    for (const job of jobs) {
      await store.begin(job, 'bulk', t0);
      await store.markSucceeded(job.id, t0);
    }
    const running = envelope({ idempotencyKey: 'k-running' });
    await store.begin(running, 'bulk', t0);
    expect((await store.list()).map((r) => r.idempotencyKey).sort()).toEqual([
      'k-running',
      'k2',
      'k3',
    ]);
    // k1 was pruned, so a `once` job with that key can run again (Postgres keeps them all).
    expect(
      await store.begin(envelope({ idempotencyKey: 'k1', idempotency: 'once' }), 'bulk', t0),
    ).toBe('started');
  });

  it('lets the same job retry, but not run again once succeeded', async () => {
    const store = new InMemoryJobRunStore();
    const job = envelope();
    await store.begin(job, 'bulk', t0);
    await store.markRetrying(job.id, 'boom', t0);
    expect(await store.begin({ ...job, attempt: 2 }, 'bulk', t0)).toBe('started');
    expect((await store.get(job.id))?.attempt).toBe(2);
    await store.markSucceeded(job.id, t0);
    expect(await store.begin({ ...job, attempt: 2 }, 'bulk', t0)).toBe('duplicate');
  });

  it('allows a fresh job with the key of a dead one', async () => {
    const store = new InMemoryJobRunStore();
    const job = envelope();
    await store.markDead(job, 'bulk', 'bad payload', t0);
    expect(await store.begin(envelope(), 'bulk', t0)).toBe('started');
  });

  it('lists dead jobs for the admin view', async () => {
    const store = new InMemoryJobRunStore();
    const job = envelope({ stationId: randomUUID() });
    await store.begin(job, 'high', t0);
    await store.markDead({ ...job, attempt: 4 }, 'high', 'boom', t0);
    const [run] = await store.list({ status: 'dead', stationId: job.stationId });
    expect(run).toMatchObject({
      id: job.id,
      status: 'dead',
      attempt: 4,
      lastError: 'boom',
      lane: 'high',
    });
    expect(await store.list({ status: 'succeeded' })).toEqual([]);
  });
});
