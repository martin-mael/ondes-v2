import { randomBytes } from 'node:crypto';
import {
  addMembership,
  alert,
  createAsset,
  createOrganization,
  createStation,
  logDay,
  logItem,
  markCacheFileFailed,
  markCacheFileReady,
  type OrgScope,
  putAssetFile,
  recordCachePass,
  recordCachePassFailure,
  type StationScope,
  unsafeScope,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import { defaultIdempotencyKey } from '@ondes/queue';
import type { Actor, CacheStatus, JobEnvelope } from '@ondes/shared';
import { contentKey } from '@ondes/storage';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { createMemoryMailer } from '../../plugins/mail.ts';
import { createTestRabbit } from '../alerts/testing.ts';
import { cookieHeader, signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../auth/testing.ts';
import { createPlayoutCache } from './service.ts';

// The api side of the playout cache (#31): readiness, the station endpoint and the cache
// alerts, from the tables the worker keeps (written here directly). Postgres only.

const system: Actor = { type: 'system', name: 'test' };
const HOUR = 3_600_000;

let tdb: TestDatabase;
let app: FastifyInstance;
let orgScope: OrgScope;
let manager: { userId: string; cookie: string };
let outsider: { userId: string; cookie: string };

beforeAll(async () => {
  tdb = await createTestDatabase();
  const mailer = createMemoryMailer();
  app = await buildApp({
    db: { client: tdb },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    alerts: { sweepIntervalMs: 0 },
    cache: { alertIntervalMs: 0 },
    fastify: { logger: false },
  });
  await app.ready();
  const org = await createOrganization(tdb.db, system, { slug: 'cache', name: 'Cache' });
  orgScope = unsafeScope(org.id);
  const t = { app, tdb, outbox: mailer.outbox } as unknown as TestApp;
  manager = await signUpAndLogin(t, 'manager@cache.test');
  outsider = await signUpAndLogin(t, 'outsider@cache.test');
}, 60_000);

afterAll(async () => {
  await app?.close();
  await tdb?.drop();
});

let stations = 0;
async function newStation() {
  stations++;
  const ctx = { actor: system, scope: orgScope };
  const st = await createStation(tdb.db, ctx, {
    slug: `cache-${stations}`,
    name: 'FM',
    timezone: 'Europe/Paris',
  });
  await addMembership(tdb.db, ctx, {
    level: 'station',
    userId: manager.userId,
    stationId: st.id,
    role: 'viewer',
  });
  return unsafeScope(orgScope.orgId, st.id);
}

async function file(scope: StationScope) {
  const sha256 = randomBytes(32).toString('hex');
  const ctx = { actor: system, scope };
  const asset = await createAsset(tdb.db, ctx, { type: 'song', title: sha256.slice(0, 6) });
  const { file } = await putAssetFile(tdb.db, ctx, asset.id, {
    role: 'playout',
    storageKey: contentKey({ orgId: scope.orgId, sha256, ext: 'flac' }),
    sha256,
    sizeBytes: 1000,
    codec: 'flac',
    sampleRate: 44_100,
    flacBlockSize: 1024,
  });
  return { assetId: asset.id, assetFileId: file.id, sha256 };
}

async function log(
  scope: StationScope,
  now: number,
  items: Array<{ assetId: string; at: number }>,
): Promise<string[]> {
  const [day] = await tdb.db
    .insert(logDay)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      localDate: '2026-06-10',
      startsAt: new Date(now - 12 * HOUR),
      endsAt: new Date(now + 12 * HOUR),
    })
    .returning();
  if (!day) throw new Error('no day');
  const rows = await tdb.db
    .insert(logItem)
    .values(
      items.map((it, position) => ({
        orgId: scope.orgId,
        stationId: scope.stationId,
        logDayId: day.id,
        position,
        kind: 'song' as const,
        plannedStart: new Date(now + it.at),
        plannedDurationMs: 180_000,
        assetId: it.assetId,
        originType: 'manual' as const,
      })),
    )
    .returning({ id: logItem.id });
  return rows.map((r) => r.id);
}

async function resolution(scope: StationScope, dedupeKey: string) {
  const [row] = await tdb.db
    .select({ resolution: alert.resolution })
    .from(alert)
    .where(and(eq(alert.stationId, scope.stationId), eq(alert.dedupeKey, dedupeKey)));
  return row?.resolution;
}

async function openAlerts(scope: StationScope) {
  const rows = await tdb.db
    .select({ type: alert.type, dedupeKey: alert.dedupeKey, severity: alert.severity })
    .from(alert)
    .where(and(eq(alert.stationId, scope.stationId), isNull(alert.resolvedAt)));
  return rows.map((r) => r.dedupeKey).sort();
}

describe('playout cache (api)', () => {
  it('raises cache.item_missing at T−1h and resolves it when the file arrives', async () => {
    const scope = await newStation();
    const now = Date.now();
    const soon = await file(scope);
    const later = await file(scope);
    const [soonItem] = await log(scope, now, [
      { assetId: soon.assetId, at: 30 * 60_000 },
      { assetId: later.assetId, at: 3 * HOUR },
    ]);
    await recordCachePass(tdb.db, scope, {
      usedBytes: 0,
      horizonBytes: 2000,
      deferred: [],
      diskLow: false,
    });

    const cache = app.playoutCache;
    expect(await cache.evaluateAlerts(scope, new Date(now))).toEqual({ raised: 2, resolved: 0 });
    expect(await openAlerts(scope)).toEqual(
      [`cache.item_missing:${soonItem}`, 'cache.horizon_degraded'].sort(),
    );
    // Evaluating again changes nothing.
    expect(await cache.evaluateAlerts(scope, new Date(now))).toEqual({ raised: 0, resolved: 0 });

    await markCacheFileReady(tdb.db, scope, {
      sha256: soon.sha256,
      ext: 'flac',
      sizeBytes: 1000,
      lastNeededAt: null,
    });
    expect(await cache.isCached(scope, soon.assetFileId)).toBe(true);
    expect(await cache.evaluateAlerts(scope, new Date(now))).toEqual({ raised: 0, resolved: 1 });
    expect(await openAlerts(scope)).toEqual(['cache.horizon_degraded']);
    expect(await resolution(scope, `cache.item_missing:${soonItem}`)).toBe('cache_ok');

    await markCacheFileReady(tdb.db, scope, {
      sha256: later.sha256,
      ext: 'flac',
      sizeBytes: 1000,
      lastNeededAt: null,
    });
    await cache.evaluateAlerts(scope, new Date(now));
    expect(await openAlerts(scope)).toEqual([]);
  });

  it('alerts on a missing source and a full disk', async () => {
    const scope = await newStation();
    const now = Date.now();
    const broken = await file(scope);
    await log(scope, now, [{ assetId: broken.assetId, at: 10 * HOUR }]);
    await markCacheFileFailed(tdb.db, scope, {
      sha256: broken.sha256,
      ext: 'flac',
      sizeBytes: 1000,
      error: 'source_missing',
      message: 'Object not found',
    });
    await recordCachePass(tdb.db, scope, {
      usedBytes: 0,
      horizonBytes: 1000,
      deferred: [],
      diskLow: true,
    });
    await app.playoutCache.evaluateAllAlerts(new Date(now));
    expect(await openAlerts(scope)).toEqual(
      [`cache.source_missing:${broken.sha256}`, 'cache.disk_low'].sort(),
    );
  });

  it('serves the station status to members only', async () => {
    const scope = await newStation();
    const now = Date.now();
    const f = await file(scope);
    await log(scope, now, [{ assetId: f.assetId, at: HOUR }]);
    const url = `/api/v1/stations/${scope.stationId}/cache?hours=6`;
    const res = await app.inject({ method: 'GET', url, headers: cookieHeader(manager.cookie) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as CacheStatus;
    expect(body).toMatchObject({
      budgetBytes: 40 * 1024 ** 3,
      lastPassAt: null,
      readiness: { items: 1, readyItems: 0, pctAirTime: 0 },
    });
    expect(body.readiness.missing).toMatchObject([
      { assetFileId: f.assetFileId, sha256: f.sha256, reason: 'pending' },
    ]);

    const denied = await app.inject({ method: 'GET', url, headers: cookieHeader(outsider.cookie) });
    expect(denied.statusCode).toBe(404);
  });

  it('alerts for a station the worker never synced', async () => {
    const scope = await newStation();
    const now = Date.now();
    const f = await file(scope);
    const [item] = await log(scope, now, [{ assetId: f.assetId, at: 20 * 60_000 }]);
    // No station_cache row: no worker with a cache ever ran a pass for it.
    await app.playoutCache.evaluateAllAlerts(new Date(now));
    expect(await openAlerts(scope)).toEqual(
      [`cache.item_missing:${item}`, 'cache.horizon_degraded'].sort(),
    );

    // The item leaves the log without ever being cached.
    await tdb.db.delete(logItem).where(eq(logItem.id, item as string));
    await app.playoutCache.evaluateAllAlerts(new Date(now));
    expect(await openAlerts(scope)).toEqual([]);
    expect(await resolution(scope, `cache.item_missing:${item}`)).toBe('no_longer_needed');
  });

  it('alerts while passes fail, and shows the error', async () => {
    const scope = await newStation();
    await recordCachePassFailure(tdb.db, scope, "EACCES: permission denied, mkdir '/cache/x'");
    await app.playoutCache.evaluateAllAlerts();
    expect(await openAlerts(scope)).toEqual(['cache.sync_failing']);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/stations/${scope.stationId}/cache`,
      headers: cookieHeader(manager.cookie),
    });
    expect((res.json() as CacheStatus).lastError).toMatchObject({
      message: "EACCES: permission denied, mkdir '/cache/x'",
    });

    await recordCachePass(tdb.db, scope, {
      usedBytes: 0,
      horizonBytes: 0,
      deferred: [],
      diskLow: false,
    });
    await app.playoutCache.evaluateAllAlerts();
    expect(await openAlerts(scope)).toEqual([]);
    expect(await resolution(scope, 'cache.sync_failing')).toBe('cache_ok');
  });

  it('refuses requests without RabbitMQ', async () => {
    const scope = await newStation();
    await expect(app.playoutCache.requestSync(scope)).rejects.toThrow(/RabbitMQ/);
  });

  it('enqueues the urgent fetch and the 422 resync on the high lane, collapsing duplicates', async () => {
    const rabbit = await createTestRabbit();
    try {
      const envelopes: JobEnvelope[] = [];
      const cache = createPlayoutCache({
        db: tdb.db,
        alerts: app.alerts,
        logger: app.log,
        enqueue: async (job, payload, scope) => {
          envelopes.push(
            await rabbit.jobs.enqueue(job, payload, {
              orgId: scope.orgId,
              stationId: scope.stationId,
            }),
          );
        },
      });
      const scope = await newStation();
      const f = await file(scope);
      await cache.requestUrgentFetch(scope, f.assetFileId);
      await cache.requestSync(scope);
      const fetchPayload = {
        orgId: scope.orgId,
        stationId: scope.stationId,
        assetFileId: f.assetFileId,
      };
      const syncPayload = { orgId: scope.orgId, stationId: scope.stationId };
      expect(envelopes).toMatchObject([
        {
          name: 'cache-fetch',
          payload: fetchPayload,
          stationId: scope.stationId,
          // A payload-hash key, in flight only: duplicates collapse while one runs, and the
          // file can be fetched again after an eviction.
          idempotency: 'in_flight',
          idempotencyKey: defaultIdempotencyKey('cache-fetch', fetchPayload),
        },
        {
          name: 'cache-sync',
          payload: syncPayload,
          idempotency: 'in_flight',
          idempotencyKey: defaultIdempotencyKey('cache-sync', syncPayload),
        },
      ]);
    } finally {
      await rabbit.close();
    }
  });
});
