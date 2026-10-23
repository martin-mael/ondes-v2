import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngineAdapter, type EngineAdapter } from '../engine/adapter/index.ts';
import { renderStationScript } from '../engine/config/index.ts';

// Pre-listen on the real engine (#71): the station template runs in the pinned Liquidsoap image
// with two live inputs; another Liquidsoap container plays a DJ streaming to input 1. The
// input's `prelisten/1` stream on the control port answers MP3 behind the control token, input
// 2 (nobody there) answers nothing: the harbor output only registers its mount while its input
// has a DJ. Own network and containers, control port on a random
// 127.0.0.1 port: never the shared dev stack.

const repo = resolve(import.meta.dirname, '../../../../..');
const TOKEN = `prelisten-test-${randomBytes(8).toString('hex')}`;
const PASSWORD = `shared-${randomBytes(8).toString('hex')}`;
const run = randomBytes(4).toString('hex');
const network = `ondes-prelisten-${run}`;
const engineName = `ondes-prelisten-engine-${run}`;
const work = join(tmpdir(), `ondes-prelisten-${run}`);
const stationId = `prelisten-${run}`;

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
let baseUrl: string;

/** Reads `bytes` of a stream, then hangs up. */
async function readSome(res: Response, bytes: number): Promise<Buffer> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (size < bytes) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.length;
  }
  await reader.cancel();
  return Buffer.concat(chunks);
}

/** MP3 frame headers (11 sync bits) in the buffer. */
function mp3Frames(buf: Buffer): number {
  let frames = 0;
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0xff && ((buf[i + 1] as number) & 0xe0) === 0xe0) frames++;
  }
  return frames;
}

beforeAll(async () => {
  mkdirSync(join(work, 'safety'), { recursive: true });
  const rendered = renderStationScript({
    stationId,
    name: 'Pre-listen test',
    paths: { safetyDir: '/work/safety', emergencyFile: '/work/missing.wav' },
    icecast: { host: '127.0.0.1', port: 9 },
    outputs: [{ mount: 'test.mp3', format: 'mp3', bitrate: 128 }],
    live: { enabled: true, mount: 'live', inputs: 2, buffer: 1, maxBuffer: 5 },
  });
  writeFileSync(join(work, 'station.liq'), rendered.script);
  writeFileSync(
    join(work, 'dj.liq'),
    [
      'settings.log.stdout := true',
      'settings.log.level := 2',
      `output.icecast(%mp3(bitrate=192), host=${JSON.stringify(engineName)}, port=8005,`,
      `  password=${JSON.stringify(PASSWORD)}, mount="live", sine(amplitude=0.5, 220.0))`,
    ].join('\n'),
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
  baseUrl = `http://127.0.0.1:${port}`;
  engine = createEngineAdapter({ stationId, baseUrl, token: TOKEN });
  for (let i = 0; i < 120; i++) {
    if (
      await engine.health().then(
        () => true,
        () => false,
      )
    )
      break;
    await sleep(500);
  }
  await engine.health();

  docker([
    'run',
    '-d',
    '--name',
    `ondes-prelisten-dj-${run}`,
    '--network',
    network,
    ...user,
    '-v',
    `${work}:/work`,
    liquidsoapImage(),
    '/work/dj.liq',
  ]);
  for (let i = 0; i < 60; i++) {
    if ((await engine.state()).live.inputs?.[0]?.ready) return;
    await sleep(500);
  }
  throw new Error(`DJ never got ready:\n${docker(['logs', engineName], false)}`);
}, 120_000);

afterAll(() => {
  for (const id of docker(['ps', '-aq', '--filter', `name=ondes-prelisten-.*-${run}`], false)
    .split('\n')
    .filter(Boolean))
    docker(['rm', '-f', id], false);
  docker(['network', 'rm', network], false);
  rmSync(work, { recursive: true, force: true });
});

describe('pre-listen on the real engine', () => {
  it('streams the connected input as MP3, behind the control token', async () => {
    // The harbor output registers its mount once the input is ready, a moment after `ready`.
    let res: Response | null = null;
    for (let i = 0; i < 40 && !res; i++) {
      res = await engine.listen(1);
      if (!res) await sleep(250);
    }
    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toContain('audio/mpeg');
    const audio = await readSome(res as Response, 16_384);
    expect(audio.length).toBeGreaterThanOrEqual(16_384);
    expect(mp3Frames(audio)).toBeGreaterThan(10);

    // The control API still answers next to the harbor output.
    expect((await engine.health()).status).toBe('ok');

    // Without the token: refused.
    const anonymous = await fetch(`${baseUrl}/prelisten/1`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(anonymous.status).toBe(401);
    await anonymous.body?.cancel();
  }, 60_000);

  it('answers nothing for an input nobody streams on', async () => {
    expect(await engine.listen(2)).toBeNull();
  }, 30_000);
});
