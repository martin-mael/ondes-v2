import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { EngineState } from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyse, readWavChannel, toneRuns, writeTone } from '../../live/testing/tones.ts';
import { createEngineAdapter, type EngineAdapter } from '../adapter/index.ts';
import { renderStationScript } from '../config/index.ts';

// The engine-timed cut on the real engine (#46, ADR 0031), recorded: the station template
// in the pinned Liquidsoap image, with a WAV recorder on its final mix, driven through the
// adapter. Every item plays its own tone, so the recording says what aired when:
//   A 440 Hz (queue) → E1 660 Hz (scheduled: cuts A) → B 330 Hz (queue, after E1)
//   → E2 550 Hz (scheduled while E1 plays: cuts B at its own time).
// The next hard start, scheduled (and cancelled, and scheduled again) while E1 plays, must
// not disturb E1, and A must never come back. Own container, control port on a random
// 127.0.0.1 port: never the shared dev stack.

const repo = resolve(import.meta.dirname, '../../../../../..');
const TOKEN = `hard-start-test-${randomBytes(8).toString('hex')}`;
const run = randomBytes(4).toString('hex');
const engineName = `ondes-hard-start-engine-${run}`;
const work = join(tmpdir(), `ondes-hard-start-${run}`);
const TONES = { A: 440, E1: 660, B: 330, E2: 550 };
const E1_SECONDS = 6;

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
  for (let waited = 0; waited < ms; waited += 100) {
    last = await engine.state();
    if (ok(last)) return last;
    await sleep(100);
  }
  const seen = (await engine.events(0)).flatMap((e) =>
    e.type === 'track.started' || e.type === 'track.ended'
      ? [`${e.type} ${e.data.item_id} ${e.at.toFixed(2)}`]
      : [],
  );
  throw new Error(
    `timed out waiting for ${what}: ${JSON.stringify({ on_air: last?.on_air, seen })}`,
  );
}

beforeAll(async () => {
  mkdirSync(join(work, 'safety'), { recursive: true });
  writeTone(join(work, 'a.wav'), TONES.A, 60);
  writeTone(join(work, 'e1.wav'), TONES.E1, E1_SECONDS);
  writeTone(join(work, 'b.wav'), TONES.B, 60);
  writeTone(join(work, 'e2.wav'), TONES.E2, 4);
  const rendered = renderStationScript({
    stationId: `hard-start-${run}`,
    name: 'Hard start test',
    paths: { safetyDir: '/work/safety', emergencyFile: '/work/missing.wav' },
    crossfade: { duration: 1 },
    processing: { compressor: { enabled: false }, limiter: { enabled: false } },
    icecast: { host: '127.0.0.1', port: 9 },
    outputs: [{ mount: 'test.mp3', format: 'mp3', bitrate: 128 }],
  });
  writeFileSync(
    join(work, 'station.liq'),
    `${rendered.script}\noutput.file(%wav(stereo=true, samplesize=16), "/work/output.wav", radio)\n`,
  );
  docker([
    'run',
    '-d',
    '--name',
    engineName,
    ...user,
    '-e',
    `ENGINE_CONTROL_TOKEN=${TOKEN}`,
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
    stationId: `hard-start-${run}`,
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
  docker(['rm', '-f', engineName], false);
  if (!process.env.KEEP_HARD_START_WORK) rmSync(work, { recursive: true, force: true });
});

describe('the engine-timed cut on the real engine', () => {
  it('starts hard items at their time, one after the other, without disturbing the one on air', async () => {
    const schedule = engine.schedule;
    const unschedule = engine.unschedule;
    if (!schedule || !unschedule) throw new Error('the adapter has no schedule');

    await engine.push({ item_id: 'A', uri: '/work/a.wav', title: 'A' });
    await until('A on air', (s) => s.on_air.item_id === 'A');
    const e1At = Date.now() / 1000 + 3;
    await schedule({ item_id: 'E1', uri: '/work/e1.wav', at: e1At, title: 'E1' });
    expect((await engine.state()).scheduled).toMatchObject({ item_id: 'E1' });
    let state = await until('E1 on air', (s) => s.on_air.item_id === 'E1', 10_000);
    expect(state.scheduled).toBeNull();
    // What the feeder does once the hard item airs: queue what follows it.
    await engine.clear();
    await engine.push({ item_id: 'B', uri: '/work/b.wav', title: 'B' });

    // The next hard start, posted while E1 plays, then cancelled, then posted again: E1 plays on.
    const e2At = e1At + E1_SECONDS + 3;
    await schedule({ item_id: 'E2', uri: '/work/e2.wav', at: e2At, title: 'E2' });
    state = await engine.state();
    expect(state.on_air.item_id).toBe('E1');
    expect(state.scheduled).toMatchObject({ item_id: 'E2' });
    expect(await unschedule()).toEqual({ cancelled: true });
    await sleep(500);
    state = await engine.state();
    expect([state.on_air.item_id, state.scheduled]).toEqual(['E1', null]);
    await schedule({ item_id: 'E2', uri: '/work/e2.wav', at: e2At, title: 'E2' });

    await until('B on air', (s) => s.on_air.item_id === 'B', 10_000);
    await until('E2 on air', (s) => s.on_air.item_id === 'E2', 10_000);
    await sleep(6000);
    const started = (await engine.events(0)).flatMap((e) =>
      e.type === 'track.started' ? [[e.data.source, e.data.item_id]] : [],
    );
    docker(['stop', '-t', '10', engineName]);
    expect(started).toEqual([
      ['queue', 'A'],
      ['queue', 'E1'],
      ['queue', 'B'],
      ['queue', 'E2'],
    ]);

    const { rate, samples } = readWavChannel(join(work, 'output.wav'));
    const runs = toneRuns(analyse(samples, rate), TONES);
    expect(runs.map((r) => r.label)).toEqual(['A', 'E1', 'B', 'E2']);
    const e1 = runs[1] as { from: number; to: number };
    const e2 = runs[3] as { from: number; to: number };
    // E1 plays whole: the schedule posted during it didn't cut it.
    expect(e1.to - e1.from).toBeGreaterThan(E1_SECONDS - 0.4);
    // E2 starts its own time after E1's start (the recording has no wall clock: compare starts).
    expect(Math.abs(e2.from - e1.from - (e2At - e1At))).toBeLessThan(0.15);
  }, 120_000);
});
