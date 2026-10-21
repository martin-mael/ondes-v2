import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createOrganization,
  createStation,
  listListenerStats,
  recordListenerSamples,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
  station,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIcecastAdmin, type IcecastStats } from './admin.ts';
import type { StationOutputsError } from './mounts.ts';
import { icecastSourcePassword } from './passwords.ts';
import { createListenerStatsPoller } from './poller.ts';
import { createIcecastConfigSync, type IcecastConfigSync, writeIfChanged } from './sync.ts';

/**
 * Icecast 2.5 running the config generated from the database (testing/compose.yml, its own
 * compose project and port), fed by a real Liquidsoap source. Covers the mount settings and
 * per-station source passwords (no station can source another's mount), the UTF-8 charset,
 * intro, fallback when the engine stops, the reload's listener impact, invalid settings and
 * the stats poller. Needs Docker and Postgres (`pnpm dev:up`, or CI's service container).
 */

const run = promisify(execFile);
const composeFile = fileURLToPath(new URL('./testing/compose.yml', import.meta.url));
const renderedDir = fileURLToPath(new URL('./testing/.rendered/', import.meta.url));
const project = 'ondes-icecast-it';
const port = Number(process.env.ICECAST_IT_PORT ?? 18100);
const base = `http://127.0.0.1:${port}`;
const configPath = `${renderedDir}config/icecast.xml`;
const assetsDir = `${renderedDir}assets`;
const NAME = 'Vandale Radió – Lyon';
/** Stands in for the lifecycle's per-station secrets: passwords derived from it. */
const MASTER = 'ondes-it-source-secret';
/** The test station's source password, handed to its engine (the `source` service). */
let itPassword = 'unset';

const compose = (...args: string[]) =>
  run('docker', ['compose', '-p', project, '-f', composeFile, ...args], {
    env: { ...process.env, ICECAST_IT_PORT: String(port), IT_SOURCE_PASSWORD: itPassword },
  });

/**
 * Tries to source a mount like an engine would (HTTP PUT, `source` user). Resolves with
 * Icecast's answer, or `streaming` when it took the stream without a word (accepted).
 */
function trySource(mount: string, password: string): Promise<number | 'streaming'> {
  return new Promise((resolve) => {
    const req = http.request(`${base}${mount}`, {
      method: 'PUT',
      headers: {
        authorization: `Basic ${Buffer.from(`source:${password}`).toString('base64')}`,
        'content-type': 'audio/mpeg',
        'ice-name': 'intruder',
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      resolve('streaming');
    }, 2000);
    req.on('response', (res) => {
      clearTimeout(timer);
      res.resume();
      req.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => undefined);
    // A few MPEG frame headers' worth of bytes; Icecast doesn't decode them.
    req.write(Buffer.alloc(4096, 0xff));
  });
}

const admin = createIcecastAdmin({ url: base, user: 'admin', password: 'ondes-it-admin' });

async function waitFor<T>(what: string, find: () => Promise<T | undefined>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const found = await find();
      if (found !== undefined) return found;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`, { cause: last });
    await new Promise((r) => setTimeout(r, 200));
  }
}

const source = (stats: IcecastStats, mount: string) =>
  stats.sources.find((s) => s.mount === mount && s.connected);
/** Declared in the config, connected or not. */
const declared = (stats: IcecastStats, mount: string) =>
  stats.sources.find((s) => s.mount === mount);

/** A listener that records what it receives and when. */
function listen(path: string) {
  const chunks: { at: number; bytes: Buffer }[] = [];
  let ended: number | undefined;
  let headers: http.IncomingHttpHeaders = {};
  const req = http.get(`${base}${path}`, (res) => {
    headers = res.headers;
    res.on('data', (bytes: Buffer) => chunks.push({ at: Date.now(), bytes }));
    res.on('close', () => {
      ended = Date.now();
    });
  });
  req.on('error', () => {
    ended ??= Date.now();
  });
  return {
    headers: () => headers,
    bytes: () => Buffer.concat(chunks.map((c) => c.bytes)),
    received: () => chunks.reduce((n, c) => n + c.bytes.length, 0),
    ended: () => ended,
    /** Longest silence between two chunks (or since the last one) in [from, to]. */
    maxGap(from: number, to = Date.now()) {
      let prev = from;
      let gap = 0;
      for (const c of chunks) {
        if (c.at < from || c.at > to) continue;
        gap = Math.max(gap, c.at - prev);
        prev = c.at;
      }
      return Math.max(gap, to - prev);
    },
    close: () => req.destroy(),
  };
}
type Listener = ReturnType<typeof listen>;

async function receivedMore(l: Listener, bytes: number, timeoutMs = 10_000) {
  const start = l.received();
  await waitFor(
    `${bytes} more bytes`,
    async () => (l.received() >= start + bytes ? true : undefined),
    timeoutMs,
  );
}

let tdb: TestDatabase;
let scope: StationScope;
let otherScope: StationScope;
let sync: IcecastConfigSync;
const listeners: Listener[] = [];
const invalid: StationOutputsError[] = [];

beforeAll(async () => {
  tdb = await createTestDatabase();
  const system = { type: 'system', name: 'icecast-it' } as const;
  const org = await createOrganization(tdb.db, system, { slug: 'icecast-it', name: 'Icecast IT' });
  const orgScope = await resolveOrgScope(tdb.db, org.id);
  const st = await createStation(
    tdb.db,
    { actor: system, scope: orgScope },
    { slug: 'it', name: 'Icecast IT', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(tdb.db, org.id, st.id);
  itPassword = icecastSourcePassword(MASTER, st.id);
  // Another station, default outputs (/other/mp3, /other/aac), no engine running.
  const other = await createStation(
    tdb.db,
    { actor: system, scope: orgScope },
    { slug: 'other', name: 'Other FM', timezone: 'Europe/Paris' },
  );
  otherScope = await resolveStationScope(tdb.db, org.id, other.id);
  await tdb.db
    .update(station)
    .set({
      engineSettings: {
        outputs: [
          { mount: 'it/mp3', format: 'mp3', bitrate: 128, intro: true, maxListeners: 50 },
          { mount: 'it/aac', format: 'aac', bitrate: 128 },
        ],
      },
    })
    .where(eq(station.id, st.id));

  sync = createIcecastConfigSync({
    db: tdb.db,
    path: configPath,
    config: { hostname: 'localhost' },
    sourcePasswordFor: (st) => icecastSourcePassword(MASTER, st.id),
    assetsDir,
    // The test process and Icecast's container don't share a uid (CI).
    fileMode: 0o644,
    onConfigInvalid: (err) => invalid.push(err),
  });

  await compose('down', '-v', '--remove-orphans');
  // Created here, as the test's user, before any container mounts them: Docker would create a
  // missing bind-mount source as root, and on Linux the test could then not write the config.
  mkdirSync(dirname(configPath), { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  // The fallback and intro files first: the config only refers to files that exist.
  await compose('run', '--rm', 'assets');
  const first = await sync.syncNow();
  expect(first.changed).toBe(true);
  expect(first.mounts.find((m) => m.mount === '/it/mp3')).toMatchObject({
    fallbackFile: '/_ondes/it/mp3.fallback.mp3',
    introFile: '/_ondes/it/mp3.intro.mp3',
  });
  // No file for the other station: no fallback configured.
  expect(first.mounts.find((m) => m.mount === '/other/mp3')).not.toHaveProperty('fallbackFile');
  expect((await sync.syncNow()).changed).toBe(false);

  await compose('up', '-d', '--wait', 'icecast');
  await compose('up', '-d', 'source');
  await waitFor('both sources', async () => {
    const stats = await admin.stats();
    return source(stats, '/it/mp3') && source(stats, '/it/aac') ? true : undefined;
  });
}, 300_000);

afterAll(async () => {
  for (const l of listeners) l.close();
  // ICECAST_IT_KEEP=1 leaves the stack up to look at it.
  if (!process.env.ICECAST_IT_KEEP) {
    await compose('down', '-v', '--remove-orphans').catch(() => undefined);
  }
  await tdb?.drop();
}, 120_000);

describe('Icecast with the generated config', () => {
  it('applies the mount settings and shows UTF-8 stream names', async () => {
    const stats = await admin.stats();
    expect(source(stats, '/it/mp3')).toMatchObject({
      maxListeners: 50,
      serverName: NAME,
      contentType: 'audio/mpeg',
    });
    expect(source(stats, '/it/aac')).toMatchObject({
      maxListeners: 500,
      serverName: NAME,
      contentType: 'audio/aac',
    });
  });

  it("refuses a station's engine on another station's mounts", async () => {
    const otherPassword = icecastSourcePassword(MASTER, otherScope.stationId);
    // The test station's password, on the other station's mount and on an undeclared one.
    expect(await trySource('/other/mp3', itPassword)).toBe(401);
    expect(await trySource('/nobody/mp3', itPassword)).toBe(401);
    // The other station's own password works on its mount...
    expect(await trySource('/other/aac', otherPassword)).toBe('streaming');
    // ...and not on the test station's.
    expect(await trySource('/it/opus', otherPassword)).toBe(401);
  });

  it('plays the intro first to a new listener', async () => {
    const intro = Buffer.from(await (await fetch(`${base}/_ondes/it/mp3.intro.mp3`)).arrayBuffer());
    expect(intro.length).toBeGreaterThan(1000);
    const l = listen('/it/mp3');
    listeners.push(l);
    await waitFor('the intro', async () => (l.received() > intro.length ? true : undefined));
    expect(l.headers()['content-type']).toBe('audio/mpeg');
    // The header is raw UTF-8 (Node reads header bytes as Latin-1).
    expect(Buffer.from(String(l.headers()['icy-name']), 'latin1').toString('utf8')).toBe(NAME);
    expect(l.bytes().subarray(0, intro.length).equals(intro)).toBe(true);
    l.close();
  });

  it('records listener counts', async () => {
    const l = listen('/it/aac');
    listeners.push(l);
    await receivedMore(l, 10_000);
    const poller = createListenerStatsPoller({
      admin,
      mounts: sync.mounts,
      record: (samples) => recordListenerSamples(tdb.db, samples),
    });
    const samples = await waitFor('one listener on /it/aac', async () => {
      const s = await poller.pollOnce();
      return s.find((x) => x.mount === '/it/aac')?.listeners === 1 ? s : undefined;
    });
    expect(samples.find((s) => s.mount === '/it/aac')).toMatchObject({ sourceConnected: true });
    const rows = await listListenerStats(tdb.db, scope, {
      from: new Date(Date.now() - 120_000),
      to: new Date(Date.now() + 60_000),
    });
    expect(rows.some((r) => r.mount === '/it/aac' && r.listenersMax === 1)).toBe(true);
    l.close();
  });

  it('reloads a changed config without cutting listeners', async () => {
    const l = listen('/it/mp3');
    listeners.push(l);
    await receivedMore(l, 20_000);

    // A settings change: lower max-listeners, add an Opus mount.
    await tdb.db
      .update(station)
      .set({
        engineSettings: {
          outputs: [
            { mount: 'it/mp3', format: 'mp3', bitrate: 128, intro: true, maxListeners: 40 },
            { mount: 'it/aac', format: 'aac', bitrate: 128 },
            { mount: 'it/opus', format: 'opus', bitrate: 96 },
          ],
        },
      })
      .where(eq(station.id, scope.stationId));
    const reloadAt = Date.now();
    expect((await sync.syncNow()).changed).toBe(true);
    await waitFor('the reload', async () =>
      declared(await admin.stats(), '/it/mp3')?.maxListeners === 40 ? true : undefined,
    );
    const appliedMs = Date.now() - reloadAt;
    await receivedMore(l, 20_000);

    const gap = l.maxGap(reloadAt);
    console.info(`[icecast reload] applied after ${appliedMs} ms, longest listener gap ${gap} ms`);
    expect(l.ended()).toBeUndefined();
    // Icecast sends a 128k stream in bursts of a few hundred ms; a reload adds nothing visible.
    expect(gap).toBeLessThan(1500);
    expect(sync.mounts().map((m) => m.mount)).toEqual([
      '/it/mp3',
      '/it/aac',
      '/it/opus',
      '/other/mp3',
      '/other/aac',
    ]);
    l.close();
  });

  it('keeps an unparsable config from taking effect', async () => {
    await writeIfChanged(configPath, '<icecast><broken', 0o644);
    await new Promise((r) => setTimeout(r, 2500));
    expect(declared(await admin.stats(), '/it/mp3')?.maxListeners).toBe(40);
    // Back to the real one.
    await writeIfChanged(configPath, '', 0o644);
    expect((await sync.syncNow()).changed).toBe(true);
  });

  it("keeps a station's last good mounts when its settings break", async () => {
    await tdb.db
      .update(station)
      .set({ engineSettings: { outputs: [{ mount: 'it/mp3', format: 'mp3', bitrate: 128 }] } })
      .where(eq(station.id, otherScope.stationId));
    const result = await sync.syncNow();
    expect(invalid.map((e) => e.stationId)).toEqual([otherScope.stationId]);
    expect(result.invalid).toHaveLength(1);
    // Still served with its previous mounts; the test station is untouched.
    expect(sync.mounts().map((m) => m.mount)).toEqual([
      '/it/mp3',
      '/it/aac',
      '/it/opus',
      '/other/mp3',
      '/other/aac',
    ]);
    expect((await sync.syncNow()).invalid).toHaveLength(1);
    expect(invalid).toHaveLength(1); // reported once
    await tdb.db
      .update(station)
      .set({ engineSettings: {} })
      .where(eq(station.id, otherScope.stationId));
    expect((await sync.syncNow()).invalid).toEqual([]);
  });

  it('moves listeners to the fallback when the engine stops, and back', async () => {
    const l = listen('/it/mp3');
    listeners.push(l);
    await receivedMore(l, 20_000);
    const changes: Array<[string, boolean]> = [];
    const poller = createListenerStatsPoller({
      admin,
      mounts: sync.mounts,
      record: async () => undefined,
      onSourceChange: (m, connected) => changes.push([m.mount, connected]),
    });
    await poller.pollOnce();

    const stopAt = Date.now();
    await compose('stop', '-t', '0', 'source');
    await waitFor('listener on the fallback file', async () =>
      (source(await admin.stats(), '/_ondes/it/mp3.fallback.mp3')?.listeners ?? 0) >= 1
        ? true
        : undefined,
    );
    await receivedMore(l, 50_000);
    console.info(
      `[icecast fallback] longest listener gap when the engine stopped: ${l.maxGap(stopAt)} ms`,
    );
    expect(l.ended()).toBeUndefined();

    const samples = await poller.pollOnce();
    expect(samples.find((s) => s.mount === '/it/mp3')).toMatchObject({
      listeners: 1,
      sourceConnected: false,
    });
    expect(changes).toContainEqual(['/it/mp3', false]);

    await compose('start', 'source');
    await waitFor('listener back on the stream', async () =>
      source(await admin.stats(), '/it/mp3')?.listeners === 1 ? true : undefined,
    );
    await poller.pollOnce();
    expect(changes.filter(([m]) => m === '/it/mp3').at(-1)).toEqual(['/it/mp3', true]);
    expect(l.ended()).toBeUndefined();
    l.close();
  }, 60_000);

  it('disconnects every listener on a restart (what a reload avoids)', async () => {
    const l = listen('/it/aac');
    listeners.push(l);
    await receivedMore(l, 10_000);
    const at = Date.now();
    await compose('restart', '-t', '5', 'icecast');
    await waitFor('the listener to be cut', async () =>
      l.ended() !== undefined ? true : undefined,
    );
    console.info(`[icecast restart] listener cut after ${(l.ended() ?? at) - at} ms`);
    expect(l.ended()).toBeDefined();
  }, 60_000);

  it('brings Icecast back when a reload deadlocks it (watchdog)', async () => {
    // Icecast 2.5.0: a listclients request on a mount that had a listener, then a reload,
    // and the server stops answering. The entrypoint's watchdog kills it; compose restarts it.
    await waitFor('the engine reconnected', async () =>
      source(await admin.stats(), '/it/aac') ? true : undefined,
    );
    const l = listen('/it/aac');
    listeners.push(l);
    await receivedMore(l, 10_000);
    const auth = `Basic ${Buffer.from('admin:ondes-it-admin').toString('base64')}`;
    await fetch(`${base}/admin/listclients?mount=/it/aac`, { headers: { authorization: auth } });
    l.close();
    await new Promise((r) => setTimeout(r, 500));

    await tdb.db
      .update(station)
      .set({
        engineSettings: {
          outputs: [{ mount: 'it/mp3', format: 'mp3', bitrate: 128, maxListeners: 30 }],
        },
      })
      .where(eq(station.id, scope.stationId));
    const at = Date.now();
    expect((await sync.syncNow()).changed).toBe(true);
    await waitFor(
      'Icecast back with the new config',
      async () =>
        declared(await admin.stats(), '/it/mp3')?.maxListeners === 30 ? true : undefined,
      60_000,
    );
    console.info(`[icecast watchdog] serving again ${Date.now() - at} ms after the reload`);
  }, 90_000);
});
