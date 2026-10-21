import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createOrganization,
  createStation,
  enginePort,
  type StationScope,
  station,
  unsafeScope,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import type { EngineRealtimeEvent } from '@ondes/shared';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerEngineEventRoutes, StationEngines } from '../adapter/index.ts';
import { createDockerClient, type DockerClient } from './docker.ts';
import { createEngineSecretBox } from './secrets.ts';
import { createEngineLifecycle, type EngineLifecycle } from './service.ts';
import { containerName, type EngineLifecycleConfig } from './spec.ts';

/**
 * The lifecycle against real Docker: station engine containers created through the Docker
 * socket proxy (testing/compose.yml, its own project, network and ports), streaming to a
 * test Icecast, posting events back to this process. Needs Docker and Postgres
 * (`pnpm dev:up`, or CI's service container). Never touches the shared ondes-dev stack.
 */

const run = promisify(execFile);
const composeFile = fileURLToPath(new URL('./testing/compose.yml', import.meta.url));
const project = 'ondes-engine-lifecycle-it';
const dockerPort = Number(process.env.ENGINE_LIFECYCLE_IT_DOCKER_PORT ?? 17190);
const icecastPort = Number(process.env.ENGINE_LIFECYCLE_IT_ICECAST_PORT ?? 17191);
const runId = randomUUID().slice(0, 8);
const actor = { type: 'system', name: 'lifecycle-it' } as const;

const compose = (...args: string[]) =>
  run('docker', ['compose', '-p', project, '-f', composeFile, ...args], {
    env: {
      ...process.env,
      ENGINE_LIFECYCLE_IT_DOCKER_PORT: String(dockerPort),
      ENGINE_LIFECYCLE_IT_ICECAST_PORT: String(icecastPort),
    },
  });

/** Removes every engine container this run created (they aren't in the compose project). */
async function removeEngines() {
  const { stdout } = await run('docker', ['ps', '-aq', '--filter', `label=ondes.test=${runId}`]);
  const ids = stdout.split('\n').filter(Boolean);
  if (ids.length) await run('docker', ['rm', '-f', ...ids]);
}

async function waitFor<T>(
  what: string,
  find: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

let tdb: TestDatabase;
let docker: DockerClient;
let lifecycle: EngineLifecycle;
let engines: StationEngines;
let events: FastifyInstance;
let cacheRoot: string;
let scope: StationScope;
let slug: string;
const published: EngineRealtimeEvent[] = [];

beforeAll(async () => {
  tdb = await createTestDatabase();
  const org = await createOrganization(tdb.db, actor, {
    slug: `lc-${runId}`,
    name: 'Lifecycle IT',
  });
  slug = `lc-it-${runId}`;
  const st = await createStation(
    tdb.db,
    { actor, scope: unsafeScope(org.id) },
    { slug, name: 'Lifecycle IT', timezone: 'Europe/Paris' },
  );
  scope = unsafeScope(org.id, st.id);

  await compose('down', '-v', '--remove-orphans');
  await compose('up', '-d', '--wait');
  docker = createDockerClient({ url: `http://127.0.0.1:${dockerPort}` });
  cacheRoot = mkdtempSync(join(tmpdir(), 'ondes-lifecycle-it-'));

  engines = new StationEngines();
  // The engines post events here through host.docker.internal, hence 0.0.0.0.
  events = Fastify();
  const config: EngineLifecycleConfig = {
    image: 'savonet/liquidsoap:v2.4.6',
    containerPrefix: `ondes-lifecycle-it-${runId}`,
    network: 'ondes-engine-lifecycle-it',
    internalApiUrl: 'http://host.docker.internal:0', // replaced once the server listens
    icecast: { host: 'icecast', port: 8000 },
    sharedIcecastSourcePassword: 'ondes-lifecycle-it-source',
    cacheRoot,
    livePorts: { min: 17192, max: 17199 },
    liveBindIp: '127.0.0.1',
    limits: { cpus: 0.5, memoryMb: 512, pids: 128 },
    publishControlOnLoopback: true,
    extraHosts: ['host.docker.internal:host-gateway'],
    labels: { 'ondes.test': runId },
  };
  lifecycle = createEngineLifecycle({
    db: tdb.db,
    docker,
    config,
    secretBox: createEngineSecretBox('lifecycle-it-secret-0123456789abcdef'),
    engines,
    publish: async (event) => {
      published.push(event);
    },
    health: { intervalMs: 250, downAfter: 2 },
  });
  registerEngineEventRoutes(events, { ingestFor: engines.ingestFor, token: lifecycle.tokenFor });
  await events.listen({ host: '0.0.0.0', port: 0 });
  const address = events.server.address();
  if (!address || typeof address === 'string') throw new Error('no events server address');
  config.internalApiUrl = `http://host.docker.internal:${address.port}`;
}, 300_000);

afterAll(async () => {
  await lifecycle?.close();
  await events?.close();
  await removeEngines().catch(() => {});
  await compose('down', '-v', '--remove-orphans').catch(() => {});
  if (cacheRoot) rmSync(cacheRoot, { recursive: true, force: true });
  await tdb?.drop();
}, 120_000);

const upWithVersion = (version: string) =>
  waitFor(`engine up on ${version}`, () => {
    const health = engines.get(scope.stationId)?.health;
    return health?.status() === 'up' && health.last()?.config_version === version
      ? health.last()
      : undefined;
  });

describe('station engine lifecycle (real Docker)', () => {
  let firstVersion = '';
  let firstBoot = '';

  it('creates the engine: healthy, streaming, events flowing with its own token', async () => {
    const result = await lifecycle.start(scope);
    expect(result.action).toBe('created');
    firstVersion = result.configVersion ?? '';
    const health = await upWithVersion(firstVersion);
    firstBoot = health?.boot_id ?? '';

    // Its events reached the internal route (the per-station token check passed).
    await waitFor('engine.booted', () =>
      published.find((e) => e.type === 'engine.booted' && e.data.bootId === firstBoot),
    );

    const status = await lifecycle.status(scope);
    expect(status).toMatchObject({
      desiredState: 'running',
      health: 'up',
      reportedVersion: firstVersion,
      expectedVersion: firstVersion,
      restartPending: false,
      container: { running: true, configVersion: firstVersion },
    });
    expect(status.livePort).toBeGreaterThanOrEqual(17192);
    expect(status.livePort).toBeLessThanOrEqual(17199);
    const [port] = await tdb.db
      .select()
      .from(enginePort)
      .where(eq(enginePort.stationId, scope.stationId));
    expect(port?.port).toBe(status.livePort);

    // The container got its limits, the read-only cache and no published control port
    // beyond the loopback one this test asked for.
    const { stdout } = await run('docker', [
      'inspect',
      containerName({ containerPrefix: `ondes-lifecycle-it-${runId}` }, scope.stationId),
    ]);
    const [inspected] = JSON.parse(stdout);
    expect(inspected.HostConfig).toMatchObject({
      NanoCpus: 500_000_000,
      Memory: 512 * 1024 * 1024,
      PidsLimit: 128,
      CapDrop: ['ALL'],
    });
    expect(inspected.Mounts).toContainEqual(
      expect.objectContaining({ Destination: '/cache', RW: false }),
    );
    expect(inspected.Config.Env.join('\n')).toContain('ENGINE_CONTROL_TOKEN=');

    // Its default output is live on Icecast.
    await waitFor('the station mount on Icecast', async () => {
      const res = await fetch(`http://127.0.0.1:${icecastPort}/status-json.xsl`);
      const body = (await res.json()) as { icestats: { source?: unknown } };
      const sources = [body.icestats.source ?? []].flat() as { listenurl?: string }[];
      return sources.some((s) => s.listenurl?.endsWith(`/${slug}.mp3`)) || undefined;
    });
  }, 180_000);

  it('leaves a running engine alone when nothing changed', async () => {
    const result = await lifecycle.reconcile(scope);
    expect(result).toMatchObject({
      action: 'unchanged',
      configVersion: firstVersion,
      reportedVersion: firstVersion,
    });
    expect(engines.get(scope.stationId)?.health.last()?.boot_id).toBe(firstBoot);
  });

  it('restarts the engine when a setting changes its config_version', async () => {
    await tdb.db
      .update(station)
      .set({ engineSettings: { crossfade: { duration: 1.5 } } })
      .where(eq(station.id, scope.stationId));

    const before = await lifecycle.status(scope);
    expect(before.restartPending).toBe(true);
    expect(before.expectedVersion).not.toBe(firstVersion);

    const result = await lifecycle.reconcile(scope);
    expect(result.action).toBe('recreated');
    expect(result.reportedVersion).toBe(firstVersion);
    expect(result.configVersion).toBe(before.expectedVersion);
    const health = await upWithVersion(before.expectedVersion);
    expect(health?.boot_id).not.toBe(firstBoot);
    expect((await lifecycle.status(scope)).restartPending).toBe(false);
  }, 120_000);

  it('stops the engine, then removes it and frees its port', async () => {
    const stopped = await lifecycle.stop(scope);
    expect(stopped.action).toBe('stopped');
    const status = await lifecycle.status(scope);
    expect(status.desiredState).toBe('stopped');
    expect(status.container?.running).toBe(false);
    expect(engines.get(scope.stationId)).toBeUndefined();

    await lifecycle.remove(scope);
    expect(
      await docker.inspect(
        containerName({ containerPrefix: `ondes-lifecycle-it-${runId}` }, scope.stationId),
      ),
    ).toBeNull();
    expect(
      await tdb.db.select().from(enginePort).where(eq(enginePort.stationId, scope.stationId)),
    ).toEqual([]);
  }, 60_000);
});
