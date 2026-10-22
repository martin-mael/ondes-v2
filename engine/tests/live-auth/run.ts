// Live auth end to end (#63): the rendered station template's `input.harbor` asks the api's
// real harbor auth handler (on a throwaway database) about each source login, and only DJs
// with good credentials get connected.
//
//   node engine/tests/live-auth/run.ts
//
// Needs docker, ffmpeg (the stand-in DJ: an MP3 Icecast source client) and the dev stack's
// Postgres (`pnpm dev:up`). Runs its own engine container (random name, control and live ports
// on random 127.0.0.1 ports), never the shared dev stack's. See README.md.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderStationScript } from '../../../apps/api/src/modules/engine/config/index.ts';
import { createLiveAuthHandler } from '../../../apps/api/src/modules/live/auth.ts';
import { createStreamer } from '../../../apps/api/src/modules/live/repo.ts';
import { liveAuthUrl } from '../../../apps/api/src/modules/live/url.ts';
import {
  auditLog,
  createOrganization,
  createStation,
  resolveOrgScope,
  resolveStationScope,
} from '../../../packages/db/src/index.ts';
import { createTestDatabase } from '../../../packages/db/src/testing.ts';
import { type Actor, engineStateSchema } from '../../../packages/shared/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const TOKEN = `live-auth-test-${randomBytes(8).toString('hex')}`;
const system: Actor = { type: 'system', name: 'live-auth-test' };

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

const failures: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const work = join(here, '.work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'safety'), { recursive: true });

  // A station and its streamers, on a throwaway database.
  const tdb = await createTestDatabase();
  const db = tdb.db;
  const org = await createOrganization(db, system, {
    slug: `la-${randomBytes(3).toString('hex')}`,
    name: 'Org',
  });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: `la-fm-${randomBytes(3).toString('hex')}`, name: 'FM', timezone: 'Europe/Paris' },
  );
  const scope = await resolveStationScope(db, org.id, st.id);
  const ctx = { actor: system, scope };
  const dj = await createStreamer(db, ctx, {
    displayName: 'DJ',
    username: 'dj-good',
    anyTime: true,
  });
  await createStreamer(db, ctx, {
    displayName: 'Off',
    username: 'dj-off',
    password: 'disabled-password-1',
    anyTime: true,
    enabled: false,
  });
  // No allowed show, no "any time": never inside a slot.
  await createStreamer(db, ctx, {
    displayName: 'Slotless',
    username: 'dj-slotless',
    password: 'slotless-password-1',
  });

  // The api's handler on a host port the engine container reaches.
  let authCalls = 0;
  const handle = createLiveAuthHandler({
    db,
    tokenFor: (id) => (id === st.id ? TOKEN : undefined),
    logger: { info: () => {}, warn: () => {}, error: console.error },
  });
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', async () => {
      authCalls++;
      const stationId = decodeURIComponent(req.url?.split('/')[4] ?? '');
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      const out = await handle({ stationId, headers: req.headers, body }).catch((err) => {
        console.error(err);
        return { status: 500, body: { error: 'failed' } };
      });
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '0.0.0.0', r));
  const apiPort = (server.address() as AddressInfo).port;

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
  writeFileSync(join(work, 'station.liq'), rendered.script);

  const name = `ondes-live-auth-test-${randomBytes(4).toString('hex')}`;
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--add-host',
    'host.docker.internal:host-gateway',
    ...(process.getuid && process.getgid
      ? ['--user', `${process.getuid()}:${process.getgid()}`, '-e', 'HOME=/tmp']
      : []),
    '-e',
    `ENGINE_CONTROL_TOKEN=${TOKEN}`,
    // Set, to prove the webhook wins over the shared password.
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
  const sources: ChildProcess[] = [];
  try {
    const portOf = (p: number) =>
      docker(['port', name, `${p}/tcp`])
        .split('\n')[0]
        ?.split(':')
        .pop();
    const base = `http://127.0.0.1:${portOf(7000)}/v1`;
    const livePort = portOf(8005);
    const state = async () =>
      engineStateSchema.parse(
        await (
          await fetch(`${base}/state`, {
            headers: { authorization: `Bearer ${TOKEN}` },
            signal: AbortSignal.timeout(5000),
          })
        ).json(),
      );

    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up = await fetch(`${base}/health`)
        .then((r) => r.ok)
        .catch(() => false);
      if (!up) await sleep(500);
    }
    if (!up) throw new Error(`engine did not start:\n${docker(['logs', name], false)}`);

    /** Streams a tone as an Icecast source; true if the engine reports a connected DJ. */
    const tryConnect = async (user: string, password: string) => {
      const url = `icecast://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${livePort}/live`;
      const ff = spawn(
        'ffmpeg',
        [
          ...['-hide_banner', '-loglevel', 'error', '-re'],
          ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '20'],
          ...['-c:a', 'libmp3lame', '-b:a', '128k', '-content_type', 'audio/mpeg', '-f', 'mp3'],
          url,
        ],
        { stdio: 'ignore' },
      );
      sources.push(ff);
      let exited = false;
      ff.on('exit', () => {
        exited = true;
      });
      let connected = false;
      for (let i = 0; i < 16 && !connected && !exited; i++) {
        await sleep(250);
        connected = (await state()).live.connected;
      }
      ff.kill('SIGKILL');
      for (let i = 0; i < 40 && (await state()).live.connected; i++) await sleep(250);
      return connected;
    };

    check(await tryConnect('dj-good', dj.password), 'good credentials: connected');
    check(!(await tryConnect('dj-good', 'wrong-password-123')), 'wrong password: refused');
    check(!(await tryConnect('nobody', dj.password)), 'unknown username: refused');
    check(!(await tryConnect('source', 'shared-password')), 'shared live password: refused');
    check(!(await tryConnect('dj-off', 'disabled-password-1')), 'disabled streamer: refused');
    check(!(await tryConnect('dj-slotless', 'slotless-password-1')), 'outside any slot: refused');
    check(
      await tryConnect('source', `dj-good:${dj.password}`),
      'Shoutcast-style username:password: connected',
    );
    check(authCalls >= 7, `the engine asked the api for every login (${authCalls})`);
    const connects = await db.select().from(auditLog);
    check(
      connects.filter((a) => a.action === 'streamer.connect').length === 2,
      'two accepted logins audited',
    );
  } finally {
    for (const s of sources) s.kill('SIGKILL');
    if (failures.length) console.log(docker(['logs', '--tail', '40', name], false));
    docker(['rm', '-f', name], false);
    server.close();
    await tdb.drop();
  }
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall live auth checks passed');
}

await main();
