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
    attempt: 1,
    enqueuedAt: t0.toISOString(),
    payload: {},
    ...overrides,
  };
}

describe('InMemoryJobRunStore', () => {
  it('drops another job with the same key while the first is running, retrying or done', async () => {
    const store = new InMemoryJobRunStore();
    const first = envelope();
    expect(await store.begin(first, 'bulk', t0)).toBe('started');
    expect(await store.begin(envelope(), 'bulk', t0)).toBe('duplicate');
    await store.markRetrying(first.id, 'boom', t0);
    expect(await store.begin(envelope(), 'bulk', t0)).toBe('duplicate');
    await store.markSucceeded(first.id, t0);
    expect(await store.begin(envelope(), 'bulk', t0)).toBe('duplicate');
    expect(await store.list()).toHaveLength(1);
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
