import { randomUUID } from 'node:crypto';
import {
  addMembership,
  auditLog,
  createOrganization,
  createStation,
  enginePort,
  type OrgScope,
  resolveOrgScope,
  type StationScope,
  station,
  stationEngine,
  unsafeScope,
} from '@ondes/db';
import { createTestDatabase } from '@ondes/db/testing';
import { type Actor, type EngineRealtimeEvent, engineStatusViewSchema } from '@ondes/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../app.ts';
import { createMemoryMailer } from '../../../plugins/mail.ts';
import { createRabbit, type Rabbit } from '../../../plugins/rabbit.ts';
import { signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../../auth/testing.ts';
import { StationEngines } from '../adapter/index.ts';
import { allocatePort, PortPoolExhaustedError } from './repo.ts';
import { createEngineSecretBox, type EngineSecretKeys } from './secrets.ts';
import { createEngineLifecycle } from './service.ts';
import { containerName, ENGINE_LABELS, type EngineLifecycleConfig } from './spec.ts';
import { createFakeDocker, type FakeDocker } from './testing/fake-docker.ts';

// The lifecycle's decisions (create / unchanged / recreate / storm), boot, the port pool and
// the engine routes, on the real api and database with an in-memory Docker. The real
// containers are lifecycle.int.test.ts.

const system: Actor = { type: 'system', name: 'test' };
const KEYS: EngineSecretKeys = {
  currentId: 'k1',
  keys: { k1: 'service-it-engine-secrets-key-0123456789' },
};
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

let realRabbit: Rabbit | undefined;

beforeAll(async () => {
  const tdb = await createTestDatabase();
  docker = createFakeDocker();
  const mailer = createMemoryMailer();
  // A real connection: other plugins on the app (SSE #9, alerts #33) consume from RabbitMQ.
  // Publishes are captured, then sent on as usual.
  realRabbit = await createRabbit(
    process.env.RABBITMQ_URL ?? 'amqp://ondes:ondes@127.0.0.1:5672/ondes',
  );
  const rabbit: Rabbit = {
    ...realRabbit,
    events: {
      publish: async (event: unknown) => {
        published.push(event as EngineRealtimeEvent);
        await realRabbit?.events.publish(event);
      },
      close: () => realRabbit?.events.close() ?? Promise.resolve(),
    },
  };
  const app = await buildApp({
    db: { client: tdb },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    rabbit: { rabbit },
    // Its own durable queue and no sweep, so it never competes with the alerts tests.
    alerts: { eventQueue: `alerts-lifecycle-it-${randomUUID()}`, sweepIntervalMs: 0 },
    // The feeder (#29) has its own tests; here it would only poll the fake engines.
    feeder: false,
    fastify: { logger: { level: process.env.TEST_LOG_LEVEL ?? 'silent' } },
    engine: {
      config,
      dockerUrl: 'http://unused',
      secretKeys: KEYS,
      docker,
      boot: false,
      retryBaseMs: 0,
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
  await realRabbit?.close();
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
    // The script travels in the environment (the guard refuses archive uploads).
    expect(container?.body.Env?.find((e) => e.startsWith('ENGINE_SCRIPT='))).toContain(
      `config_version = "${created.configVersion}"`,
    );
    expect(container?.body.Labels?.[ENGINE_LABELS.configVersion]).toBe(created.configVersion);
    // Secrets are generated once, stored encrypted, and reach the container's environment.
    const [row] = await t.tdb.db
      .select()
      .from(stationEngine)
      .where(eq(stationEngine.stationId, scope.stationId));
    const { controlToken } = await lifecycle.secretsFor(scope);
    expect(row?.controlTokenEnc).not.toContain(controlToken);
    expect(container?.body.Env).toContain(`ENGINE_CONTROL_TOKEN=${controlToken}`);
    expect(await lifecycle.tokenFor(scope.stationId)).toBe(controlToken);
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
    // The two restarts under the limit are reported (#71's `engine.restarted` alert), the storm
    // isn't: it has its own event.
    expect(
      published
        .filter((e) => e.type === 'engine.restarted' && e.stationId === scope.stationId)
        .map((e) => e.data),
    ).toEqual([
      { bootId: null, restarts: 2, inWindow: 2, windowSeconds: 600, crashed: false },
      { bootId: null, restarts: 1, inWindow: 3, windowSeconds: 600, crashed: true },
    ]);
    expect(
      published.filter((e) => e.type === 'engine.restart_storm' && e.stationId === scope.stationId),
    ).toEqual([
      expect.objectContaining({ data: { bootId: null, restarts: 4, windowSeconds: 600 } }),
    ]);
    expect((await lifecycle.reconcile(scope)).action).toBe('storm');
    // The contract the dashboard (#71) reads it with.
    expect(engineStatusViewSchema.safeParse(await lifecycle.status(scope)).success).toBe(true);
    expect((await lifecycle.status(scope)).restartStorm).toEqual({
      tripped: true,
      since: expect.any(String),
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
    // Secrets read (Icecast sync, #32) but never started: no engine at boot.
    const untouched = await newStation();
    await t.app.engineLifecycle.secretsFor(untouched);
    await t.app.engineLifecycle.start(running);
    await t.app.engineLifecycle.stop(stopped);
    docker.containers.clear();

    const results = await t.app.engineLifecycle.boot();
    const byStation = new Map(results.map((r) => [r.stationId, r.result?.action]));
    expect(byStation.get(running.stationId)).toBe('created');
    expect(byStation.has(stopped.stationId)).toBe(false);
    expect(byStation.has(untouched.stationId)).toBe(false);
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

/** Another api replica on the same database and Docker (rolling deploy, scale-out). */
function replica(keys = KEYS) {
  return createEngineLifecycle({
    db: t.tdb.db,
    docker,
    config,
    secretBox: createEngineSecretBox(keys),
    engines: new StationEngines(),
    publish: async (event) => {
      published.push(event);
    },
    retryBaseMs: 0,
    health: { intervalMs: 60_000, downAfter: 1 },
  });
}

describe('engine lifecycle resilience', () => {
  it('never leaves a dead container behind a failed start, and replaces a stale one', async () => {
    const scope = await newStation();
    const name = containerName(config, scope.stationId);
    docker.failStart = 'driver failed programming external connectivity';
    await expect(t.app.engineLifecycle.start(scope)).rejects.toThrow(/connectivity/);
    expect(docker.byName(name)).toBeUndefined();
    // The intent survives the failure: still wanted, and queued for a retry.
    expect((await t.app.engineLifecycle.status(scope)).desiredState).toBe('running');
    expect(t.app.engineLifecycle.pendingRetries().has(scope.stationId)).toBe(true);

    // A container created but never started (the api died between create and start).
    await docker.create(name, {
      Image: config.image,
      Labels: { [ENGINE_LABELS.managed]: 'true', [ENGINE_LABELS.station]: scope.stationId },
      HostConfig: {},
    });
    expect((await t.app.engineLifecycle.reconcile(scope)).action).toBe('recreated');
    expect(docker.byName(name)?.running).toBe(true);
  });

  it('names the port when the live port is taken on the host', async () => {
    const scope = await newStation();
    docker.failStart = 'Bind for 0.0.0.0:20007 failed: port is already allocated';
    const [port] = await Promise.all([allocatePort(t.tdb.db, scope, 'live', config.livePorts)]);
    const error = await t.app.engineLifecycle.start(scope).catch((e) => e);
    expect(error.name).toBe('EnginePortInUseError');
    expect(error.port).toBe(port);
    expect(error.message).toContain(String(port));
  });

  it('retries stations whose boot failed, with backoff, once Docker is back', async () => {
    const scope = await newStation();
    await t.app.engineLifecycle.start(scope);
    docker.containers.clear();
    const lifecycle = replica();
    docker.down = true;
    const results = await lifecycle.boot();
    expect(results.find((r) => r.stationId === scope.stationId)?.error).toBeDefined();
    expect(lifecycle.pendingRetries().get(scope.stationId)?.attempts).toBe(1);
    await lifecycle.supervise();
    expect(lifecycle.pendingRetries().get(scope.stationId)?.attempts).toBe(2);

    docker.down = false;
    await lifecycle.supervise();
    expect(lifecycle.pendingRetries().has(scope.stationId)).toBe(false);
    expect(docker.byName(containerName(config, scope.stationId))?.running).toBe(true);
    await lifecycle.close();
  });

  it('lets one replica at a time reconcile a station', async () => {
    const scope = await newStation();
    const [a, b] = [replica(), replica()];
    const results = await Promise.all([a.start(scope), b.start(scope), a.reconcile(scope)]);
    expect(results.map((r) => r.action).sort()).toEqual(['created', 'unchanged', 'unchanged']);
    expect(
      docker.calls.filter((c) => c === `create ${containerName(config, scope.stationId)}`),
    ).toHaveLength(1);
    await Promise.all([a.close(), b.close()]);
  });

  it('blocks station deletion until the engine is removed, then frees everything', async () => {
    const scope = await newStation();
    await t.app.engineLifecycle.start(scope);
    await expect(t.tdb.db.delete(station).where(eq(station.id, scope.stationId))).rejects.toThrow();

    await t.app.engineLifecycle.remove(scope);
    expect(docker.byName(containerName(config, scope.stationId))).toBeUndefined();
    expect(
      await t.tdb.db.select().from(enginePort).where(eq(enginePort.stationId, scope.stationId)),
    ).toEqual([]);
    await t.tdb.db.delete(station).where(eq(station.id, scope.stationId));
  });

  it('sweeps engine containers whose station has no engine any more', async () => {
    const ghost = '0199a4e2-7c1d-7000-8000-00000000dead';
    const labels = { [ENGINE_LABELS.managed]: 'true', [ENGINE_LABELS.station]: ghost };
    await docker.create(containerName(config, ghost), {
      Image: config.image,
      Labels: labels,
      HostConfig: {},
    });
    // Another deployment's engine (other prefix) is not ours to remove.
    await docker.create(`other-${ghost}`, { Image: config.image, Labels: labels, HostConfig: {} });
    await t.app.engineLifecycle.supervise();
    expect(docker.byName(containerName(config, ghost))).toBeUndefined();
    expect(docker.byName(`other-${ghost}`)).toBeDefined();
  });

  it('keeps a restart storm across api restarts, and resets a drifted restart policy', async () => {
    const scope = await newStation();
    const first = replica();
    await first.start(scope);
    const c = docker.byName(containerName(config, scope.stationId));
    if (!c) throw new Error('no container');
    c.restartCount = 10;
    await first.supervise();
    expect((await first.status(scope)).restartStorm).toMatchObject({
      tripped: true,
      since: expect.any(String),
    });
    await first.close();

    // A fresh api (empty in-memory guard) still sees the storm.
    const second = replica();
    expect((await second.reconcile(scope)).action).toBe('storm');
    expect((await second.restart(scope)).action).toBe('recreated');

    // Someone changed the restart policy by hand: the next reconcile puts it back.
    const now = docker.byName(containerName(config, scope.stationId));
    if (now) now.body.HostConfig.RestartPolicy = { Name: 'no' };
    expect((await second.reconcile(scope)).action).toBe('unchanged');
    expect(
      docker.byName(containerName(config, scope.stationId))?.body.HostConfig.RestartPolicy,
    ).toEqual({
      Name: 'on-failure',
      MaximumRetryCount: 5,
    });
    await second.close();
  });

  it("rotates a station's secrets on request, and re-seals them under a new key", async () => {
    const scope = await newStation();
    const before = await t.app.engineLifecycle.secretsFor(scope);
    const lifecycle = replica();
    // What Icecast (#32) would be told before each create.
    const seen: string[] = [];
    lifecycle.onBeforeCreate(async (s, secrets) => {
      if (s.stationId === scope.stationId) seen.push(secrets.icecastSourcePassword);
    });
    await lifecycle.start(scope);
    const result = await lifecycle.restart(scope, { rotateSecrets: true });
    expect(result.action).toBe('recreated');
    await lifecycle.close();
    const after = await t.app.engineLifecycle.secretsFor(scope);
    expect(seen).toEqual([before.icecastSourcePassword, after.icecastSourcePassword]);
    expect(after.controlToken).not.toBe(before.controlToken);
    expect(after.icecastSourcePassword).not.toBe(before.icecastSourcePassword);
    expect(docker.byName(containerName(config, scope.stationId))?.body.Env).toContain(
      `ENGINE_CONTROL_TOKEN=${after.controlToken}`,
    );

    const rotated = replica({
      currentId: 'k2',
      keys: { k2: 'service-it-engine-secrets-key-rotated-000', ...KEYS.keys },
    });
    expect((await rotated.secretsFor(scope)).controlToken).toBe(after.controlToken);
    const [row] = await t.tdb.db
      .select()
      .from(stationEngine)
      .where(eq(stationEngine.stationId, scope.stationId));
    expect(row?.controlTokenEnc).toMatch(/^v1:k2:/);
    await rotated.close();
  });

  it("answers the events route's token check from the database on a fresh api", async () => {
    const scope = await newStation();
    const { controlToken } = await t.app.engineLifecycle.secretsFor(scope);
    const fresh = replica();
    expect(await fresh.tokenFor(scope.stationId)).toBe(controlToken);
    expect(await fresh.tokenFor('0199a4e2-7c1d-7000-8000-00000000beef')).toBeUndefined();
    // Any replica can drive any engine (e.g. a queue consumer, #33).
    expect(await fresh.adapterFor(scope.stationId)).toBeDefined();
    await fresh.close();
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

  it('audits failed control attempts', async () => {
    docker.failStart = 'no space left on device';
    await call('station_manager', 'POST', '/restart');
    const audit = await t.tdb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.stationId, scope.stationId), eq(auditLog.action, 'engine.restart.failed')),
      );
    expect(audit).toHaveLength(1);
    // Recover for the next tests.
    expect((await call('station_manager', 'POST', '/restart')).statusCode).toBe(200);
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
