import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { EngineEvent, EngineState } from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngineAdapter, type EngineAdapter } from '../engine/adapter/index.ts';
import { renderStationScript } from '../engine/config/index.ts';
import {
  analyse,
  readWavChannel,
  silentWindows,
  toneLevels,
  toneRuns,
  writeTone,
} from './testing/tones.ts';

// Harbor pool and live switching on the real engine (#64, ADR 0027), recorded. The station
// template runs in the pinned Liquidsoap image with a WAV recorder on its final mix; two
// more Liquidsoap containers play DJs streaming MP3 to two inputs of the pool. Every source
// plays its own tone, so the recording says what aired when:
//   A 440 Hz (queue, on air first) → DJ 1 220 Hz (takeover) → DJ 2 330 Hz (handover, asked
//   before DJ 2 is ready) → return jingle 880 Hz → B 660 Hz (the log's next item)
//   → DJ 2 again → X 770 Hz is missed during the show (passed over, as the feeder does)
//   → DJ 2 hangs up, no return file → C 550 Hz.
// The test checks there is no dead air from the first tone to the last, that the items the
// takeovers interrupted (A, then B) never come back and that X never airs. Own network and
// containers, control port on a random 127.0.0.1 port: never the shared dev stack.

const repo = resolve(import.meta.dirname, '../../../../..');
const TOKEN = `live-switch-test-${randomBytes(8).toString('hex')}`;
const PASSWORD = `shared-${randomBytes(8).toString('hex')}`;
const run = randomBytes(4).toString('hex');
const network = `ondes-live-switch-${run}`;
const engineName = `ondes-live-switch-engine-${run}`;
const work = join(tmpdir(), `ondes-live-switch-${run}`);
const TONES = { A: 440, B: 660, C: 550, X: 770, dj1: 220, dj2: 330, jingle: 880 };

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

let engine: EngineAdapter;

async function until(what: string, ok: (s: EngineState) => boolean, ms = 20_000) {
  let last: EngineState | undefined;
  for (let waited = 0; waited < ms; waited += 200) {
    last = await engine.state();
    if (ok(last)) return last;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last?.live)}`);
}

/** A stand-in DJ streaming a tone to one mount of the pool. Returns its container name. */
function startDj(name: string, mount: string, freq: number): string {
  const container = `ondes-live-switch-${name}-${run}`;
  writeFileSync(
    join(work, `${name}.liq`),
    [
      'settings.log.stdout := true',
      'settings.log.level := 2',
      `output.icecast(%mp3(bitrate=192), host=${JSON.stringify(engineName)}, port=8005,`,
      `  password=${JSON.stringify(PASSWORD)}, mount=${JSON.stringify(mount)},`,
      `  sine(amplitude=0.5, ${freq.toFixed(1)}))`,
    ].join('\n'),
  );
  docker([
    'run',
    '-d',
    '--name',
    container,
    '--network',
    network,
    ...user,
    '-v',
    `${work}:/work`,
    liquidsoapImage(),
    `/work/${name}.liq`,
  ]);
  return container;
}

beforeAll(async () => {
  mkdirSync(join(work, 'safety'), { recursive: true });
  writeTone(join(work, 'a.wav'), TONES.A, 90);
  writeTone(join(work, 'b.wav'), TONES.B, 90);
  writeTone(join(work, 'c.wav'), TONES.C, 90);
  writeTone(join(work, 'x.wav'), TONES.X, 90);
  writeTone(join(work, 'return.wav'), TONES.jingle, 2);

  const rendered = renderStationScript({
    stationId: `live-switch-${run}`,
    name: 'Live switching test',
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
      returnFile: '/work/return.wav',
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
    stationId: `live-switch-${run}`,
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

afterAll(() => {
  for (const id of docker(['ps', '-aq', '--filter', `name=ondes-live-switch-.*-${run}`], false)
    .split('\n')
    .filter(Boolean))
    docker(['rm', '-f', id], false);
  docker(['network', 'rm', network], false);
  if (!process.env.KEEP_LIVE_SWITCH_WORK) rmSync(work, { recursive: true, force: true });
});

describe('harbor pool and live switching on the real engine', () => {
  it('takes over, hands over and returns to the log with no dead air and no replay', async () => {
    const [S1, S2, S3] = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ['A', 'B', 'X', 'C'])
      await engine.push({ item_id: id, uri: `/work/${id.toLowerCase()}.wav`, title: id });
    await until('A on air', (s) => s.on_air.item_id === 'A');
    await sleep(2000);

    // DJ 1 connects and waits: connecting is not going on air.
    const dj1 = startDj('dj1', 'live', TONES.dj1);
    let state = await until('DJ 1 ready', (s) => s.live.inputs?.[0]?.ready === true);
    expect(state.on_air.item_id).toBe('A');
    expect(state.live).toMatchObject({ enabled: false, connected: true, on_air: null });
    expect(state.live.inputs?.map((i) => i.mount)).toEqual(['live', 'live-2']);

    // Takeover on input 1.
    await engine.setLive(true, { input: 1, sessionId: S1 });
    state = await until('DJ 1 on air', (s) => s.live.on_air === 1);
    expect(state.on_air.source).toBe('live');
    expect(state.live.session_id).toBe(S1);
    await sleep(3000);

    // DJ 2 connects to the second input while DJ 1 is on air, and the handover is asked at
    // once, before DJ 2 has buffered: DJ 1 stays on air until DJ 2 is ready.
    startDj('dj2', 'live-2', TONES.dj2);
    await until('DJ 2 connected', (s) => s.live.inputs?.[1]?.connected === true);
    await engine.setLive(true, { input: 2, sessionId: S2 });
    state = await engine.state();
    expect(state.live.inputs?.[1]?.ready).toBe(false);
    expect([state.live.on_air, state.on_air.source]).toEqual([1, 'live']);
    await until('DJ 2 on air', (s) => s.live.on_air === 2);
    await sleep(3000);

    // Hang DJ 1 up (the revocation path): DJ 2 stays on air.
    expect(await engine.disconnectLive(1)).toBe(true);
    state = await until('DJ 1 gone', (s) => s.live.inputs?.[0]?.connected === false, 5000);
    docker(['rm', '-f', dj1], false);
    expect(state.live.on_air).toBe(2);
    await sleep(2000);

    // Back to automation: the return jingle, then B, never A again.
    await engine.setLive(false);
    await until('B on air', (s) => s.on_air.item_id === 'B', 15_000);
    await sleep(4000);

    // A second show on input 2. During it X's time passes: the feeder passes it over (here,
    // by hand), and the queue keeps C, in order. DJ 2 hangs up and there is no return file
    // any more: C comes straight back, at full level.
    await engine.setLive(true, { input: 2, sessionId: S3 });
    await until('DJ 2 on air again', (s) => s.live.on_air === 2);
    await sleep(2000);
    expect((await engine.remove('X')).removed).toBe(1);
    rmSync(join(work, 'return.wav'));
    await sleep(1000);
    await engine.disconnectLive(2);
    // What Node does when the DJ on air hangs up: close the gate.
    await engine.setLive(false);
    docker(['rm', '-f', `ondes-live-switch-dj2-${run}`], false);
    await until('C on air', (s) => s.on_air.item_id === 'C', 15_000);
    await sleep(4000);

    const events: EngineEvent[] = await engine.events(0);
    const started = events.flatMap((e) =>
      e.type === 'track.started'
        ? [[e.data.source, e.data.item_id ?? e.data.live_session_id, e.data.live_input ?? null]]
        : [],
    );
    expect(started).toEqual([
      ['queue', 'A', null],
      ['live', S1, 1],
      ['live', S2, 2],
      ['queue', 'B', null],
      ['live', S3, 2],
      ['queue', 'C', null],
    ]);
    const connections = events.flatMap((e) =>
      e.type === 'live.connected' || e.type === 'live.disconnected' ? [[e.type, e.data.input]] : [],
    );
    expect(connections.slice(0, 4)).toEqual([
      ['live.connected', 1],
      ['live.connected', 2],
      ['live.disconnected', 1],
      ['live.disconnected', 2],
    ]);
    // Only what describes the client is forwarded, never its credentials.
    const connected = events.find((e) => e.type === 'live.connected');
    const names =
      connected?.type === 'live.connected' ? connected.data.headers.map(([k]) => k) : [];
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/^(user-agent|content-type|ice-|icy-)/i);

    // Stop the engine so the recorder closes its file, then listen.
    docker(['stop', '-t', '5', engineName], false);
    const { rate, samples } = readWavChannel(join(work, 'output.wav'));
    const windows = analyse(samples, rate);
    const runs = toneRuns(windows, TONES);
    expect(runs.map((r) => r.label)).toEqual(['A', 'dj1', 'dj2', 'jingle', 'B', 'dj2', 'C']);
    const first = runs[0]?.from ?? 0;
    const last = runs.at(-1)?.to ?? 0;
    expect(silentWindows(windows, first, last)).toEqual([]);
    // What a takeover interrupted is gone for good: nothing of A from the end of the first
    // takeover's fade (1 s), nothing of B from the end of the second's, and X never airs.
    // The tones play at -9 dBFS (a replay would show at -9 to -15). Transitions leak into
    // every frequency for one window: about -51 dBFS at a crossfade, -38 at a hang-up's cut.
    const takeovers = runs.filter((r) => r.label === 'dj1' || r.label === 'dj2');
    const afterFirst = takeovers[0]?.from ?? 0;
    const afterSecond = runs.filter((r) => r.label === 'dj2')[1]?.from ?? 0;
    for (const [tone, from] of [
      [TONES.A, afterFirst + 1],
      [TONES.B, afterSecond + 1],
      [TONES.X, first],
    ] as const) {
      const residue = toneLevels(samples, rate, tone, from, last);
      expect(residue.length).toBeGreaterThan(50);
      expect(residue.filter((w) => w.db > -30)).toEqual([]);
    }
  }, 240_000);
});
