import {
  addMembership,
  auditLog,
  createOrganization,
  createStation,
  type OrgScope,
  resolveOrgScope,
  type StationScope,
  station,
  stationEngine,
  unsafeScope,
} from '@ondes/db';
import { createTestDatabase } from '@ondes/db/testing';
import type { Actor, EngineRealtimeEvent } from '@ondes/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../app.ts';
import { createMemoryMailer } from '../../../plugins/mail.ts';
import type { Rabbit } from '../../../plugins/rabbit.ts';
import { signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../../auth/testing.ts';
import { allocatePort, PortPoolExhaustedError } from './repo.ts';
import { containerName, ENGINE_LABELS, type EngineLifecycleConfig } from './spec.ts';
import { createFakeDocker, type FakeDocker } from './testing/fake-docker.ts';

// The lifecycle's decisions (create / unchanged / recreate / storm), boot, the port pool and
// the engine routes, on the real api and database with an in-memory Docker. The real
// containers are lifecycle.int.test.ts.

const system: Actor = { type: 'system', name: 'test' };
const config: EngineLifecycleConfig = {
  image: 'savonet/liquidsoap:v2.4.6',
  containerPrefix: 'svc-it',
  network: 'svc-it',
  internalApiUrl: 'http://api:3000',
  icecast: { host: 'icecast', port: 8000 },
  cacheRoot: '/srv/ondes/cache',
  livePorts: { min: 20000, max: 20099 },
  liveBindIp: '0.0.0.0',
  limits: { cpus: 1, memoryMb: 512, pids: 256 },
};

let t: TestApp;
let docker: FakeDocker;
let orgScope: OrgScope;
const published: EngineRealtimeEvent[] = [];
let stationCount = 0;

async function newStation(): Promise<StationScope> {
  stationCount++;
  const st = await createStation(
    t.tdb.db,
    { actor: system, scope: orgScope },
    { slug: `svc-${stationCount}`, name: `Station ${stationCount}`, timezone: 'Europe/Paris' },
  );
  return unsafeScope(orgScope.orgId, st.id);
}

beforeAll(async () => {
  const tdb = await createTestDatabase();
  docker = createFakeDocker();
  const mailer = createMemoryMailer();
  const rabbit = {
    events: {
      publish: async (event: unknown) => {
        published.push(event as EngineRealtimeEvent);
      },
    },
  } as unknown as Rabbit;
  const app = await buildApp({
    db: { client: tdb },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    rabbit: { rabbit },
    fastify: { logger: { level: process.env.TEST_LOG_LEVEL ?? 'silent' } },
    engine: {
      config,
      dockerUrl: 'http://unused',
      secret: TEST_AUTH_CONFIG.secret,
      docker,
      boot: false,
      guard: { maxRestarts: 3, windowSeconds: 600 },
      health: { intervalMs: 60_000, downAfter: 1 },
    },
  });
  await app.ready();
  t = { app, tdb, outbox: mailer.outbox, close: async () => {} };
  const org = await createOrganization(tdb.db, system, { slug: 'svc-org', name: 'Org' });
  orgScope = await resolveOrgScope(tdb.db, org.id);
});
afterAll(async () => {
  await t?.app.close();
  await t?.tdb.drop();
});

describe('engine lifecycle decisions', () => {
  it('creates, then leaves alone, then recreates on a settings change', async () => {
    const scope = await newStation();
    const lifecycle = t.app.engineLifecycle;

    const created = await lifecycle.start(scope);
    expect(created.action).toBe('created');
    const name = containerName(config, scope.stationId);
    const container = docker.byName(name);
    expect(container?.running).toBe(true);
    expect(container?.archives).toEqual([{ path: '/etc', size: expect.any(Number) }]);
    expect(container?.body.Labels?.[ENGINE_LABELS.configVersion]).toBe(created.configVersion);
    // Secrets are generated once, stored encrypted, and reach the container's environment.
    const [row] = await t.tdb.db
      .select()
      .from(stationEngine)
      .where(eq(stationEngine.stationId, scope.stationId));
    const { controlToken } = await lifecycle.secretsFor(scope);
    expect(row?.controlTokenEnc).not.toContain(controlToken);
    expect(container?.body.Env).toContain(`ENGINE_CONTROL_TOKEN=${controlToken}`);
    expect(lifecycle.tokenFor(scope.stationId)).toBe(controlToken);
    expect(row?.configVersion).toBe(created.configVersion);

    expect((await lifecycle.reconcile(scope)).action).toBe('unchanged');
    expect(docker.byName(name)?.id).toBe(container?.id);

    await t.tdb.db
      .update(station)
      .set({ engineSettings: { blank: { maxSeconds: 20 } } })
      .where(eq(station.id, scope.stationId));
    const recreated = await lifecycle.reconcile(scope);
    expect(recreated.action).toBe('recreated');
    expect(recreated.configVersion).not.toBe(created.configVersion);
    expect(docker.byName(name)?.id).not.toBe(container?.id);
    // Same live port: it belongs to the station.
    expect(docker.byName(name)?.body.HostConfig.PortBindings).toEqual(
      container?.body.HostConfig.PortBindings,
    );

    // A crashed (exited) container is started again.
    const current = docker.byName(name);
    if (current) current.running = false;
    expect((await lifecycle.reconcile(scope)).action).toBe('started');

    const stopped = await lifecycle.stop(scope);
    expect(stopped.action).toBe('stopped');
    expect(docker.byName(name)?.running).toBe(false);
    expect(t.app.stationEngines.get(scope.stationId)).toBeUndefined();
  });

  it('trips the restart-storm guard, then a manual restart clears it', async () => {
    const scope = await newStation();
    const lifecycle = t.app.engineLifecycle;
    await lifecycle.start(scope);
    const name = containerName(config, scope.stationId);

    // Docker restarted it twice: counted, under the limit (3).
    const c = docker.byName(name);
    if (!c) throw new Error('no container');
    c.restartCount = 2;
    await lifecycle.supervise();
    expect(lifecycle.guard.count(scope.stationId)).toBe(2);
    expect(lifecycle.guard.isTripped(scope.stationId)).toBe(false);

    // Then it died for good: one more restart by the lifecycle, still allowed (3).
    c.running = false;
    await lifecycle.supervise();
    expect(docker.byName(name)?.running).toBe(true);
    expect(lifecycle.guard.count(scope.stationId)).toBe(3);

    // And died again: storm.
    const again = docker.byName(name);
    if (again) again.running = false;
    await lifecycle.supervise();
    expect(lifecycle.guard.isTripped(scope.stationId)).toBe(true);
    expect(docker.byName(name)?.running).toBe(false);
    expect(docker.byName(name)?.body.HostConfig.RestartPolicy).toEqual({ Name: 'no' });
    expect(
      published.filter((e) => e.type === 'engine.restart_storm' && e.stationId === scope.stationId),
    ).toEqual([
      expect.objectContaining({ data: { bootId: null, restarts: 4, windowSeconds: 600 } }),
    ]);
    expect((await lifecycle.reconcile(scope)).action).toBe('storm');
    expect((await lifecycle.status(scope)).restartStorm).toEqual({
      tripped: true,
      restarts: 4,
      windowSeconds: 600,
    });

    const restarted = await lifecycle.restart(scope);
    expect(restarted.action).toBe('recreated');
    expect(docker.byName(name)?.running).toBe(true);
    expect(lifecycle.guard.isTripped(scope.stationId)).toBe(false);
  });

  it('boots every station whose engine should run', async () => {
    const running = await newStation();
    const stopped = await newStation();
    await t.app.engineLifecycle.start(running);
    await t.app.engineLifecycle.stop(stopped);
    docker.containers.clear();

    const results = await t.app.engineLifecycle.boot();
    const byStation = new Map(results.map((r) => [r.stationId, r.result?.action]));
    expect(byStation.get(running.stationId)).toBe('created');
    expect(byStation.has(stopped.stationId)).toBe(false);
    expect(docker.byName(containerName(config, stopped.stationId))).toBeUndefined();
    expect(t.app.stationEngines.get(running.stationId)).toBeDefined();
  });

  it('allocates live ports from the pool, one per station, and reports exhaustion', async () => {
    const range = { min: 21000, max: 21001 };
    const [a, b, c] = [await newStation(), await newStation(), await newStation()];
    const ports = await Promise.all([
      allocatePort(t.tdb.db, a, 'live', range),
      allocatePort(t.tdb.db, b, 'live', range),
      allocatePort(t.tdb.db, a, 'live', range),
    ]);
    expect(ports[0]).toBe(ports[2]);
    expect(new Set(ports).size).toBe(2);
    await expect(allocatePort(t.tdb.db, c, 'live', range)).rejects.toThrow(PortPoolExhaustedError);
  });
});

describe('engine routes', () => {
  let scope: StationScope;
  const cookies: Record<string, string> = {};

  beforeAll(async () => {
    scope = await newStation();
    for (const role of ['station_manager', 'viewer'] as const) {
      const { userId, cookie } = await signUpAndLogin(t, `${role}@engine.test`);
      await addMembership(
        t.tdb.db,
        { actor: system, scope: orgScope },
        { level: 'station', stationId: scope.stationId, userId, role },
      );
      cookies[role] = cookie;
    }
  });

  const call = (who: string, method: 'GET' | 'POST', path = '') =>
    t.app.inject({
      method,
      url: `/api/v1/stations/${scope.stationId}/engine${path}`,
      cookies: { ondes_session: cookies[who] ?? '' },
    });

  it('lets a station manager control the engine, with an audit row', async () => {
    const res = await call('station_manager', 'POST', '/start');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ action: 'created' });
    const audit = await t.tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.stationId, scope.stationId), eq(auditLog.action, 'engine.start')));
    expect(audit).toHaveLength(1);

    const status = await call('viewer', 'GET');
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ desiredState: 'running', container: { running: true } });
  });

  it('refuses control to a viewer', async () => {
    expect((await call('viewer', 'POST', '/restart')).statusCode).toBe(403);
  });

  it('authenticates engine event posts with the station token', async () => {
    const url = `/internal/engine/stations/${scope.stationId}/events`;
    const { controlToken } = await t.app.engineLifecycle.secretsFor(scope);
    const denied = await t.app.inject({ method: 'POST', url, payload: [] });
    expect(denied.statusCode).toBe(401);
    const ok = await t.app.inject({
      method: 'POST',
      url,
      payload: [],
      headers: { authorization: `Bearer ${controlToken}` },
    });
    expect(ok.statusCode).toBe(200);
  });
});
