import {
  addMembership,
  alertNotification,
  auditLog,
  createOrganization,
  createStation,
  type OrgScope,
  type StationScope,
  station,
  unsafeScope,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import {
  type Actor,
  type Alert,
  type AlertRealtimeEvent,
  alertRealtimeEventSchema,
  alertTypes,
  type EngineRealtimeEvent,
} from '@ondes/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AppOptions, buildApp } from '../../app.ts';
import { createMemoryMailer, type MailMessage } from '../../plugins/mail.ts';
import { cookieHeader, signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../auth/testing.ts';
import { createEngineAdapter } from '../engine/adapter/index.ts';
import { type FakeEngine, startFakeEngine } from '../engine/adapter/testing/fake-engine.ts';
import { createEngineAlerts } from './engine-alerts.ts';
import { createTestRabbit, engineEvent, sleep, testPrefix, waitFor } from './testing.ts';

// Alerts end to end: engine events go through the real RabbitMQ events exchange into the
// durable alerts queue, which raises / reopens / escalates / resolves alerts, runs the silence
// action against a fake engine, emails the station's managers through the `alert-email` job
// and publishes alert.* events. Needs `pnpm dev:up` (Postgres, RabbitMQ).

const system: Actor = { type: 'system', name: 'test' };

let tdb: TestDatabase;
let rabbit: Awaited<ReturnType<typeof createTestRabbit>>;
let fake: FakeEngine;
let app: FastifyInstance;
let outbox: MailMessage[];
let orgScope: OrgScope;
let manager: { userId: string; cookie: string };
let programmer: { userId: string; cookie: string };
const alertEvents: AlertRealtimeEvent[] = [];

/** One fake engine for every station of the test: its calls are counted per test. */
async function startApp(r: Awaited<ReturnType<typeof createTestRabbit>>, withEngine: boolean) {
  const mailer = createMemoryMailer();
  const adapter = createEngineAdapter({ stationId: 'x', baseUrl: fake.url, token: 'tok' });
  const options: AppOptions = {
    db: { client: tdb },
    rabbit: { rabbit: r },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    alerts: {
      // Async, like #35's `engineLifecycle.adapterFor`.
      engineFor: withEngine ? async () => adapter : undefined,
      sweepIntervalMs: 100,
      // The fake engine is never blank: keep the reconcile out of the way (tested on its own).
      reconcileQuietMs: 3_600_000,
    },
    fastify: { logger: false },
  };
  const instance = await buildApp(options);
  await instance.ready();
  return { app: instance, outbox: mailer.outbox };
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  rabbit = await createTestRabbit();
  fake = await startFakeEngine({ token: 'tok' });
  ({ app, outbox } = await startApp(rabbit, true));

  const sub = rabbit.subscribeEvents((raw) => {
    const parsed = alertRealtimeEventSchema.safeParse(raw);
    if (parsed.success) alertEvents.push(parsed.data);
  });
  await sub.ready;

  const org = await createOrganization(tdb.db, system, { slug: 'alerts', name: 'Alerts' });
  orgScope = unsafeScope(org.id);
  const t = { app, tdb, outbox } as unknown as TestApp;
  manager = await signUpAndLogin(t, 'manager@alerts.test');
  programmer = await signUpAndLogin(t, 'programmer@alerts.test');
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

let stations = 0;
/** A fresh station (tests don't reopen each other's alerts), with a manager and a programmer. */
async function newStation(engineSettings: Record<string, unknown> = {}) {
  stations++;
  const ctx = { actor: system, scope: orgScope };
  const st = await createStation(tdb.db, ctx, {
    slug: `vandale-${stations}`,
    name: 'Vandale',
    timezone: 'Europe/Paris',
    engineSettings,
  });
  for (const [who, role] of [
    [manager, 'station_manager'],
    [programmer, 'programmer'],
  ] as const) {
    await addMembership(tdb.db, ctx, {
      level: 'station',
      userId: who.userId,
      stationId: st.id,
      role,
    });
  }
  const scope: StationScope = unsafeScope(orgScope.orgId, st.id);
  let seq = 0;
  const base = `/api/v1/stations/${st.id}`;
  return {
    scope,
    api: (
      method: 'GET' | 'POST' | 'PATCH',
      url: string,
      cookie = manager.cookie,
      payload?: object,
    ) => app.inject({ method, url: `${base}${url}`, headers: cookieHeader(cookie), payload }),
    /** Publishes an engine event; returns it (to republish it as a redelivery). */
    async engine(
      type: 'engine.blank.detected' | 'engine.blank.recovered' | 'engine.booted',
      options: { at?: Date; bootId?: string } = {},
    ): Promise<EngineRealtimeEvent> {
      seq++;
      const bootId = options.bootId ?? 'boot-1';
      const data = type === 'engine.booted' ? { bootId, seq, version: '2.4.6' } : { bootId, seq };
      const event = engineEvent(st.id, type, data as never, options.at);
      await rabbit.events.publish(event);
      return event;
    },
  };
}
type Station = Awaited<ReturnType<typeof newStation>>;

async function alertsOf(s: Station, query = 'status=all'): Promise<Alert[]> {
  const res = await s.api('GET', `/alerts?${query}`);
  expect(res.statusCode).toBe(200);
  return res.json().items;
}

const openSilence = async (s: Station) =>
  (await alertsOf(s, `type=${alertTypes.silence}`))[0] as Alert | undefined;

const eventOf =
  <T extends AlertRealtimeEvent['type']>(type: T, s: Station) =>
  () =>
    alertEvents.find(
      (e): e is Extract<AlertRealtimeEvent, { type: T }> =>
        e.type === type && e.stationId === s.scope.stationId,
    );

const countOf = (type: AlertRealtimeEvent['type'], s: Station) =>
  alertEvents.filter((e) => e.type === type && e.stationId === s.scope.stationId).length;

const mailsTo = (email: string) => outbox.filter((m) => m.to === email);
const skips = () => fake.calls.filter((c) => c === 'POST /v1/skip').length;
const ago = (ms: number) => new Date(Date.now() - ms);

describe('silence settings', () => {
  it('only alert:manage changes them; a partial PATCH keeps the other fields', async () => {
    const s = await newStation({ crossfade: { duration: 2 } });
    expect((await s.api('GET', '/silence-settings', programmer.cookie)).json()).toEqual({
      maxSeconds: 10,
      thresholdDb: -40,
      action: 'skip',
      escalateAfterSeconds: 60,
    });
    const patch = (body: object, cookie = manager.cookie) =>
      s.api('PATCH', '/silence-settings', cookie, body);
    expect((await patch({ action: 'none' }, programmer.cookie)).statusCode).toBe(403);
    expect((await patch({ thresholdDb: 3 })).statusCode).toBe(400);
    expect((await patch({})).statusCode).toBe(400);

    await patch({ maxSeconds: 4, escalateAfterSeconds: 30 });
    const ok = await patch({ action: 'none' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      maxSeconds: 4,
      thresholdDb: -40,
      action: 'none',
      escalateAfterSeconds: 30,
    });
    expect((await patch({ thresholdDb: -50 })).json()).toEqual({
      maxSeconds: 4,
      thresholdDb: -50,
      action: 'none',
      escalateAfterSeconds: 30,
    });

    // Threshold and duration live in the station's engine settings, which the engine is
    // rendered from (#35); the other engine settings are left alone.
    const [st] = await tdb.db
      .select({ engineSettings: station.engineSettings })
      .from(station)
      .where(eq(station.id, s.scope.stationId));
    expect(st?.engineSettings).toEqual({
      crossfade: { duration: 2 },
      blank: { maxSeconds: 4, thresholdDb: -50 },
    });
    const event = await waitFor('settings event', eventOf('alert.silence_settings.updated', s));
    expect(event.data).toMatchObject({ maxSeconds: 4 });
    const audit = await tdb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'silence_setting.update'),
          eq(auditLog.stationId, s.scope.stationId),
        ),
      );
    expect(audit).toHaveLength(3);
  });
});

describe('silence with action none', () => {
  it('raises a critical alert, emails managers, dedupes, acknowledges and resolves', async () => {
    const s = await newStation();
    await s.api('PATCH', '/silence-settings', manager.cookie, { action: 'none' });

    const detected = await s.engine('engine.blank.detected');
    const raised = await waitFor('raised', eventOf('alert.raised', s));
    expect(raised.data).toMatchObject({
      type: alertTypes.silence,
      severity: 'critical',
      action: null,
    });
    const alert = await waitFor('alert row', () => openSilence(s));
    expect(alert).toMatchObject({ status: 'open', occurrences: 1, action: null });

    // Station managers get the email (the alert-email job); programmers (alert:read) don't.
    await waitFor('email', () => mailsTo('manager@alerts.test').length === 1);
    expect(mailsTo('manager@alerts.test')[0]?.subject).toBe('[Vandale] Silence on air');
    expect(mailsTo('programmer@alerts.test')).toEqual([]);

    // The same event again (a redelivery) changes nothing; another detection counts.
    await rabbit.events.publish(detected);
    await s.engine('engine.blank.detected');
    await waitFor('occurrence', async () => (await openSilence(s))?.occurrences === 2);
    await sleep(300);
    expect((await openSilence(s))?.occurrences).toBe(2);
    expect(countOf('alert.raised', s)).toBe(1);
    expect(skips()).toBe(0);

    // Acknowledge: alert:manage only, idempotent, audited once.
    const ackUrl = `/alerts/${alert.id}/acknowledge`;
    expect((await s.api('POST', ackUrl, programmer.cookie)).statusCode).toBe(403);
    const ack = await s.api('POST', ackUrl);
    expect(ack.statusCode).toBe(200);
    expect(ack.json()).toMatchObject({ status: 'open', acknowledgedBy: manager.userId });
    expect((await s.api('POST', ackUrl)).statusCode).toBe(200);
    await waitFor('ack event', eventOf('alert.acknowledged', s));
    expect(countOf('alert.acknowledged', s)).toBe(1);
    const audit = await tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'alert.acknowledge'), eq(auditLog.entityId, alert.id)));
    expect(audit).toHaveLength(1);

    await s.engine('engine.blank.recovered');
    const resolved = await waitFor('resolved', eventOf('alert.resolved', s));
    expect(resolved.data).toMatchObject({
      alertId: alert.id,
      status: 'resolved',
      resolution: 'recovered',
    });
    expect(await openSilence(s)).toBeUndefined();
    expect((await s.api('POST', ackUrl)).statusCode).toBe(409);
  });
});

describe('silence with an action', () => {
  it('skip: skips once, warns, then escalates to critical and emails', async () => {
    const s = await newStation();
    await s.api('PATCH', '/silence-settings', manager.cookie, {
      action: 'skip',
      escalateAfterSeconds: 5,
    });

    const detected = await s.engine('engine.blank.detected');
    const raised = await waitFor('raised', eventOf('alert.raised', s));
    expect(raised.data.severity).toBe('warning');
    await waitFor('action done', async () => (await openSilence(s))?.action?.state === 'done');
    expect(skips()).toBe(1);
    expect(fake.calls).not.toContain('DELETE /v1/queue');
    expect((await openSilence(s))?.action).toMatchObject({ name: 'engine.skip', attempts: 1 });

    // A redelivered detection never skips twice.
    await rabbit.events.publish(detected);
    await sleep(300);
    expect(skips()).toBe(1);
    expect(outbox).toEqual([]);

    // Still silent after escalateAfterSeconds: critical, and now the email. A done action
    // isn't repeated.
    const escalated = await waitFor('escalated', eventOf('alert.escalated', s), 30_000);
    expect(escalated.data).toMatchObject({ severity: 'critical', previousSeverity: 'warning' });
    await waitFor('email', () => mailsTo('manager@alerts.test').length === 1);
    expect(mailsTo('manager@alerts.test')[0]?.text).toContain('is now critical');
    expect(skips()).toBe(1);

    await s.engine('engine.blank.recovered');
    await waitFor('resolved', eventOf('alert.resolved', s));
  }, 60_000);

  it('acknowledged: escalation raises the severity but sends no email', async () => {
    const s = await newStation();
    await s.api('PATCH', '/silence-settings', manager.cookie, {
      action: 'skip',
      escalateAfterSeconds: 5,
    });
    await s.engine('engine.blank.detected');
    const alert = await waitFor('alert', () => openSilence(s));
    expect((await s.api('POST', `/alerts/${alert.id}/acknowledge`)).statusCode).toBe(200);

    await waitFor('escalated', eventOf('alert.escalated', s), 30_000);
    expect((await openSilence(s))?.severity).toBe('critical');
    await sleep(1000);
    expect(outbox).toEqual([]);
  }, 60_000);

  it('safety: clears the queue then skips; a new engine boot resolves the alert', async () => {
    const s = await newStation();
    await s.api('PATCH', '/silence-settings', manager.cookie, { action: 'safety' });

    await s.engine('engine.blank.detected');
    await waitFor('skip', () => skips() === 1);
    const cleared = fake.calls.indexOf('DELETE /v1/queue');
    expect(cleared).toBeGreaterThanOrEqual(0);
    expect(cleared).toBeLessThan(fake.calls.indexOf('POST /v1/skip'));

    await s.engine('engine.booted', { bootId: 'boot-2' });
    const resolved = await waitFor('resolved', eventOf('alert.resolved', s));
    expect(resolved.data.resolution).toBe('engine_restarted');
  });
});

describe('late and out-of-order events', () => {
  it('a detection older than the last recovery neither reopens nor skips', async () => {
    const s = await newStation();
    await s.engine('engine.blank.detected', { at: ago(3000) });
    await waitFor('action done', async () => (await openSilence(s))?.action?.state === 'done');
    await s.engine('engine.blank.recovered', { at: ago(1000) });
    await waitFor('resolved', eventOf('alert.resolved', s));

    // Delivered late: observed before the recovery.
    await s.engine('engine.blank.detected', { at: ago(2000) });
    await sleep(500);
    expect(await openSilence(s)).toBeUndefined();
    expect(countOf('alert.reopened', s)).toBe(0);
    expect(skips()).toBe(1);
  });

  it('a recovery older than the detection leaves the alert open', async () => {
    const s = await newStation();
    await s.api('PATCH', '/silence-settings', manager.cookie, { action: 'none' });
    await s.engine('engine.blank.detected', { at: ago(1000) });
    await waitFor('raised', eventOf('alert.raised', s));
    await s.engine('engine.blank.recovered', { at: ago(2000) });
    await sleep(500);
    expect((await openSilence(s))?.status).toBe('open');
    expect(countOf('alert.resolved', s)).toBe(0);
  });

  it('events of an older engine boot are ignored', async () => {
    const s = await newStation();
    await s.engine('engine.booted', { bootId: 'boot-new', at: ago(1000) });
    await s.engine('engine.blank.detected', { bootId: 'boot-old', at: ago(2000) });
    await sleep(500);
    expect(await alertsOf(s)).toEqual([]);

    // The new boot's own detection does raise.
    await s.engine('engine.blank.detected', { bootId: 'boot-new' });
    await waitFor('raised', eventOf('alert.raised', s));
  });
});

describe('flapping', () => {
  it('reopens the alert within the window without a second email; cooldown across alerts', async () => {
    const s = await newStation();
    await s.api('PATCH', '/silence-settings', manager.cookie, { action: 'none' });
    await s.engine('engine.blank.detected');
    const first = await waitFor('raised', eventOf('alert.raised', s));
    await waitFor('email', () => mailsTo('manager@alerts.test').length === 1);
    await s.engine('engine.blank.recovered');
    await waitFor('resolved', eventOf('alert.resolved', s));

    await s.engine('engine.blank.detected');
    const reopened = await waitFor('reopened', eventOf('alert.reopened', s));
    expect(reopened.data).toMatchObject({
      alertId: first.data.alertId,
      status: 'open',
      occurrences: 2,
    });
    expect(await alertsOf(s)).toHaveLength(1);
    await sleep(1000);
    expect(mailsTo('manager@alerts.test')).toHaveLength(1);

    // Another critical alert of the same (station, type) within the cooldown: no email.
    const other = await app.alerts.raise(s.scope, {
      type: alertTypes.silence,
      severity: 'critical',
      dedupeKey: 'engine.silence:other',
      title: 'Other silence',
    });
    const otherId = 'alert' in other ? other.alert.id : '';
    await waitFor('suppressed', async () => {
      const [row] = await tdb.db
        .select()
        .from(alertNotification)
        .where(eq(alertNotification.alertId, otherId));
      return row?.status === 'suppressed' && row.reason === 'cooldown';
    });
    expect(mailsTo('manager@alerts.test')).toHaveLength(1);
  });
});

describe('two api replicas', () => {
  it('the replica holding the engine runs the action, once', async () => {
    const prefix = testPrefix();
    const ra = await createTestRabbit(prefix);
    const rb = await createTestRabbit(prefix);
    // A starts first: it is the alerts queue's active consumer, and holds no engine.
    const a = await startApp(ra, false);
    const b = await startApp(rb, true);
    try {
      const s = await newStation();
      await ra.events.publish(
        engineEvent(s.scope.stationId, 'engine.blank.detected', { bootId: 'boot-1', seq: 1 }),
      );
      await waitFor('action done', async () => (await openSilence(s))?.action?.state === 'done');
      expect(skips()).toBe(1);
      expect((await openSilence(s))?.action).toMatchObject({ attempts: 1 });
    } finally {
      await b.app.close();
      await a.app.close();
      await rb.close({ cleanup: false });
      await ra.close();
    }
  }, 60_000);
});

describe('reconcile', () => {
  it('resolves engine alerts the engine no longer has (a lost recovery)', async () => {
    const s = await newStation();
    await s.api('PATCH', '/silence-settings', manager.cookie, { action: 'none' });
    await s.engine('engine.blank.detected');
    await waitFor('raised', eventOf('alert.raised', s));

    const adapter = createEngineAdapter({
      stationId: fake.stationId,
      baseUrl: fake.url,
      token: 'tok',
    });
    const engineAlerts = createEngineAlerts({
      db: tdb.db,
      alerts: app.alerts,
      engineFor: () => adapter,
      logger: app.log,
    });
    // The fake engine isn't blank: the recovery was missed.
    expect(await engineAlerts.reconcile(0)).toBeGreaterThanOrEqual(1);
    const [alert] = await alertsOf(s);
    expect(alert).toMatchObject({ status: 'resolved', resolution: 'reconciled' });
  });
});

describe('engine up/down', () => {
  it('raises engine.down and resolves it when the engine is back', async () => {
    const s = await newStation();
    await rabbit.events.publish(
      engineEvent(s.scope.stationId, 'engine.down', { bootId: 'boot-1', reason: 'timeout' }),
    );
    const raised = await waitFor('raised', eventOf('alert.raised', s));
    expect(raised.data).toMatchObject({ type: alertTypes.engineDown, severity: 'critical' });
    await waitFor('email', () => mailsTo('manager@alerts.test').length === 1);
    expect(mailsTo('manager@alerts.test')[0]?.subject).toBe('[Vandale] Engine not responding');

    await rabbit.events.publish(
      engineEvent(s.scope.stationId, 'engine.up', { bootId: 'boot-1', version: '2.4.6' }),
    );
    const resolved = await waitFor('resolved', eventOf('alert.resolved', s));
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
    await sleep(300);
    expect(alertEvents).toEqual([]);
  });
});

describe('alerts api', () => {
  it('is station-scoped, pages, and resolves by hand', async () => {
    const s = await newStation();
    const other = await newStation();
    for (const n of [1, 2, 3]) {
      await app.alerts.raise(s.scope, {
        type: 'test.thing',
        severity: 'info',
        dedupeKey: `test.thing:${n}`,
        title: `Thing ${n}`,
      });
    }
    const page1 = await s.api('GET', '/alerts?type=test.thing&limit=2');
    expect(page1.json().items.map((a: Alert) => a.title)).toEqual(['Thing 3', 'Thing 2']);
    const cursor = page1.json().nextCursor;
    const page2 = await s.api('GET', `/alerts?type=test.thing&limit=2&before=${cursor}`);
    expect(page2.json()).toMatchObject({ items: [{ title: 'Thing 1' }], nextCursor: null });

    const id = page2.json().items[0].id;
    // Another station of the same org: not found there.
    expect((await other.api('GET', `/alerts/${id}`)).statusCode).toBe(404);

    const resolved = await s.api('POST', `/alerts/${id}/resolve`);
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ status: 'resolved', resolution: 'manual' });
    expect((await s.api('POST', `/alerts/${id}/resolve`)).statusCode).toBe(409);

    // Raised again within the reopen window: the same alert reopens.
    const again = await app.alerts.raise(s.scope, {
      type: 'test.thing',
      severity: 'warning',
      dedupeKey: 'test.thing:1',
      title: 'Thing 1',
    });
    expect(again).toMatchObject({
      kind: 'reopened',
      alert: { id, status: 'open', severity: 'warning' },
    });

    // A higher severity escalates the open alert; a lower one doesn't lower it.
    const up = await app.alerts.raise(s.scope, {
      type: 'test.thing',
      severity: 'critical',
      dedupeKey: 'test.thing:1',
      title: 'Thing 1 is worse',
    });
    expect(up).toMatchObject({ kind: 'escalated', previousSeverity: 'warning' });
    const down = await app.alerts.raise(s.scope, {
      type: 'test.thing',
      severity: 'info',
      dedupeKey: 'test.thing:1',
      title: 'Thing 1',
    });
    expect(down).toMatchObject({
      kind: 'repeated',
      alert: { severity: 'critical', occurrences: 4 },
    });
  });

  it('collapses concurrent raises into one alert', async () => {
    const s = await newStation();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.alerts.raise(s.scope, {
          type: 'test.race',
          severity: 'warning',
          dedupeKey: 'test.race',
          title: 'Race',
        }),
      ),
    );
    expect(results.filter((r) => r.kind === 'raised')).toHaveLength(1);
    expect(new Set(results.map((r) => ('alert' in r ? r.alert.id : null))).size).toBe(1);
    expect((await alertsOf(s, 'type=test.race'))[0]?.occurrences).toBe(8);
  });
});
