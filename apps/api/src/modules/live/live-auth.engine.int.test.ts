import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  auditLog,
  createOrganization,
  createStation,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
} from '@ondes/db';
import { createTestDatabase } from '@ondes/db/testing';
import type { Actor } from '@ondes/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { createMemoryMailer } from '../../plugins/mail.ts';
import { TEST_AUTH_CONFIG } from '../auth/testing.ts';
import { createEngineAdapter, type EngineAdapter } from '../engine/adapter/index.ts';
import { renderStationScript } from '../engine/config/index.ts';
import { createStreamer, updateStreamer } from './repo.ts';
import { createLiveRevoker } from './revoke.ts';
import { liveAuthUrl } from './url.ts';

// The harbor auth callback end to end (#63, ADR 0023), in the `engine` integration project:
// the station template rendered with a live auth URL runs in the pinned Liquidsoap image and
// asks this api (real app, throwaway database) about every source login. A second Liquidsoap
// container plays the DJ (an MP3 Icecast source). Its own Docker network and containers,
// control port on a random 127.0.0.1 port: never the shared dev stack's engine.

const repo = resolve(import.meta.dirname, '../../../../..');
const system: Actor = { type: 'system', name: 'live-auth-test' };
const TOKEN = `live-auth-test-${randomBytes(8).toString('hex')}`;
const run = randomBytes(4).toString('hex');
const network = `ondes-live-auth-${run}`;
const engineName = `ondes-live-auth-engine-${run}`;
const work = join(tmpdir(), `ondes-live-auth-${run}`);

function liquidsoapImage(): string {
  if (process.env.LIQUIDSOAP_IMAGE) return process.env.LIQUIDSOAP_IMAGE;
  const compose = readFileSync(join(repo, 'deploy/compose.dev.yml'), 'utf8');
  const m = compose.match(/image:\s*(savonet\/liquidsoap:\S+)/);
  if (!m?.[1]) throw new Error('no Liquidsoap image in deploy/compose.dev.yml');
  return m[1];
}

function docker(args: string[], check = true): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (check && r.status !== 0) throw new Error(`docker ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const user =
  process.getuid && process.getgid
    ? ['--user', `${process.getuid()}:${process.getgid()}`, '-e', 'HOME=/tmp']
    : [];

let close: () => Promise<void> = async () => {};
let db: Awaited<ReturnType<typeof createTestDatabase>>['db'];
let scope: StationScope;
let engine: EngineAdapter;
let harborUrl: string;
const passwords: Record<string, string> = {};
const ids: Record<string, string> = {};

beforeAll(async () => {
  mkdirSync(work, { recursive: true });
  const tdb = await createTestDatabase();
  db = tdb.db;
  const org = await createOrganization(db, system, { slug: `la-${run}`, name: 'Org' });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: `la-fm-${run}`, name: 'FM', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(db, org.id, st.id);
  const ctx = { actor: system, scope };
  for (const [username, extra] of [
    ['dj-good', { anyTime: true }],
    ['dj-two', { anyTime: true }],
    ['dj-off', { anyTime: true, enabled: false }],
    // No allowed show and not "any time": never inside a slot.
    ['dj-slotless', {}],
  ] as const) {
    const created = await createStreamer(db, ctx, { displayName: username, username, ...extra });
    passwords[username] = created.password;
    ids[username] = created.streamer.id;
  }

  // The real app, reachable from the engine container.
  const app = await buildApp({
    db: { client: tdb },
    mail: { mailer: createMemoryMailer() },
    auth: TEST_AUTH_CONFIG,
    live: { tokenFor: (id) => (id === st.id ? TOKEN : undefined), sweepIntervalMs: 0 },
    fastify: { logger: false },
  });
  await app.listen({ host: '0.0.0.0', port: 0 });
  const apiPort = (app.server.address() as AddressInfo).port;

  const rendered = renderStationScript({
    stationId: st.id,
    name: 'Live auth test',
    paths: { safetyDir: '/work/safety', emergencyFile: '/work/missing.flac' },
    icecast: { host: '127.0.0.1', port: 9 },
    outputs: [{ mount: 'test.mp3', format: 'mp3', bitrate: 128 }],
    live: {
      enabled: true,
      mount: 'live',
      authUrl: liveAuthUrl(`http://host.docker.internal:${apiPort}`, st.id),
    },
  });
  mkdirSync(join(work, 'safety'), { recursive: true });
  writeFileSync(join(work, 'station.liq'), rendered.script);

  docker(['network', 'create', network]);
  docker([
    'run',
    '-d',
    '--name',
    engineName,
    '--network',
    network,
    '--add-host',
    'host.docker.internal:host-gateway',
    ...user,
    '-e',
    `ENGINE_CONTROL_TOKEN=${TOKEN}`,
    // Set, to prove the auth URL wins over the shared password.
    '-e',
    'ENGINE_LIVE_PASSWORD=shared-password',
    '-e',
    'ICECAST_SOURCE_PASSWORD=unused',
    '-p',
    '127.0.0.1::7000',
    '-p',
    '127.0.0.1::8005',
    '-v',
    `${work}:/work`,
    liquidsoapImage(),
    '/work/station.liq',
  ]);
  close = async () => {
    for (const name of docker(
      ['ps', '-aq', '--filter', `name=ondes-live-auth-.*-${run}`],
      false,
    ).split('\n'))
      if (name) docker(['rm', '-f', name], false);
    docker(['rm', '-f', engineName], false);
    docker(['network', 'rm', network], false);
    await app.close();
    await tdb.drop();
    rmSync(work, { recursive: true, force: true });
  };

  const port = docker(['port', engineName, '7000/tcp']).split('\n')[0]?.split(':').pop();
  harborUrl = `http://127.0.0.1:${docker(['port', engineName, '8005/tcp']).split('\n')[0]?.split(':').pop()}`;
  engine = createEngineAdapter({
    stationId: st.id,
    baseUrl: `http://127.0.0.1:${port}`,
    token: TOKEN,
  });
  for (let i = 0; i < 120; i++) {
    if (
      await engine.health().then(
        () => true,
        () => false,
      )
    )
      return;
    await sleep(500);
  }
  throw new Error(`engine did not start:\n${docker(['logs', engineName], false)}`);
}, 120_000);

afterAll(() => close());

let djs = 0;
/** Starts a stand-in DJ streaming a tone. Returns its stop function. */
function startDj(username: string, password: string, mount = 'live'): () => void {
  const name = `ondes-live-auth-dj${djs++}-${run}`;
  const script = join(work, `${name}.liq`);
  writeFileSync(
    script,
    [
      'settings.log.stdout := true',
      'settings.log.level := 2',
      `output.icecast(%mp3(bitrate=128), host=${JSON.stringify(engineName)}, port=8005,`,
      `  user=${JSON.stringify(username)}, password=${JSON.stringify(password)},`,
      `  mount=${JSON.stringify(mount)}, sine())`,
    ].join('\n'),
  );
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--network',
    network,
    ...user,
    '-v',
    `${work}:/work`,
    liquidsoapImage(),
    `/work/${name}.liq`,
  ]);
  return () => docker(['rm', '-f', name], false);
}

/** True if the engine reports a connected source within `ms`; disconnects the DJ after. */
async function connects(username: string, password: string, ms = 8000): Promise<boolean> {
  const stop = startDj(username, password);
  let connected = false;
  try {
    for (let waited = 0; waited < ms && !connected; waited += 250) {
      await sleep(250);
      connected = (await engine.state()).live.connected;
    }
  } finally {
    stop();
    for (let i = 0; i < 40 && (await engine.state()).live.connected; i++) await sleep(250);
  }
  return connected;
}

/** A source connection to `mount` (Icecast PUT): the status harbor answers with. */
function sourceLogin(login: string, mount = 'live'): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const req = request(`${harborUrl}/${mount}`, {
      method: 'PUT',
      headers: { authorization: `Basic ${btoa(login)}`, 'content-type': 'audio/mpeg' },
    });
    req.on('response', (res) => {
      resolvePromise(res.statusCode ?? 0);
      res.resume();
      req.destroy();
    });
    req.on('error', reject);
    req.write(Buffer.alloc(4096));
  });
}

/** Track info the way DJ software sends it for MP3 (#68): the status harbor answers with. */
async function metadataAs(login: string, song: string): Promise<number> {
  const url = new URL(`${harborUrl}/admin/metadata`);
  url.searchParams.set('mount', '/live');
  url.searchParams.set('mode', 'updinfo');
  url.searchParams.set('song', song);
  return (await fetch(url, { headers: { authorization: `Basic ${btoa(login)}` } })).status;
}

// Each attempt starts a DJ container and waits for the engine: slower than the 30 s default.
const SLOW = 120_000;

describe('harbor auth callback on the real engine', () => {
  it(
    'connects a DJ with good credentials',
    async () => {
      expect(await connects('dj-good', passwords['dj-good'] ?? '')).toBe(true);
      const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'streamer.connect'));
      expect(rows.map((r) => r.entityId)).toEqual([ids['dj-good']]);
    },
    SLOW,
  );

  it(
    'refuses a wrong password, an unknown user and the shared password',
    async () => {
      expect(await connects('dj-good', 'wrong-password-123', 5000)).toBe(false);
      expect(await connects('nobody', passwords['dj-good'] ?? '', 5000)).toBe(false);
      expect(await connects('source', 'shared-password', 5000)).toBe(false);
    },
    SLOW,
  );

  it(
    'refuses a disabled streamer and one outside its slots',
    async () => {
      expect(await connects('dj-off', passwords['dj-off'] ?? '', 5000)).toBe(false);
      expect(await connects('dj-slotless', passwords['dj-slotless'] ?? '', 5000)).toBe(false);
    },
    SLOW,
  );

  it(
    'connects a Shoutcast-style source (user source, password username:password)',
    async () => {
      expect(await connects('source', `dj-good:${passwords['dj-good']}`)).toBe(true);
    },
    SLOW,
  );

  it(
    'reports which streamer holds which input, and names them on the live as-run (#64)',
    async () => {
      const stopOne = startDj('dj-good', passwords['dj-good'] ?? '');
      const stopTwo = startDj('dj-two', passwords['dj-two'] ?? '', 'live-2');
      try {
        let live = (await engine.state()).live;
        for (let i = 0; i < 60 && !live.inputs?.every((x) => x.ready); i++) {
          await sleep(250);
          live = (await engine.state()).live;
        }
        expect(live.inputs?.map((x) => x.streamer_id)).toEqual([ids['dj-good'], ids['dj-two']]);
        const session = '0199a4e2-7c1d-7000-8000-00000000c0de';
        await engine.setLive(true, { input: 2, sessionId: session });
        for (let i = 0; i < 40 && (await engine.state()).live.on_air !== 2; i++) await sleep(250);
        const started = (await engine.events(0)).filter(
          (e) => e.type === 'track.started' && e.data.source === 'live',
        );
        expect(started.at(-1)?.data).toMatchObject({
          live_session_id: session,
          live_streamer_id: ids['dj-two'],
          live_input: 2,
        });
        const connected = (await engine.events(0)).flatMap((e) =>
          e.type === 'live.connected' ? [[e.data.input, e.data.streamer_id]] : [],
        );
        expect(connected).toEqual(
          expect.arrayContaining([
            [1, ids['dj-good']],
            [2, ids['dj-two']],
          ]),
        );
      } finally {
        await engine.setLive(false);
        stopOne();
        stopTwo();
        for (let i = 0; i < 40 && (await engine.state()).live.connected; i++) await sleep(250);
      }
    },
    SLOW,
  );

  it(
    'refuses any source on a taken input, and track info from anyone but its DJ (#68)',
    async () => {
      const good = `dj-good:${passwords['dj-good']}`;
      const stop = startDj('dj-good', passwords['dj-good'] ?? '');
      try {
        for (let i = 0; i < 40 && !(await engine.state()).live.connected; i++) await sleep(250);
        expect((await engine.state()).live.connected).toBe(true);
        const before = await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.action, 'streamer.connect'));
        // The connected DJ's own login, another DJ's, a wrong one: refused by the callback,
        // which never asks the api about a taken input.
        expect(await sourceLogin(good)).toBe(401);
        expect(await sourceLogin(`dj-two:${passwords['dj-two']}`)).toBe(401);
        expect(await sourceLogin('dj-good:wrong-password-123')).toBe(401);
        const after = await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.action, 'streamer.connect'));
        expect(after).toHaveLength(before.length);
        // Track info: only the DJ connected there.
        expect(await metadataAs(`dj-two:${passwords['dj-two']}`, 'Intruder')).toBe(401);
        expect(await metadataAs('dj-good:wrong-password-123', 'Intruder')).toBe(401);
        expect(await metadataAs(good, 'Artist - Song')).toBe(200);
        // Nobody connected on the second input: no track info for it either.
        const free = new URL(`${harborUrl}/admin/metadata`);
        free.searchParams.set('mount', '/live-2');
        free.searchParams.set('mode', 'updinfo');
        free.searchParams.set('song', 'Intruder');
        expect(
          (await fetch(free, { headers: { authorization: `Basic ${btoa(good)}` } })).status,
        ).toBe(401);
        expect((await engine.state()).live.inputs?.[0]?.streamer_id).toBe(ids['dj-good']);
      } finally {
        stop();
        for (let i = 0; i < 40 && (await engine.state()).live.connected; i++) await sleep(250);
      }
    },
    SLOW,
  );

  it(
    'takes a DJ disabled mid-set off air',
    async () => {
      const stop = startDj('dj-good', passwords['dj-good'] ?? '');
      try {
        for (let i = 0; i < 40 && !(await engine.state()).live.ready; i++) await sleep(250);
        await engine.setLive(true);
        expect((await engine.state()).live).toMatchObject({ connected: true, enabled: true });
        const updated = await updateStreamer(db, { actor: system, scope }, ids['dj-good'] ?? '', {
          enabled: false,
        });
        const revoker = createLiveRevoker({
          db,
          engineFor: async () => engine,
          logger: { warn: () => {}, error: () => {} },
        });
        expect(await revoker.revoke(scope, updated.id, 'disabled')).toBe(true);
        expect((await engine.state()).live.enabled).toBe(false);
      } finally {
        stop();
      }
    },
    SLOW,
  );
});
