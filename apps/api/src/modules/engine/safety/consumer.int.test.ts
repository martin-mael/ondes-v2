import { randomUUID } from 'node:crypto';
import {
  addMembership,
  createOrganization,
  createStation,
  type StationScope,
  unsafeScope,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import { deleteEventQueue } from '@ondes/queue';
import type { Actor, SafetyStatus } from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../app.ts';
import { createMemoryMailer } from '../../../plugins/mail.ts';
import { createTestRabbit, engineEvent, waitFor } from '../../alerts/testing.ts';
import {
  cookieHeader,
  signUpAndLogin,
  TEST_AUTH_CONFIG,
  type TestApp,
} from '../../auth/testing.ts';

// The durable `safety` engine-event consumer (#34), through the real RabbitMQ events exchange
// (`/ondes` vhost, random prefix and queue names): track.started sources reach the station's
// on-air state, in order, and a boot resets it. Needs `pnpm dev:up` (Postgres, RabbitMQ).

const system: Actor = { type: 'system', name: 'test' };
const safetyQueue = `safety-${randomUUID().slice(0, 8)}`;
const alertsQueue = `alerts-${randomUUID().slice(0, 8)}`;

let tdb: TestDatabase;
let rabbit: Awaited<ReturnType<typeof createTestRabbit>>;
let app: FastifyInstance;
let manager: { userId: string; cookie: string };
let scope: StationScope;

beforeAll(async () => {
  tdb = await createTestDatabase();
  rabbit = await createTestRabbit();
  const mailer = createMemoryMailer();
  app = await buildApp({
    db: { client: tdb },
    rabbit: { rabbit },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    alerts: { sweepIntervalMs: 0, eventQueue: alertsQueue },
    cache: { alertIntervalMs: 0 },
    safety: { alertIntervalMs: 0, eventQueue: safetyQueue },
    fastify: { logger: false },
  });
  await app.ready();
  const org = await createOrganization(tdb.db, system, { slug: 'safety-q', name: 'Q' });
  const orgScope = unsafeScope(org.id);
  manager = await signUpAndLogin(
    { app, tdb, outbox: mailer.outbox } as unknown as TestApp,
    'manager@safety-q.test',
  );
  const st = await createStation(
    tdb.db,
    { actor: system, scope: orgScope },
    { slug: 'safety-q', name: 'FM', timezone: 'Europe/Paris' },
  );
  await addMembership(
    tdb.db,
    { actor: system, scope: orgScope },
    { level: 'station', userId: manager.userId, stationId: st.id, role: 'station_manager' },
  );
  scope = unsafeScope(org.id, st.id);
}, 60_000);

afterAll(async () => {
  await app?.close();
  if (rabbit) {
    for (const name of [safetyQueue, alertsQueue]) {
      await deleteEventQueue(rabbit.queue.rabbit, rabbit.queue.topology, name).catch(() => {});
    }
    await rabbit.close();
  }
  await tdb?.drop();
});

async function onAir() {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/stations/${scope.stationId}/safety`,
    headers: cookieHeader(manager.cookie),
  });
  return (res.json() as SafetyStatus).onAir;
}

const started = (source: 'queue' | 'safety' | 'emergency', seq: number, at: Date) =>
  engineEvent(
    scope.stationId,
    'engine.track.started',
    {
      bootId: 'boot-1',
      seq,
      itemId: null,
      segmentId: null,
      source,
      title: null,
      artist: null,
      filename: null,
      rid: String(seq),
    },
    at,
  );

describe('safety engine-event consumer', () => {
  it('records the on-air source from the events exchange', async () => {
    const t0 = new Date(Date.now() - 60_000);
    await rabbit.events.publish(started('queue', 1, t0));
    await rabbit.events.publish(started('safety', 2, new Date(t0.getTime() + 10_000)));
    await rabbit.events.publish(started('safety', 3, new Date(t0.getTime() + 20_000)));
    const safe = await waitFor('safety on air', async () => {
      const s = await onAir();
      return (
        s?.source === 'safety' && new Date(s.startedAt).getTime() === t0.getTime() + 10_000 && s
      );
    });
    expect(safe).toBeTruthy();

    await rabbit.events.publish(
      engineEvent(scope.stationId, 'engine.booted', { bootId: 'boot-2', seq: 1, version: '2.4.6' }),
    );
    await waitFor('reset on boot', async () => (await onAir()) === null);
  });
});
