import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { EngineEvent } from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngineAdapter, type EngineAdapter } from '../engine/adapter/index.ts';
import { renderStationScript } from '../engine/config/index.ts';
import { writeTone } from './testing/tones.ts';

// Live metadata on the real engine (#68, ADR 0040), read back from Icecast. The station
// template runs in the pinned Liquidsoap image with an MP3 and a Vorbis output to its own
// Icecast; a stand-in DJ streams MP3 to the harbor and sends its track info the way DJ
// software does for MP3 (harbor's /admin/metadata, with its own login). The test checks what
// listeners see on both mounts: Node's now-playing, the encoder's when Node lets it through,
// and a manual one over the encoder. Own network and containers, ports on 127.0.0.1: never
// the shared dev stack.

const repo = resolve(import.meta.dirname, '../../../../..');
const TOKEN = `live-meta-test-${randomBytes(8).toString('hex')}`;
const PASSWORD = `shared-${randomBytes(8).toString('hex')}`;
const SOURCE_PASSWORD = `icecast-${randomBytes(8).toString('hex')}`;
const run = randomBytes(4).toString('hex');
const network = `ondes-live-meta-${run}`;
const engineName = `ondes-live-meta-engine-${run}`;
const icecastName = `ondes-live-meta-icecast-${run}`;
const work = join(tmpdir(), `ondes-live-meta-${run}`);

function compose(): string {
  return readFileSync(join(repo, 'deploy/compose.dev.yml'), 'utf8');
}

function imageOf(pattern: RegExp, env: string | undefined): string {
  if (env) return env;
  const m = compose().match(pattern);
  if (!m?.[1]) throw new Error(`no image matching ${pattern} in deploy/compose.dev.yml`);
  return m[1];
}

const liquidsoapImage = () =>
  imageOf(/image:\s*(savonet\/liquidsoap:\S+)/, process.env.LIQUIDSOAP_IMAGE);
const icecastImage = () => imageOf(/image:\s*(\S*icecast\S*)/, process.env.ICECAST_IMAGE);

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
const hostPort = (container: string, port: number) =>
  docker(['port', container, `${port}/tcp`])
    .split('\n')[0]
    ?.split(':')
    .pop();

let engine: EngineAdapter;
let icecastUrl: string;
let harborUrl: string;

type MountStatus = { listenurl: string; title?: string; artist?: string };

/** What Icecast says each mount is playing (`status-json.xsl`). */
async function mounts(): Promise<Record<string, { title: string; artist: string }>> {
  const res = await fetch(`${icecastUrl}/status-json.xsl`);
  const body = (await res.json()) as { icestats: { source?: MountStatus | MountStatus[] } };
  const sources = body.icestats.source;
  const list = Array.isArray(sources) ? sources : sources ? [sources] : [];
  return Object.fromEntries(
    list.map((s) => [
      new URL(s.listenurl).pathname.slice(1),
      { title: String(s.title ?? ''), artist: String(s.artist ?? '') },
    ]),
  );
}

/** Waits until Icecast shows `want` on the MP3 mount and the Vorbis mount. */
async function onStreams(
  what: string,
  want: { mp3: string; ogg: { title: string; artist: string } },
  ms = 20_000,
) {
  let last: Awaited<ReturnType<typeof mounts>> | undefined;
  for (let waited = 0; waited < ms; waited += 250) {
    last = await mounts().catch(() => undefined);
    if (
      last?.['test.mp3']?.title === want.mp3 &&
      last['test.ogg']?.title === want.ogg.title &&
      last['test.ogg']?.artist === want.ogg.artist
    ) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what} on the streams: ${JSON.stringify(last)}`);
}

/** What DJ software sends for an MP3 stream when its track changes. */
async function djSends(song: string) {
  const url = new URL(`${harborUrl}/admin/metadata`);
  url.searchParams.set('mount', '/live');
  url.searchParams.set('mode', 'updinfo');
  url.searchParams.set('song', song);
  const res = await fetch(url, {
    headers: { authorization: `Basic ${btoa(`source:${PASSWORD}`)}` },
  });
  expect(res.status).toBe(200);
}

async function eventsOf<T extends EngineEvent['type']>(type: T) {
  return (await engine.events(0)).filter(
    (e): e is Extract<EngineEvent, { type: T }> => e.type === type,
  );
}

beforeAll(async () => {
  mkdirSync(join(work, 'safety'), { recursive: true });
  writeTone(join(work, 'a.wav'), 440, 120);

  const rendered = renderStationScript({
    stationId: `live-meta-${run}`,
    name: 'Live metadata test',
    paths: { safetyDir: '/work/safety', emergencyFile: '/work/missing.wav' },
    icecast: { host: icecastName, port: 8000 },
    outputs: [
      { mount: 'test.mp3', format: 'mp3', bitrate: 128 },
      { mount: 'test.ogg', format: 'vorbis', bitrate: 96 },
    ],
    live: { enabled: true, mount: 'live', inputs: 1, buffer: 2, maxBuffer: 5 },
  });
  writeFileSync(join(work, 'station.liq'), rendered.script);
  writeFileSync(
    join(work, 'dj.liq'),
    [
      'settings.log.stdout := true',
      'settings.log.level := 2',
      `output.icecast(%mp3(bitrate=128), host=${JSON.stringify(engineName)}, port=8005,`,
      `  password=${JSON.stringify(PASSWORD)}, mount="live", sine(amplitude=0.5, 220.))`,
    ].join('\n'),
  );

  docker(['network', 'create', network]);
  docker([
    'run',
    '-d',
    '--name',
    icecastName,
    '--network',
    network,
    '-e',
    `ICECAST_SOURCE_PASSWORD=${SOURCE_PASSWORD}`,
    '-e',
    `ICECAST_ADMIN_PASSWORD=admin-${run}`,
    '-e',
    `ICECAST_RELAY_PASSWORD=relay-${run}`,
    '-p',
    '127.0.0.1::8000',
    icecastImage(),
  ]);
  icecastUrl = `http://127.0.0.1:${hostPort(icecastName, 8000)}`;
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
    `ICECAST_SOURCE_PASSWORD=${SOURCE_PASSWORD}`,
    '-p',
    '127.0.0.1::7000',
    '-p',
    '127.0.0.1::8005',
    '-v',
    `${work}:/work`,
    liquidsoapImage(),
    '/work/station.liq',
  ]);
  harborUrl = `http://127.0.0.1:${hostPort(engineName, 8005)}`;
  engine = createEngineAdapter({
    stationId: `live-meta-${run}`,
    baseUrl: `http://127.0.0.1:${hostPort(engineName, 7000)}`,
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
  for (const id of docker(['ps', '-aq', '--filter', `name=ondes-live-meta-.*-${run}`], false)
    .split('\n')
    .filter(Boolean))
    docker(['rm', '-f', id], false);
  docker(['network', 'rm', network], false);
  if (!process.env.KEEP_LIVE_META_WORK) rmSync(work, { recursive: true, force: true });
});

describe('live metadata on the real engine, read from Icecast', () => {
  it('shows the default, the encoder when allowed, and a manual now-playing', async () => {
    await engine.push({ item_id: 'A', uri: '/work/a.wav', title: 'Track A', artist: 'Band A' });
    await onStreams('the automation track', {
      mp3: 'Band A - Track A',
      ogg: { title: 'Track A', artist: 'Band A' },
    });

    // The DJ connects; Node puts them on air, then sends the default now-playing.
    docker([
      'run',
      '-d',
      '--name',
      `ondes-live-meta-dj-${run}`,
      '--network',
      network,
      ...user,
      '-v',
      `${work}:/work`,
      liquidsoapImage(),
      '/work/dj.liq',
    ]);
    for (let i = 0; i < 80 && !(await engine.state()).live.ready; i++) await sleep(250);
    const session = randomUUID();
    await engine.setLive(true, { input: 1, sessionId: session });
    expect(
      await engine.setLiveMetadata?.({
        title: 'Night Shift #12',
        artist: 'DJ Nova',
        encoder: false,
      }),
    ).toBe(true);
    await onStreams('the default now-playing', {
      mp3: 'DJ Nova - Night Shift #12',
      ogg: { title: 'Night Shift #12', artist: 'DJ Nova' },
    });
    expect((await engine.state()).live.now_playing).toEqual({
      title: 'Night Shift #12',
      artist: 'DJ Nova',
      encoder: false,
    });

    // The encoder's track info isn't allowed: reported to Node, never on the streams.
    await djSends('Encoder Artist - First Song');
    for (let i = 0; i < 40 && !(await eventsOf('live.metadata')).length; i++) await sleep(250);
    const [reported] = await eventsOf('live.metadata');
    expect(reported?.data).toMatchObject({
      input: 1,
      session_id: session,
      title: 'Encoder Artist - First Song',
    });
    await sleep(2000);
    await onStreams('the default, still', {
      mp3: 'DJ Nova - Night Shift #12',
      ogg: { title: 'Night Shift #12', artist: 'DJ Nova' },
    });

    // Allowed (the DJ's streamer setting): the encoder's next track goes straight through.
    await engine.setLiveMetadata?.({
      title: 'Encoder Artist - First Song',
      artist: null,
      encoder: true,
    });
    await djSends('Encoder Artist - Second Song');
    await onStreams('the encoder now-playing', {
      mp3: 'Encoder Artist - Second Song',
      ogg: { title: 'Encoder Artist - Second Song', artist: '' },
    });

    // A manual now-playing (a concert): wins over the encoder until cleared.
    await engine.setLiveMetadata?.({
      title: 'Live at the Marché',
      artist: 'Kiosque',
      encoder: false,
    });
    await onStreams('the manual now-playing', {
      mp3: 'Kiosque - Live at the Marché',
      ogg: { title: 'Live at the Marché', artist: 'Kiosque' },
    });
    await djSends('Encoder Artist - Third Song');
    await sleep(2000);
    await onStreams('the manual now-playing, still', {
      mp3: 'Kiosque - Live at the Marché',
      ogg: { title: 'Live at the Marché', artist: 'Kiosque' },
    });

    // A new session (a handover) starts blank until Node sends its own: never the last DJ's.
    await engine.setLive(true, { input: 1, sessionId: randomUUID() });
    expect((await engine.state()).live.now_playing).toEqual({
      title: '',
      artist: '',
      encoder: false,
    });

    // Back to automation: the log's metadata again.
    await engine.setLive(false);
    await engine.push({ item_id: 'B', uri: '/work/a.wav', title: 'Track B', artist: 'Band B' });
    await engine.skip();
    await onStreams('the automation again', {
      mp3: 'Band B - Track B',
      ogg: { title: 'Track B', artist: 'Band B' },
    });
  }, 180_000);
});
