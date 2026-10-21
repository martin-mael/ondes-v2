import {
  addMembership,
  auditLog,
  createOrganization,
  createStation,
  type StationScope,
  unsafeScope,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import {
  type Actor,
  type Alert,
  type AlertRealtimeEvent,
  alertRealtimeEventSchema,
  alertTypes,
} from '@ondes/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { createMemoryMailer, type MailMessage } from '../../plugins/mail.ts';
import type { Rabbit } from '../../plugins/rabbit.ts';
import { cookieHeader, signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../auth/testing.ts';
import { createEngineAdapter } from '../engine/adapter/index.ts';
import { type FakeEngine, startFakeEngine } from '../engine/adapter/testing/fake-engine.ts';
import { createTestRabbit, engineEvent, waitFor } from './testing.ts';

// Alerts end to end: engine events go through the real RabbitMQ fanout into the api, which
// raises / escalates / resolves alerts, runs the silence action against a fake engine, emails
// the station's managers and publishes alert.* events. Needs `pnpm dev:up` (Postgres, RabbitMQ).

const system: Actor = { type: 'system', name: 'test' };

let tdb: TestDatabase;
let rabbit: Rabbit;
let fake: FakeEngine;
let app: FastifyInstance;
let outbox: MailMessage[];
let scope: StationScope;
let otherStation: string;
let manager: string;
let programmer: string;
const alertEvents: AlertRealtimeEvent[] = [];
let seq = 0;

beforeAll(async () => {
  tdb = await createTestDatabase();
  rabbit = await createTestRabbit();
  fake = await startFakeEngine({ token: 'tok' });
  const adapter = createEngineAdapter({ stationId: 'x', baseUrl: fake.url, token: 'tok' });
  const mailer = createMemoryMailer();
  outbox = mailer.outbox;
  app = await buildApp({
    db: { client: tdb },
    rabbit: { rabbit },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    alerts: { engineFor: () => adapter, escalationIntervalMs: 100 },
    fastify: { logger: false },
  });
  await app.ready();

  const sub = rabbit.subscribeEvents((raw) => {
    const parsed = alertRealtimeEventSchema.safeParse(raw);
    if (parsed.success) alertEvents.push(parsed.data);
  });
  await sub.ready;

  const org = await createOrganization(tdb.db, system, { slug: 'alerts', name: 'Alerts' });
  const ctx = { actor: system, scope: unsafeScope(org.id) };
  const st = await createStation(tdb.db, ctx, {
    slug: 'vandale',
    name: 'Vandale',
    timezone: 'Europe/Paris',
  });
  scope = unsafeScope(org.id, st.id);
  otherStation = (
    await createStation(tdb.db, ctx, { slug: 'other', name: 'Other', timezone: 'UTC' })
  ).id;

  const t = { app, tdb, outbox } as unknown as TestApp;
  const m = await signUpAndLogin(t, 'manager@alerts.test');
  const p = await signUpAndLogin(t, 'programmer@alerts.test');
  await addMembership(tdb.db, ctx, {
    level: 'station',
    userId: m.userId,
    stationId: st.id,
    role: 'station_manager',
  });
  await addMembership(tdb.db, ctx, {
    level: 'station',
    userId: p.userId,
    stationId: st.id,
    role: 'programmer',
  });
  manager = m.cookie;
  programmer = p.cookie;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await rabbit?.close();
  await fake?.close();
  await tdb?.drop();
}, 60_000);

beforeEach(() => {
  fake.calls.length = 0;
  outbox.length = 0;
  alertEvents.length = 0;
});

const base = () => `/api/v1/stations/${scope.stationId}`;

async function api(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  cookie = manager,
  payload?: object,
) {
  return app.inject({ method, url: `${base()}${url}`, headers: cookieHeader(cookie), payload });
}

async function publish(type: 'engine.blank.detected' | 'engine.blank.recovered' | 'engine.booted') {
  seq++;
  const data =
    type === 'engine.booted'
      ? { bootId: 'boot-2', seq, version: '2.4.6' }
      : { bootId: 'boot-1', seq };
  await rabbit.events.publish(engineEvent(scope.stationId, type, data as never));
}

async function openAlert(type: string): Promise<Alert | undefined> {
  const res = await api('GET', `/alerts?type=${type}`);
  expect(res.statusCode).toBe(200);
  return res.json().items[0];
}

const alertEvent =
  <T extends AlertRealtimeEvent['type']>(type: T) =>
  () =>
    alertEvents.find((e): e is Extract<AlertRealtimeEvent, { type: T }> => e.type === type);

const mailsTo = (email: string) => outbox.filter((m) => m.to === email);

describe('silence settings', () => {
  it('defaults match the engine template, and only alert:manage can change them', async () => {
    const res = await api('GET', '/silence-settings', programmer);
    expect(res.json()).toEqual({
      maxSeconds: 10,
      thresholdDb: -40,
      action: 'skip',
      escalateAfterSeconds: 60,
    });
    const denied = await api('PATCH', '/silence-settings', programmer, { action: 'none' });
    expect(denied.statusCode).toBe(403);
    const bad = await api('PATCH', '/silence-settings', manager, { thresholdDb: 3 });
    expect(bad.statusCode).toBe(400);

    const ok = await api('PATCH', '/silence-settings', manager, { maxSeconds: 4 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ maxSeconds: 4, action: 'skip' });
    const event = await waitFor('settings event', alertEvent('alert.silence_settings.updated'));
    expect(event).toMatchObject({ stationId: scope.stationId, data: { maxSeconds: 4 } });
    const audit = await tdb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'silence_setting.update'));
    expect(audit).toHaveLength(1);
  });
});

describe('silence with action none', () => {
  it('raises a critical alert, emails managers, dedupes, acknowledges and resolves', async () => {
    await api('PATCH', '/silence-settings', manager, { action: 'none' });

    await publish('engine.blank.detected');
    const raised = await waitFor('raised', alertEvent('alert.raised'));
    expect(raised.data).toMatchObject({ type: alertTypes.silence, severity: 'critical' });
    // The action outcome is merged into the details right after the raise.
    const alert = await waitFor('alert row', async () => {
      const a = await openAlert(alertTypes.silence);
      return a?.details.action ? a : undefined;
    });
    expect(alert).toMatchObject({
      status: 'open',
      occurrences: 1,
      details: { action: { action: 'none', result: 'none' } },
    });
    expect(fake.calls.filter((c) => c.startsWith('POST /v1/skip'))).toEqual([]);

    // Station managers get the email; programmers (alert:read only) don't.
    await waitFor('email', () => mailsTo('manager@alerts.test').length === 1);
    expect(mailsTo('manager@alerts.test')[0]?.subject).toBe('[Vandale] Silence on air');
    expect(mailsTo('programmer@alerts.test')).toEqual([]);

    // The same silence again (a redelivery, a second replica): one alert, one more occurrence.
    await publish('engine.blank.detected');
    await waitFor(
      'occurrence',
      async () => (await openAlert(alertTypes.silence))?.occurrences === 2,
    );
    expect(alertEvents.filter((e) => e.type === 'alert.raised')).toHaveLength(1);

    // Acknowledge: alert:manage only, idempotent.
    expect((await api('POST', `/alerts/${alert.id}/acknowledge`, programmer)).statusCode).toBe(403);
    const ack = await api('POST', `/alerts/${alert.id}/acknowledge`);
    expect(ack.statusCode).toBe(200);
    expect(ack.json()).toMatchObject({ status: 'open' });
    expect(ack.json().acknowledgedAt).not.toBeNull();
    expect((await api('POST', `/alerts/${alert.id}/acknowledge`)).statusCode).toBe(200);
    await waitFor('ack event', alertEvent('alert.acknowledged'));
    expect(alertEvents.filter((e) => e.type === 'alert.acknowledged')).toHaveLength(1);
    const audit = await tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'alert.acknowledge'), eq(auditLog.entityId, alert.id)));
    expect(audit).toHaveLength(1);

    await publish('engine.blank.recovered');
    const resolved = await waitFor('resolved', alertEvent('alert.resolved'));
    expect(resolved.data).toMatchObject({
      alertId: alert.id,
      status: 'resolved',
      resolution: 'recovered',
    });
    expect(await openAlert(alertTypes.silence)).toBeUndefined();
    expect((await api('POST', `/alerts/${alert.id}/acknowledge`)).statusCode).toBe(409);

    const all = await api('GET', '/alerts?status=resolved');
    expect(all.json().items.map((a: Alert) => a.id)).toContain(alert.id);
  });
});

describe('silence with an action', () => {
  it('skip: skips the item on air, warns, then escalates to critical and emails', async () => {
    await api('PATCH', '/silence-settings', manager, { action: 'skip', escalateAfterSeconds: 5 });

    await publish('engine.blank.detected');
    const raised = await waitFor('raised', alertEvent('alert.raised'));
    expect(raised.data.severity).toBe('warning');
    await waitFor('skip', () => fake.calls.includes('POST /v1/skip'));
    expect(fake.calls).not.toContain('DELETE /v1/queue');
    await waitFor('action recorded', async () => {
      const a = await openAlert(alertTypes.silence);
      return (a?.details.action as { result?: string } | undefined)?.result === 'done';
    });
    expect(outbox).toEqual([]);

    // Still silent after escalateAfterSeconds: critical, and now the email.
    const escalated = await waitFor('escalated', alertEvent('alert.escalated'), 30_000);
    expect(escalated.data).toMatchObject({ severity: 'critical', previousSeverity: 'warning' });
    await waitFor('email', () => mailsTo('manager@alerts.test').length === 1);
    expect(mailsTo('manager@alerts.test')[0]?.text).toContain('is now critical');

    await publish('engine.blank.recovered');
    await waitFor('resolved', alertEvent('alert.resolved'));
  }, 60_000);

  it('safety: clears the queue then skips; a new engine boot resolves the alert', async () => {
    await api('PATCH', '/silence-settings', manager, {
      action: 'safety',
      escalateAfterSeconds: 60,
    });

    await publish('engine.blank.detected');
    await waitFor('skip', () => fake.calls.includes('POST /v1/skip'));
    expect(fake.calls.indexOf('DELETE /v1/queue')).toBeGreaterThanOrEqual(0);
    expect(fake.calls.indexOf('DELETE /v1/queue')).toBeLessThan(
      fake.calls.indexOf('POST /v1/skip'),
    );

    await publish('engine.booted');
    const resolved = await waitFor('resolved', alertEvent('alert.resolved'));
    expect(resolved.data.resolution).toBe('engine_restarted');
  });
});

describe('engine up/down', () => {
  it('raises engine.down and resolves it when the engine is back', async () => {
    await rabbit.events.publish(
      engineEvent(scope.stationId, 'engine.down', { bootId: 'boot-1', reason: 'timeout' }),
    );
    const raised = await waitFor('raised', alertEvent('alert.raised'));
    expect(raised.data).toMatchObject({ type: alertTypes.engineDown, severity: 'critical' });
    await waitFor('email', () => mailsTo('manager@alerts.test').length === 1);
    expect(mailsTo('manager@alerts.test')[0]?.subject).toBe('[Vandale] Engine not responding');

    await rabbit.events.publish(
      engineEvent(scope.stationId, 'engine.up', { bootId: 'boot-1', version: '2.4.6' }),
    );
    const resolved = await waitFor('resolved', alertEvent('alert.resolved'));
    expect(resolved.data.resolution).toBe('engine_up');
  });

  it('ignores engines of unknown stations', async () => {
    await rabbit.events.publish(
      engineEvent('not-a-uuid', 'engine.down', { bootId: null, reason: 'x' }),
    );
    await rabbit.events.publish(
      engineEvent('0199f6a0-0000-7000-8000-0000000000ff', 'engine.down', {
        bootId: null,
        reason: 'x',
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(alertEvents).toEqual([]);
  });
});

describe('alerts api', () => {
  it('is station-scoped, pages, and resolves by hand', async () => {
    for (const n of [1, 2, 3]) {
      await app.alerts.raise(scope, {
        type: 'test.thing',
        severity: 'info',
        dedupeKey: `test.thing:${n}`,
        title: `Thing ${n}`,
      });
    }
    const page1 = await api('GET', '/alerts?type=test.thing&limit=2');
    expect(page1.json().items.map((a: Alert) => a.title)).toEqual(['Thing 3', 'Thing 2']);
    const cursor = page1.json().nextCursor;
    const page2 = await api('GET', `/alerts?type=test.thing&limit=2&before=${cursor}`);
    expect(page2.json()).toMatchObject({ items: [{ title: 'Thing 1' }], nextCursor: null });

    const id = page2.json().items[0].id;
    // Another station of the same org: not found there.
    const elsewhere = await app.inject({
      method: 'GET',
      url: `/api/v1/stations/${otherStation}/alerts/${id}`,
      headers: cookieHeader(manager),
    });
    expect(elsewhere.statusCode).toBe(404);

    const resolved = await api('POST', `/alerts/${id}/resolve`);
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ status: 'resolved', resolution: 'manual' });
    expect((await api('POST', `/alerts/${id}/resolve`)).statusCode).toBe(409);

    // A raise after the resolve opens a new alert.
    const again = await app.alerts.raise(scope, {
      type: 'test.thing',
      severity: 'warning',
      dedupeKey: 'test.thing:1',
      title: 'Thing 1',
    });
    expect(again.kind).toBe('raised');
    expect(again.alert.id).not.toBe(id);

    // A higher severity escalates the open alert; a lower one doesn't lower it.
    const up = await app.alerts.raise(scope, {
      type: 'test.thing',
      severity: 'critical',
      dedupeKey: 'test.thing:1',
      title: 'Thing 1 is worse',
    });
    expect(up).toMatchObject({ kind: 'escalated', previousSeverity: 'warning' });
    const down = await app.alerts.raise(scope, {
      type: 'test.thing',
      severity: 'info',
      dedupeKey: 'test.thing:1',
      title: 'Thing 1',
    });
    expect(down).toMatchObject({
      kind: 'repeated',
      alert: { severity: 'critical', occurrences: 3 },
    });
  });

  it('collapses concurrent raises into one alert', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.alerts.raise(scope, {
          type: 'test.race',
          severity: 'warning',
          dedupeKey: 'test.race',
          title: 'Race',
        }),
      ),
    );
    expect(results.filter((r) => r.kind === 'raised')).toHaveLength(1);
    expect(new Set(results.map((r) => r.alert.id)).size).toBe(1);
    expect((await openAlert('test.race'))?.occurrences).toBe(8);
  });
});
