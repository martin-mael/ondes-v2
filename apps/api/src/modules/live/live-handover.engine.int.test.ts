import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createOrganization,
  createStation,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
} from '@ondes/db';
import { createTestDatabase } from '@ondes/db/testing';
import type { Actor, EngineEvent, EngineState } from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EngineBadRequestError } from '../engine/adapter/errors.ts';
import { createEngineAdapter, type EngineAdapter } from '../engine/adapter/index.ts';
import { renderStationScript } from '../engine/config/index.ts';
import { createLiveHandovers, type LiveHandovers } from './handover.ts';
import { createStreamer } from './repo.ts';
import { createLiveSwitcher, type LiveSwitchEngine, type LiveSwitcher } from './switching.ts';
import {
  analyse,
  readWavChannel,
  silentWindows,
  toneLevels,
  toneRuns,
  writeTone,
} from './testing/tones.ts';

// DJ handover on the real engine (#66, ADR 0038), recorded. The station template runs in the
// pinned Liquidsoap image with a WAV recorder on its final mix; two more Liquidsoap containers
// play DJs streaming MP3 to the two inputs of the pool, each its own tone:
//   A 440 Hz (queue) → DJ 1 220 Hz (takeover) → DJ 2 330 Hz (a scheduled handover, 3 s
//   crossfade) → DJ 2 muted for 2 s, then unmuted → DJ 1 again (handover with a 0 s fade: a cut).
// Node's side is the real one (switcher, scheduled handovers, a throwaway database); a stub of
// the harbor auth callback tells the engine which streamer each DJ is, as the api does.
// The recording must show no dead air and no level bump through each handover: the old DJ
// fades out while the new one fades in over the asked duration, at a steady total level
// (equal-power fades), and the cut leaves neither a gap nor an overlap. Own network and
// containers, control port on a random 127.0.0.1 port: never the shared dev stack.

const repo = resolve(import.meta.dirname, '../../../../..');
const TOKEN = `live-handover-test-${randomBytes(8).toString('hex')}`;
const PASSWORD = `shared-${randomBytes(8).toString('hex')}`;
const run = randomBytes(4).toString('hex');
const network = `ondes-live-handover-${run}`;
const engineName = `ondes-live-handover-engine-${run}`;
const work = join(tmpdir(), `ondes-live-handover-${run}`);
const TONES = { A: 440, dj1: 220, dj2: 330 };
const FADE_MS = 3000;

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

const system: Actor = { type: 'system', name: 'live-handover-test' };
const logger = { info: () => {}, warn: () => {}, error: () => {} };

let engine: EngineAdapter;
let tdb: Awaited<ReturnType<typeof createTestDatabase>>;
let scope: StationScope;
let switcher: LiveSwitcher;
let handovers: LiveHandovers;
let auth: Server;
/** Streamer ids by DJ (their source login's user name). */
const streamers: Record<string, string> = {};

async function until(what: string, ok: (s: EngineState) => boolean, ms = 20_000) {
  let last: EngineState | undefined;
  for (let waited = 0; waited < ms; waited += 200) {
    last = await engine.state();
    if (ok(last)) return last;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last?.live)}`);
}

/** A stand-in DJ streaming a tone to one mount of the pool. */
function startDj(name: string, mount: string, freq: number): void {
  writeFileSync(
    join(work, `${name}.liq`),
    [
      'settings.log.stdout := true',
      'settings.log.level := 2',
      `output.icecast(%mp3(bitrate=192), host=${JSON.stringify(engineName)}, port=8005,`,
      `  user=${JSON.stringify(name)}, password=${JSON.stringify(PASSWORD)},`,
      `  mount=${JSON.stringify(mount)},`,
      `  sine(amplitude=0.5, ${freq.toFixed(1)}))`,
    ].join('\n'),
  );
  docker([
    'run',
    '-d',
    '--name',
    `ondes-live-handover-${name}-${run}`,
    '--network',
    network,
    ...user,
    '-v',
    `${work}:/work`,
    liquidsoapImage(),
    `/work/${name}.liq`,
  ]);
}

beforeAll(async () => {
  mkdirSync(join(work, 'safety'), { recursive: true });
  writeTone(join(work, 'a.wav'), TONES.A, 120);

  tdb = await createTestDatabase();
  const org = await createOrganization(tdb.db, system, { slug: `ho-${run}`, name: 'Org' });
  const st = await createStation(
    tdb.db,
    { actor: system, scope: await resolveOrgScope(tdb.db, org.id) },
    { slug: `ho-fm-${run}`, name: 'FM', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(tdb.db, org.id, st.id);
  for (const username of ['dj1', 'dj2']) {
    const created = await createStreamer(
      tdb.db,
      { actor: system, scope },
      { displayName: username, username, anyTime: true },
    );
    streamers[username] = created.streamer.id;
  }
  // The harbor auth callback, stubbed: the right password and a known DJ get their streamer id.
  auth = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const login = JSON.parse(body) as { user: string; password: string };
      const id = streamers[login.user];
      res.writeHead(id && login.password === PASSWORD ? 200 : 403, {
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ streamer_id: id ?? null }));
    });
  });
  await new Promise<void>((ok) => auth.listen(0, '0.0.0.0', ok));
  const authPort = (auth.address() as AddressInfo).port;

  const rendered = renderStationScript({
    stationId: `live-handover-${run}`,
    name: 'DJ handover test',
    paths: { safetyDir: '/work/safety', emergencyFile: '/work/missing.wav' },
    crossfade: { duration: 1 },
    // Processing off, so the recording holds the sources' own tones and levels.
    processing: { compressor: { enabled: false }, limiter: { enabled: false } },
    icecast: { host: '127.0.0.1', port: 9 },
    outputs: [{ mount: 'test.mp3', format: 'mp3', bitrate: 128 }],
    live: {
      enabled: true,
      mount: 'live',
      inputs: 2,
      buffer: 2,
      maxBuffer: 5,
      authUrl: `http://host.docker.internal:${authPort}/live-auth`,
    },
  });
  // Test-only recorder of the final mix, appended after the outputs.
  writeFileSync(
    join(work, 'station.liq'),
    `${rendered.script}\noutput.file(%wav(stereo=true, samplesize=16), "/work/output.wav", radio)\n`,
  );

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
    '-e',
    `ENGINE_LIVE_PASSWORD=${PASSWORD}`,
    '-e',
    'ICECAST_SOURCE_PASSWORD=unused',
    '-p',
    '127.0.0.1::7000',
    '-v',
    `${work}:/work`,
    liquidsoapImage(),
    '/work/station.liq',
  ]);
  const port = docker(['port', engineName, '7000/tcp']).split('\n')[0]?.split(':').pop();
  engine = createEngineAdapter({
    stationId: `live-handover-${run}`,
    baseUrl: `http://127.0.0.1:${port}`,
    token: TOKEN,
  });
  const engineFor = async (id: string) =>
    id === scope.stationId ? (engine as LiveSwitchEngine) : undefined;
  switcher = createLiveSwitcher({ db: tdb.db, engineFor, logger });
  handovers = createLiveHandovers({ db: tdb.db, switcher, engineFor, logger });
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

afterAll(async () => {
  handovers?.close();
  auth?.close();
  await tdb?.drop();
  for (const id of docker(['ps', '-aq', '--filter', `name=ondes-live-handover-.*-${run}`], false)
    .split('\n')
    .filter(Boolean))
    docker(['rm', '-f', id], false);
  docker(['network', 'rm', network], false);
  if (!process.env.KEEP_LIVE_HANDOVER_WORK) rmSync(work, { recursive: true, force: true });
});

/** First window from `from` on where `ok` holds for `windows` windows in a row. */
function firstSustained(
  levels: { at: number; db: number }[],
  from: number,
  ok: (db: number) => boolean,
  windows = 3,
): number {
  const i = levels.findIndex(
    (w, n) => w.at >= from && levels.slice(n, n + windows).every((x) => ok(x.db)),
  );
  if (i < 0) throw new Error(`no sustained window after ${from} s`);
  return levels[i]?.at ?? 0;
}

describe('DJ handover on the real engine', () => {
  it('hands over between two connected DJs with no silence and no overlap glitch', async () => {
    const ctx = { actor: system, scope };
    await engine.push({ item_id: 'A', uri: '/work/a.wav', title: 'A' });
    await until('A on air', (s) => s.on_air.item_id === 'A');

    // Both DJs connect and wait; the second waits while the first is on air.
    startDj('dj1', 'live', TONES.dj1);
    startDj('dj2', 'live-2', TONES.dj2);
    await until('both DJs ready', (s) => s.live.inputs?.every((i) => i.ready) === true, 30_000);
    expect((await engine.state()).live.inputs?.map((i) => i.streamer_id)).toEqual([
      streamers.dj1,
      streamers.dj2,
    ]);
    const S1 = (await switcher.goLive(ctx, 1)).id;
    await until('DJ 1 on air', (s) => s.live.on_air === 1);

    // A fade past 10 s is refused by the engine, the gate untouched.
    await expect(
      engine.setLive(true, { input: 2, sessionId: S1, fadeMs: 11_000 }),
    ).rejects.toBeInstanceOf(EngineBadRequestError);
    expect((await engine.state()).live.session_id).toBe(S1);

    // The handover, scheduled 3 s ahead with a 3 s crossfade: found on whichever input DJ 2 is
    // connected, run by the timer the schedule armed.
    const at = new Date(Date.now() + 3000);
    const scheduled = await handovers.schedule(ctx, {
      streamerId: streamers.dj2 ?? '',
      at,
      fadeMs: FADE_MS,
    });
    await until('DJ 2 on air', (s) => s.live.on_air === 2, 10_000);
    expect(Date.now()).toBeGreaterThanOrEqual(at.getTime());
    let done = (await handovers.list(scope)).find((x) => x.id === scheduled.id);
    for (let i = 0; i < 50 && done?.status !== 'done'; i++) {
      await sleep(100);
      done = (await handovers.list(scope)).find((x) => x.id === scheduled.id);
    }
    expect(done).toMatchObject({ status: 'done', reason: null });
    const S2 = done?.sessionId ?? '';
    expect((await engine.state()).live.session_id).toBe(S2);
    await sleep(FADE_MS + 2000);

    // Mute DJ 2 for 2 s: silence on air, the DJ stays connected and on air; pre-listen still
    // has their stream.
    expect(await switcher.mute(ctx, 2, true)).toBe(true);
    const state = await engine.state();
    expect(state.live.inputs?.[1]).toMatchObject({ connected: true, muted: true });
    expect(state.live.on_air).toBe(2);
    const listen = new AbortController();
    const stream = await engine.listen(2, listen.signal);
    expect(stream?.status).toBe(200);
    listen.abort();
    await sleep(2000);
    expect(await switcher.mute(ctx, 2, false)).toBe(true);
    await sleep(3000);

    // Back to DJ 1 with no crossfade: a cut.
    const S3 = (await switcher.goLive(ctx, 1, 'manual', undefined, { fadeMs: 0 })).id;
    await until('DJ 1 on air again', (s) => s.live.on_air === 1);
    await sleep(3000);

    const events: EngineEvent[] = await engine.events(0);
    expect(
      events.flatMap((e) =>
        e.type === 'track.started' ? [[e.data.source, e.data.live_session_id ?? null]] : [],
      ),
    ).toEqual([
      ['queue', null],
      ['live', S1],
      ['live', S2],
      ['live', S3],
    ]);
    expect(
      events.flatMap((e) => (e.type === 'live.muted' ? [[e.data.input, e.data.muted]] : [])),
    ).toEqual([
      [2, true],
      [2, false],
    ]);

    // A mute never waits for the next DJ: DJ 2 hangs up, muting their input is refused, and
    // the engine (on_connect and on_disconnect) has it unmuted for whoever connects there.
    await expect(switcher.mute(ctx, 2, true)).resolves.toBe(true);
    docker(['rm', '-f', `ondes-live-handover-dj2-${run}`], false);
    await until('DJ 2 gone', (s) => s.live.inputs?.[1]?.connected === false);
    expect((await engine.state()).live.inputs?.[1]?.muted).toBe(false);
    await expect(switcher.mute(ctx, 2, true)).rejects.toMatchObject({
      code: 'live_input_not_connected',
    });
    await expect(engine.muteLive(2, true)).rejects.toMatchObject({ status: 409 });

    // Stop the engine so the recorder closes its file, then listen.
    docker(['stop', '-t', '5', engineName], false);
    const { rate, samples } = readWavChannel(join(work, 'output.wav'));
    const windows = analyse(samples, rate);
    const runs = toneRuns(windows, TONES);
    expect(runs.map((r) => r.label)).toEqual(['A', 'dj1', 'dj2', 'dj1']);
    const [, dj1, dj2, back] = runs;
    if (!dj1 || !dj2 || !back) throw new Error('missing runs');
    const end = back.to;
    const one = toneLevels(samples, rate, TONES.dj1, dj1.from, end);
    const two = toneLevels(samples, rate, TONES.dj2, dj1.from, end);

    // The crossfade: DJ 2 rises out of the floor, then DJ 1 sinks into it, about 3 s apart
    // (-40 dBFS is 1/50 of the tone's level, reached within 2 % of each end of a sine fade).
    const inStart = firstSustained(two, dj1.from, (db) => db > -40);
    const outEnd = firstSustained(one, inStart, (db) => db < -40);
    expect(outEnd - inStart).toBeGreaterThan(FADE_MS / 1000 - 0.3);
    expect(outEnd - inStart).toBeLessThan(FADE_MS / 1000 + 0.3);

    // The mute: about 2 s under -60 dBFS, ramps included, and nothing else silent on air.
    const muted = windows.filter((w) => w.at > outEnd && w.at < back.from && w.db < -60);
    expect(muted.length).toBeGreaterThan(17);
    expect(muted.length).toBeLessThan(25);
    const muteFrom = muted[0]?.at ?? 0;
    const muteTo = (muted.at(-1)?.at ?? 0) + 0.1;
    // Ramps of 100 ms: at most one window between full level and silence on each side.
    expect(
      windows.filter(
        (w) => w.at >= muteFrom - 0.3 && w.at < muteTo + 0.3 && w.db >= -60 && w.db < -12,
      ).length,
    ).toBeLessThanOrEqual(4);
    expect([
      ...silentWindows(windows, dj1.from, muteFrom - 0.2),
      ...silentWindows(windows, muteTo + 0.2, end),
    ]).toEqual([]);

    // A steady level through both handovers: the DJs play at -9 dBFS; equal-power fades keep
    // the sum there, where both at full level would be +3 dB and a linear fade -3 dB at mid.
    const through = (from: number, to: number) =>
      windows.filter((w) => w.at >= from && w.at < to).map((w) => w.db);
    const crossfade = through(inStart - 0.5, outEnd + 0.5);
    expect(Math.max(...crossfade)).toBeLessThan(-9 + 1);
    expect(Math.min(...crossfade)).toBeGreaterThan(-9 - 1);

    // The cut: DJ 1 is back within a window of DJ 2 leaving, no gap, no overlap.
    const cutIn = firstSustained(one, muteTo, (db) => db > -40);
    const cutOut = firstSustained(two, muteTo + 1, (db) => db < -40);
    expect(Math.abs(cutOut - cutIn)).toBeLessThanOrEqual(0.2);
    const cut = through(cutIn - 0.5, cutIn + 0.5);
    expect(Math.max(...cut)).toBeLessThan(-9 + 1);
    expect(Math.min(...cut)).toBeGreaterThan(-9 - 3);
  }, 240_000);
});
