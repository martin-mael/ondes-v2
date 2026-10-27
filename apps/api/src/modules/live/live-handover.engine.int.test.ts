import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { EngineEvent, EngineState } from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EngineBadRequestError } from '../engine/adapter/errors.ts';
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

// DJ handover on the real engine (#66, ADR 0038), recorded. The station template runs in the
// pinned Liquidsoap image with a WAV recorder on its final mix; two more Liquidsoap containers
// play DJs streaming MP3 to the two inputs of the pool, each its own tone:
//   A 440 Hz (queue) → DJ 1 220 Hz (takeover) → DJ 2 330 Hz (handover, 3 s crossfade)
//   → DJ 2 muted for 2 s, then unmuted → DJ 1 again (handover with a 0 s fade: a cut).
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

/** A stand-in DJ streaming a tone to one mount of the pool. */
function startDj(name: string, mount: string, freq: number): void {
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

  const rendered = renderStationScript({
    stationId: `live-handover-${run}`,
    name: 'DJ handover test',
    paths: { safetyDir: '/work/safety', emergencyFile: '/work/missing.wav' },
    crossfade: { duration: 1 },
    // Processing off, so the recording holds the sources' own tones and levels.
    processing: { compressor: { enabled: false }, limiter: { enabled: false } },
    icecast: { host: '127.0.0.1', port: 9 },
    outputs: [{ mount: 'test.mp3', format: 'mp3', bitrate: 128 }],
    live: { enabled: true, mount: 'live', inputs: 2, buffer: 2, maxBuffer: 5 },
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
    stationId: `live-handover-${run}`,
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
    const [S1, S2, S3] = [randomUUID(), randomUUID(), randomUUID()];
    await engine.push({ item_id: 'A', uri: '/work/a.wav', title: 'A' });
    await until('A on air', (s) => s.on_air.item_id === 'A');

    // Both DJs connect and wait; the second waits while the first is on air.
    startDj('dj1', 'live', TONES.dj1);
    startDj('dj2', 'live-2', TONES.dj2);
    await until('both DJs ready', (s) => s.live.inputs?.every((i) => i.ready) === true, 30_000);
    await engine.setLive(true, { input: 1, sessionId: S1 });
    await until('DJ 1 on air', (s) => s.live.on_air === 1);
    await sleep(3000);

    // The handover, with a 3 s crossfade. A fade past 10 s is refused, the gate untouched.
    await expect(
      engine.setLive(true, { input: 2, sessionId: S2, fadeMs: 11_000 }),
    ).rejects.toBeInstanceOf(EngineBadRequestError);
    expect((await engine.state()).live.session_id).toBe(S1);
    await engine.setLive(true, { input: 2, sessionId: S2, fadeMs: FADE_MS });
    await until('DJ 2 on air', (s) => s.live.on_air === 2);
    await sleep(FADE_MS + 2000);

    // Mute DJ 2 for 2 s: silence on air, the DJ stays connected and on air; pre-listen still
    // has their stream.
    expect(await engine.muteLive(2, true)).toBe(true);
    const state = await engine.state();
    expect(state.live.inputs?.[1]).toMatchObject({ connected: true, muted: true });
    expect(state.live.on_air).toBe(2);
    const listen = new AbortController();
    const stream = await engine.listen(2, listen.signal);
    expect(stream?.status).toBe(200);
    listen.abort();
    await sleep(2000);
    expect(await engine.muteLive(2, false)).toBe(true);
    await sleep(3000);

    // Back to DJ 1 with no crossfade: a cut.
    await engine.setLive(true, { input: 1, sessionId: S3, fadeMs: 0 });
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
