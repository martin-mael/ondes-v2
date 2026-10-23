import { randomUUID } from 'node:crypto';
import {
  addMembership,
  createOrganization,
  createStation,
  island,
  islandUpdatedEvent,
  logDay,
  logItem,
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
  type RaiseAlert,
} from '@ondes/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { createMemoryMailer } from '../../plugins/mail.ts';
import { cookieHeader, signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../auth/testing.ts';
import { createEngineAlerts } from './engine-alerts.ts';
import { createIslandAlerts, islandAlertKey } from './island-alerts.ts';
import { createTestRabbit, engineEvent, waitFor } from './testing.ts';

// The dashboard's alert types (#71), one test each: what raises it, that it reaches the
// browsers' fanout (`alert.raised`, relayed over SSE) within 5 s, that the list shows it and
// that it resolves. Needs `pnpm dev:up` (Postgres, RabbitMQ).

const system: Actor = { type: 'system', name: 'test' };
/** The acceptance criterion: an alert is on the dashboard within 5 s of its cause. */
const VISIBLE_WITHIN_MS = 5_000;

let tdb: TestDatabase;
let rabbit: Awaited<ReturnType<typeof createTestRabbit>>;
let app: FastifyInstance;
let cookie: string;
let userId: string;
let orgId: string;
const alertEvents: Array<AlertRealtimeEvent & { receivedAt: number }> = [];

beforeAll(async () => {
  tdb = await createTestDatabase();
  rabbit = await createTestRabbit();
  const mailer = createMemoryMailer();
  app = await buildApp({
    db: { client: tdb },
    rabbit: { rabbit },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    alerts: { sweepIntervalMs: 0 },
    fastify: { logger: false },
  });
  await app.ready();
  const sub = rabbit.subscribeEvents((raw) => {
    const parsed = alertRealtimeEventSchema.safeParse(raw);
    if (parsed.success) alertEvents.push({ ...parsed.data, receivedAt: Date.now() });
  });
  await sub.ready;
  const org = await createOrganization(tdb.db, system, { slug: 'health', name: 'Health' });
  orgId = org.id;
  ({ userId, cookie } = await signUpAndLogin(
    { app, tdb, outbox: mailer.outbox } as unknown as TestApp,
    'manager@health.test',
  ));
}, 60_000);

afterAll(async () => {
  await app?.close();
  await rabbit?.close();
  await tdb?.drop();
}, 60_000);

beforeEach(() => {
  alertEvents.length = 0;
});

let stations = 0;
async function newStation() {
  stations++;
  const ctx = { actor: system, scope: unsafeScope(orgId) };
  const st = await createStation(tdb.db, ctx, {
    slug: `health-${stations}`,
    name: 'Health',
    timezone: 'Europe/Paris',
  });
  await addMembership(tdb.db, ctx, {
    level: 'station',
    userId,
    stationId: st.id,
    role: 'station_manager',
  });
  const scope: StationScope = unsafeScope(orgId, st.id);
  return {
    scope,
    async alerts(query = 'status=all'): Promise<Alert[]> {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/stations/${st.id}/alerts?${query}`,
        headers: cookieHeader(cookie),
      });
      expect(res.statusCode).toBe(200);
      return res.json().items;
    },
  };
}
type Station = Awaited<ReturnType<typeof newStation>>;

/** Waits for the station's `alert.*` event of `type` and checks it came within 5 s of `since`. */
async function seen(
  s: Station,
  type: Exclude<AlertRealtimeEvent['type'], 'alert.silence_settings.updated'>,
  alertType: string,
  since: number,
) {
  const event = await waitFor(`${type} ${alertType}`, () =>
    alertEvents.find(
      (e): e is Extract<typeof e, { data: { alertId: string } }> =>
        e.type === type &&
        e.stationId === s.scope.stationId &&
        (e.data as { type?: string }).type === alertType,
    ),
  );
  expect(event.receivedAt - since).toBeLessThan(VISIBLE_WITHIN_MS);
  return event;
}

describe('silence (engine.silence)', () => {
  it('a blank output raises it within 5 s; recovery resolves it', async () => {
    const s = await newStation();
    const since = Date.now();
    await rabbit.events.publish(
      engineEvent(s.scope.stationId, 'engine.blank.detected', { bootId: 'b1', seq: 1 }),
    );
    await seen(s, 'alert.raised', alertTypes.silence, since);
    expect((await s.alerts('status=open'))[0]).toMatchObject({ type: alertTypes.silence });
    await rabbit.events.publish(
      engineEvent(s.scope.stationId, 'engine.blank.recovered', { bootId: 'b1', seq: 2 }),
    );
    await seen(s, 'alert.resolved', alertTypes.silence, since);
  }, 30_000);
});

describe('engine restarts (engine.restarted)', () => {
  const restarted = (s: Station, inWindow: number, crashed = false) =>
    engineEvent(s.scope.stationId, 'engine.restarted', {
      bootId: 'b1',
      restarts: 1,
      inWindow,
      windowSeconds: 600,
      crashed,
    });

  it('a crash restart raises a warning within 5 s, counts repeats, resolves once stable', async () => {
    const s = await newStation();
    const since = Date.now();
    await rabbit.events.publish(restarted(s, 1));
    await seen(s, 'alert.raised', alertTypes.engineRestarted, since);
    await rabbit.events.publish(restarted(s, 2, true));
    const alert = await waitFor('second restart counted', async () => {
      const [a] = await s.alerts(`status=all&type=${alertTypes.engineRestarted}`);
      return a && a.occurrences === 2 ? a : undefined;
    });
    expect(alert).toMatchObject({
      severity: 'warning',
      status: 'open',
      details: { inWindow: 2, crashed: true },
    });

    // Not stable yet with the default 30 min; with 0 it is.
    const engineAlerts = (restartStableMs: number) =>
      createEngineAlerts({ db: tdb.db, alerts: app.alerts, restartStableMs, logger: app.log });
    await engineAlerts(30 * 60_000).reconcile();
    expect((await s.alerts(`status=all&type=${alertTypes.engineRestarted}`))[0]?.status).toBe(
      'open',
    );
    await engineAlerts(0).reconcile();
    expect((await s.alerts(`status=all&type=${alertTypes.engineRestarted}`))[0]).toMatchObject({
      status: 'resolved',
      resolution: 'stable',
    });
  }, 30_000);
});

describe('failed renders (island.render_failed)', () => {
  let days = 0;
  /** A log item airing in `inMs` and an island headed by it (each on its own log day). */
  async function islandAiring(
    s: Station,
    inMs: number,
    extra: Partial<typeof island.$inferInsert>,
  ) {
    const start = Date.now() + inMs;
    const [day] = await tdb.db
      .insert(logDay)
      .values({
        orgId,
        stationId: s.scope.stationId,
        localDate: `2026-11-${String(++days).padStart(2, '0')}`,
        startsAt: new Date(start - 3_600_000),
        endsAt: new Date(start + 3_600_000),
        status: 'published',
      })
      .returning();
    if (!day) throw new Error('no day');
    const [head] = await tdb.db
      .insert(logItem)
      .values({
        orgId,
        stationId: s.scope.stationId,
        logDayId: day.id,
        position: 0,
        kind: 'song',
        plannedStart: new Date(start),
        plannedDurationMs: 180_000,
        originType: 'manual',
      })
      .returning();
    if (!head) throw new Error('no item');
    const [row] = await tdb.db
      .insert(island)
      .values({
        orgId,
        stationId: s.scope.stationId,
        headItemId: head.id,
        headAssetId: randomUUID(),
        headJoinSample: 0,
        headHasBody: true,
        tailItemId: randomUUID(),
        tailAssetId: randomUUID(),
        tailJoinSample: 0,
        tailHasBody: true,
        itemIds: [head.id],
        segueIds: [randomUUID()],
        specVersion: 1,
        spec: {} as never,
        files: {},
        hash: randomUUID().replaceAll('-', ''),
        lengthSamples: 44_100,
        ...extra,
      })
      .returning();
    if (!row) throw new Error('no island');
    return row;
  }

  it('a final failure raises it within 5 s; a retry does not; a render resolves it', async () => {
    const s = await newStation();
    // Transient: the renderer retries it, no alert.
    const retrying = await islandAiring(s, 3_600_000, {
      status: 'failed',
      error: 'S3 timeout',
      retryAt: new Date(Date.now() + 60_000),
    });
    await rabbit.events.publish(islandUpdatedEvent(retrying));

    const since = Date.now();
    const failed = await islandAiring(s, 3_600_000, {
      status: 'failed',
      error: 'source is not a 44.1 kHz FLAC',
    });
    await rabbit.events.publish(islandUpdatedEvent(failed));
    const raised = await seen(s, 'alert.raised', alertTypes.islandRenderFailed, since);
    expect(raised.data).toMatchObject({ dedupeKey: islandAlertKey(failed.id) });
    const open = await s.alerts(`status=all&type=${alertTypes.islandRenderFailed}`);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      severity: 'warning',
      details: { islandId: failed.id, error: 'source is not a 44.1 kHz FLAC' },
    });

    const [ready] = await tdb.db
      .update(island)
      .set({
        status: 'ready',
        error: null,
        storageKey: 'islands/x.flac',
        fileSha256: 'a'.repeat(64),
        fileSizeBytes: 1,
        renderedAt: new Date(),
      })
      .where(eq(island.id, failed.id))
      .returning();
    if (!ready) throw new Error('no island');
    await rabbit.events.publish(islandUpdatedEvent(ready));
    await seen(s, 'alert.resolved', alertTypes.islandRenderFailed, since);
    expect((await s.alerts(`status=all&type=${alertTypes.islandRenderFailed}`))[0]).toMatchObject({
      status: 'resolved',
      resolution: 'rendered',
    });
  }, 30_000);

  it('the reconcile raises one whose event was lost and closes one whose slot is over', async () => {
    const s = await newStation();
    const islands = createIslandAlerts({ db: tdb.db, alerts: app.alerts, logger: app.log });
    const lost = await islandAiring(s, 600_000, { status: 'failed', error: 'bad source' });
    const aired = await islandAiring(s, -3_600_000, { status: 'failed', error: 'bad source' });
    await islands.reconcile();
    const open = await s.alerts(`status=open&type=${alertTypes.islandRenderFailed}`);
    expect(open.map((a) => a.details.islandId)).toEqual([lost.id]);
    expect(open.map((a) => a.details.islandId)).not.toContain(aired.id);

    // Its item airs and ends: the alert closes.
    await tdb.db
      .update(logItem)
      .set({ plannedStart: new Date(Date.now() - 3_600_000) })
      .where(eq(logItem.id, lost.headItemId));
    await islands.reconcile();
    expect((await s.alerts(`status=all&type=${alertTypes.islandRenderFailed}`))[0]).toMatchObject({
      status: 'resolved',
      resolution: 'slot_over',
    });
  }, 30_000);
});

// Missing episodes (#47) and uncached items (#31) are raised by their own modules: their
// conditions are tested there (shows/episode-check/episode-check.int.test.ts,
// cache/cache.int.test.ts). Here: that what they raise reaches the fanout within 5 s, and that
// acknowledging works on them.
describe.each([
  {
    name: 'missing episode',
    raise: (slotId: string): RaiseAlert => ({
      type: alertTypes.episodeMissing,
      severity: 'warning',
      dedupeKey: `${alertTypes.episodeMissing}:${slotId}:2026-10-24`,
      title: 'Episode missing',
      details: {
        slotId,
        occurrenceDate: '2026-10-24',
        i18n: { key: 'episodeMissing.ahead', params: { show: 'Morning', lead: '6h' } },
      },
    }),
  },
  {
    name: 'uncached item',
    raise: (itemId: string): RaiseAlert => ({
      type: alertTypes.cacheItemMissing,
      severity: 'critical',
      dedupeKey: `${alertTypes.cacheItemMissing}:${itemId}`,
      title: 'Log item not cached',
      details: { logItemId: itemId },
    }),
  },
])('$name', ({ raise }) => {
  it('is visible within 5 s and can be acknowledged', async () => {
    const s = await newStation();
    const since = Date.now();
    const input = raise(randomUUID());
    await app.alerts.raise(s.scope, input);
    const event = await seen(s, 'alert.raised', input.type, since);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/stations/${s.scope.stationId}/alerts/${event.data.alertId}/acknowledge`,
      headers: cookieHeader(cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ acknowledgedBy: userId, status: 'open' });
    await seen(s, 'alert.acknowledged', input.type, since);
  }, 30_000);
});
