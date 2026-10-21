import { randomBytes, randomUUID } from 'node:crypto';
import {
  addMembership,
  alert,
  auditLog,
  createAsset,
  createOrganization,
  createStation,
  deleteAsset,
  type OrgScope,
  putAssetFile,
  recordFallbackSync,
  type StationScope,
  setAssetTags,
  stationEngine,
  unsafeScope,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import type { Actor, RealtimeEvent, SafetyStatus } from '@ondes/shared';
import { contentKey } from '@ondes/storage';
import { and, eq, isNull, like, not } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../app.ts';
import { createMemoryMailer } from '../../../plugins/mail.ts';
import {
  cookieHeader,
  signUpAndLogin,
  TEST_AUTH_CONFIG,
  type TestApp,
} from '../../auth/testing.ts';

// Safety playlist and emergency file (#34), api side: routes, permissions, audit, cache
// states from the worker's rows (written here directly), safety mode and the alerts.
// Postgres only (no RabbitMQ: engine events are handed to the service).

const system: Actor = { type: 'system', name: 'test' };

let tdb: TestDatabase;
let app: FastifyInstance;
let orgScope: OrgScope;
let manager: { userId: string; cookie: string };
let programmer: { userId: string; cookie: string };
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
    safety: { alertIntervalMs: 0 },
    fastify: { logger: false },
  });
  await app.ready();
  const org = await createOrganization(tdb.db, system, { slug: 'safety', name: 'Safety' });
  orgScope = unsafeScope(org.id);
  const t = { app, tdb, outbox: mailer.outbox } as unknown as TestApp;
  manager = await signUpAndLogin(t, 'manager@safety.test');
  programmer = await signUpAndLogin(t, 'programmer@safety.test');
  outsider = await signUpAndLogin(t, 'outsider@safety.test');
}, 60_000);

afterAll(async () => {
  await app?.close();
  await tdb?.drop();
});

let stations = 0;
async function newStation(): Promise<StationScope> {
  stations++;
  const ctx = { actor: system, scope: orgScope };
  const st = await createStation(tdb.db, ctx, {
    slug: `safety-${stations}`,
    name: 'FM',
    timezone: 'Europe/Paris',
  });
  for (const [user, role] of [
    [manager, 'station_manager'],
    [programmer, 'programmer'],
  ] as const) {
    await addMembership(tdb.db, ctx, {
      level: 'station',
      userId: user.userId,
      stationId: st.id,
      role,
    });
  }
  return unsafeScope(orgScope.orgId, st.id);
}

async function song(scope: StationScope, title: string, options: { file?: boolean } = {}) {
  const ctx = { actor: system, scope };
  const asset = await createAsset(tdb.db, ctx, { type: 'song', title, durationMs: 120_000 });
  const sha256 = randomBytes(32).toString('hex');
  if (options.file !== false) {
    await putAssetFile(tdb.db, ctx, asset.id, {
      role: 'playout',
      storageKey: contentKey({ orgId: scope.orgId, sha256, ext: 'flac' }),
      sha256,
      sizeBytes: 1000,
      codec: 'flac',
      sampleRate: 44_100,
      flacBlockSize: 1024,
    });
  }
  return { assetId: asset.id, sha256 };
}

async function runEngine(scope: StationScope) {
  await tdb.db.insert(stationEngine).values({
    orgId: scope.orgId,
    stationId: scope.stationId,
    desiredState: 'running',
    controlTokenEnc: 'x',
    livePasswordEnc: 'x',
    icecastSourcePasswordEnc: 'x',
  });
}

function call(
  scope: StationScope,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  cookie = manager.cookie,
) {
  return app.inject({
    method,
    url: `/api/v1/stations/${scope.stationId}/safety${path}`,
    headers: cookieHeader(cookie),
    ...(body === undefined ? {} : { payload: body as object }),
  });
}

async function openAlerts(scope: StationScope) {
  const rows = await tdb.db
    .select({ type: alert.type, severity: alert.severity })
    .from(alert)
    .where(
      and(
        eq(alert.stationId, scope.stationId),
        isNull(alert.resolvedAt),
        like(alert.type, 'engine.%'),
      ),
    );
  return rows.map((r) => `${r.type}/${r.severity}`).sort();
}

function trackStarted(scope: StationScope, source: string, at: Date): RealtimeEvent {
  return {
    id: randomUUID(),
    stationId: scope.stationId,
    at: at.toISOString(),
    type: 'engine.track.started',
    data: {
      bootId: 'b1',
      seq: 1,
      itemId: null,
      segmentId: null,
      source,
      title: null,
      artist: null,
      filename: null,
      rid: '1',
    },
  } as RealtimeEvent;
}

describe('safety playlist and emergency file', () => {
  it('starts empty', async () => {
    const scope = await newStation();
    const res = await call(scope, 'GET', '');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      safety: { assets: [], readyCount: 0, readyDurationMs: 0 },
      emergency: null,
      inEngine: { safetyFiles: 0, emergency: 'none' },
      syncedAt: null,
      onAir: null,
    } satisfies SafetyStatus);
  });

  it('selects assets, by id and by tag, with audit rows', async () => {
    const scope = await newStation();
    const [a, b, c] = [
      await song(scope, 'Bravo'),
      await song(scope, 'alpha'),
      await song(scope, 'Charlie'),
    ];
    await setAssetTags(tdb.db, { actor: system, scope }, c.assetId, {
      tags: [{ key: 'mood', value: 'Calm' }],
    });

    let res = await call(scope, 'PUT', '/assets', { assetIds: [a.assetId, b.assetId] });
    expect(res.statusCode).toBe(200);
    let body = res.json() as SafetyStatus;
    // By title, case-insensitive; nothing synced yet.
    expect(body.safety.assets.map((x) => x.title)).toEqual(['alpha', 'Bravo']);
    expect(body.safety.assets.map((x) => x.cache.state)).toEqual(['pending', 'pending']);

    res = await call(scope, 'POST', '/assets', { tag: { key: 'mood', value: 'calm' } });
    body = res.json() as SafetyStatus;
    expect(body.safety.assets.map((x) => x.title)).toEqual(['alpha', 'Bravo', 'Charlie']);

    res = await call(scope, 'DELETE', `/assets/${b.assetId}`);
    expect(res.statusCode).toBe(204);
    expect((await call(scope, 'DELETE', `/assets/${b.assetId}`)).statusCode).toBe(404);

    res = await call(scope, 'PUT', '/emergency', { assetId: a.assetId });
    expect((res.json() as SafetyStatus).emergency?.assetId).toBe(a.assetId);

    const audit = await tdb.db
      .select({ action: auditLog.action, diff: auditLog.diff })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.stationId, scope.stationId),
          not(like(auditLog.action, 'station.%')),
          not(like(auditLog.action, 'membership.%')),
          not(like(auditLog.action, 'asset%')),
        ),
      )
      .orderBy(auditLog.id);
    expect(audit.map((r) => r.action)).toEqual([
      'safety_playlist.set',
      'safety_playlist.add',
      'safety_playlist.remove',
      'emergency_file.set',
    ]);
    expect(audit[3]?.diff).toEqual({ assetId: { from: null, to: a.assetId } });
  });

  it("refuses another station's asset and checks permissions", async () => {
    const scope = await newStation();
    const other = await newStation();
    const foreign = await song(other, 'Foreign');
    const res = await call(scope, 'PUT', '/assets', { assetIds: [foreign.assetId] });
    expect(res.statusCode).toBe(404);
    expect((await call(scope, 'PUT', '/emergency', { assetId: foreign.assetId })).statusCode).toBe(
      404,
    );

    const mine = await song(scope, 'Mine');
    // Programmers can read, not change.
    expect((await call(scope, 'GET', '', undefined, programmer.cookie)).statusCode).toBe(200);
    const denied = await call(
      scope,
      'PUT',
      '/assets',
      { assetIds: [mine.assetId] },
      programmer.cookie,
    );
    expect(denied.statusCode).toBe(403);
    expect((await call(scope, 'GET', '', undefined, outsider.cookie)).statusCode).toBe(404);
    expect((await call(scope, 'POST', '/assets', {})).statusCode).toBe(400);
  });

  it('reports cache states from the worker, and the fallback alerts', async () => {
    const scope = await newStation();
    const [a, b] = [await song(scope, 'A'), await song(scope, 'B')];
    const noFile = await song(scope, 'Not ingested', { file: false });
    await call(scope, 'PUT', '/assets', { assetIds: [a.assetId, b.assetId, noFile.assetId] });
    await call(scope, 'PUT', '/emergency', { assetId: a.assetId });

    // Engine stopped: no alerts.
    await app.safety.evaluateAlerts(scope);
    expect(await openAlerts(scope)).toEqual([]);

    await runEngine(scope);
    await app.safety.evaluateAlerts(scope);
    expect(await openAlerts(scope)).toEqual([
      'engine.emergency_missing/warning',
      'engine.safety_empty/warning',
    ]);

    await recordFallbackSync(tdb.db, scope, [
      { kind: 'safety', sha256: a.sha256, state: 'ready' },
      {
        kind: 'safety',
        sha256: b.sha256,
        state: 'failed',
        error: 'source_missing',
        errorMessage: 'gone',
      },
      { kind: 'emergency', sha256: a.sha256, state: 'ready' },
    ]);
    const body = (await call(scope, 'GET', '')).json() as SafetyStatus;
    expect(body.safety.assets.map((x) => [x.title, x.cache.state, x.cache.error])).toEqual([
      ['A', 'ready', null],
      ['B', 'failed', 'source_missing'],
      ['Not ingested', 'no_file', null],
    ]);
    expect(body.safety).toMatchObject({ readyCount: 1, readyDurationMs: 120_000 });
    expect(body.emergency?.cache.state).toBe('ready');
    expect(body.syncedAt).not.toBeNull();

    await app.safety.evaluateAlerts(scope);
    expect(await openAlerts(scope)).toEqual([]);
  });

  it('tracks safety mode from engine events', async () => {
    const scope = await newStation();
    const a = await song(scope, 'A');
    await call(scope, 'PUT', '/assets', { assetIds: [a.assetId] });
    await call(scope, 'PUT', '/emergency', { assetId: a.assetId });
    await recordFallbackSync(tdb.db, scope, [
      { kind: 'safety', sha256: a.sha256, state: 'ready' },
      { kind: 'emergency', sha256: a.sha256, state: 'ready' },
    ]);
    await runEngine(scope);

    const t0 = new Date(Date.now() - 120_000);
    await app.safety.handleEngineEvent(trackStarted(scope, 'safety', t0));
    // A second safety track keeps the start of safety mode.
    await app.safety.handleEngineEvent(
      trackStarted(scope, 'safety', new Date(t0.getTime() + 60_000)),
    );
    // A late event of an earlier time is ignored.
    await app.safety.handleEngineEvent(trackStarted(scope, 'queue', new Date(t0.getTime() - 1000)));
    let body = (await call(scope, 'GET', '')).json() as SafetyStatus;
    expect(body.onAir).toEqual({ source: 'safety', startedAt: t0.toISOString() });

    await app.safety.evaluateAlerts(scope);
    expect(await openAlerts(scope)).toEqual(['engine.safety_mode/warning']);

    // Down to the emergency loop: escalates.
    await app.safety.handleEngineEvent(
      trackStarted(scope, 'emergency', new Date(t0.getTime() + 61_000)),
    );
    await app.safety.evaluateAlerts(scope, { now: new Date(t0.getTime() + 100_000) });
    expect(await openAlerts(scope)).toEqual(['engine.safety_mode/critical']);

    // Back on the log: resolved.
    await app.safety.handleEngineEvent(trackStarted(scope, 'queue', new Date()));
    body = (await call(scope, 'GET', '')).json() as SafetyStatus;
    expect(body.onAir?.source).toBe('queue');
    await app.safety.evaluateAlerts(scope);
    expect(await openAlerts(scope)).toEqual([]);
  });

  it('audits a removal caused by deleting the library asset', async () => {
    const scope = await newStation();
    const [a, b] = [await song(scope, 'A'), await song(scope, 'B')];
    await call(scope, 'PUT', '/assets', { assetIds: [a.assetId, b.assetId] });
    await call(scope, 'PUT', '/emergency', { assetId: a.assetId });
    await deleteAsset(tdb.db, { actor: system, scope }, a.assetId);

    const body = (await call(scope, 'GET', '')).json() as SafetyStatus;
    expect(body.safety.assets.map((x) => x.title)).toEqual(['B']);
    expect(body.emergency).toBeNull();
    const audit = await tdb.db
      .select({ action: auditLog.action, actorId: auditLog.actorId, diff: auditLog.diff })
      .from(auditLog)
      .where(and(eq(auditLog.stationId, scope.stationId), eq(auditLog.actorId, 'asset.delete')));
    expect(audit.map((r) => r.action).sort()).toEqual([
      'emergency_file.set',
      'safety_playlist.remove',
    ]);
    expect(audit.find((r) => r.action === 'emergency_file.set')?.diff).toEqual({
      assetId: { from: a.assetId, to: null },
    });
    // Removals through the api aren't audited twice.
    await call(scope, 'DELETE', `/assets/${b.assetId}`);
    const all = await tdb.db
      .select({ actorId: auditLog.actorId })
      .from(auditLog)
      .where(
        and(eq(auditLog.stationId, scope.stationId), eq(auditLog.action, 'safety_playlist.remove')),
      );
    expect(all.filter((r) => r.actorId === 'asset.delete')).toHaveLength(1);
  });

  it('reports a previous emergency file still in use', async () => {
    const scope = await newStation();
    const [old, fresh] = [await song(scope, 'Old'), await song(scope, 'New')];
    await call(scope, 'PUT', '/emergency', { assetId: fresh.assetId });
    await runEngine(scope);
    // The worker couldn't fetch the new one and kept the old file.
    await recordFallbackSync(tdb.db, scope, [
      { kind: 'emergency', sha256: fresh.sha256, state: 'failed', error: 'io', errorMessage: 'x' },
      { kind: 'emergency', sha256: old.sha256, state: 'ready' },
    ]);
    const body = (await call(scope, 'GET', '')).json() as SafetyStatus;
    expect(body.emergency?.cache.state).toBe('failed');
    expect(body.inEngine.emergency).toBe('previous');
    await app.safety.evaluateAlerts(scope);
    const [row] = await tdb.db
      .select({ title: alert.title })
      .from(alert)
      .where(and(eq(alert.stationId, scope.stationId), eq(alert.type, 'engine.emergency_missing')));
    expect(row?.title).toBe('Previous emergency file still in use');
  });

  it('evaluates every running station in one sweep', async () => {
    const scope = await newStation();
    await runEngine(scope);
    await app.safety.evaluateAllAlerts();
    expect(await openAlerts(scope)).toEqual([
      'engine.emergency_missing/warning',
      'engine.safety_empty/warning',
    ]);
    // Engine stopped: resolved.
    await tdb.db
      .update(stationEngine)
      .set({ desiredState: 'stopped' })
      .where(eq(stationEngine.stationId, scope.stationId));
    await app.safety.evaluateAllAlerts();
    expect(await openAlerts(scope)).toEqual([]);
  });
});
