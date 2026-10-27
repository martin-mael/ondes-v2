import { execFile, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  createOrganization,
  createStation,
  episode,
  getLiveRecording,
  listAssetFiles,
  listLiveRecordingParts,
  liveSession,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
  show,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import type { Actor, EngineState, RealtimeEvent } from '@ondes/shared';
import { createS3Storage, loadStorageConfig, type Storage } from '@ondes/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEngineAdapter,
  type EngineAdapter,
} from '../../../../api/src/modules/engine/adapter/index.ts';
import { silentLogger } from '../../../../api/src/modules/engine/adapter/logger.ts';
import { toRealtimeEvent } from '../../../../api/src/modules/engine/adapter/map.ts';
import { renderStationScript } from '../../../../api/src/modules/engine/config/index.ts';
import { createLiveRecordingRecorder } from '../../../../api/src/modules/live/recording/recorder.ts';
import {
  analyse,
  readWavChannel,
  silentWindows,
  toneRuns,
} from '../../../../api/src/modules/live/testing/tones.ts';
import { defaultTools } from '../ingest/ffmpeg.ts';
import { generateAssetPeaks } from '../peaks/peaks.ts';
import { buildLiveRecording, type LiveRecordingDeps } from './build.ts';

// Live recording on the real engine (#67, ADR 0039), end to end but for the queue: the station
// template in the pinned Liquidsoap image records its final mix into `<cache>/<station>/
// recordings`, two stand-in Liquidsoap DJs stream a tone each, and the test drives one live
// show the way Node does:
//   DJ 1 (220 Hz) on air, session S1 → handover to DJ 2 (330 Hz), S2 → DJ 2 hangs up
//   (back to automation, 440 Hz) → DJ 2 reconnects in the slot, S3 → return.
// Each takeover's 1 s crossfade (the automation fading out under the DJ) isn't recorded.
// S1–S3 are bound to one episode. The engine's events go through the api's recorder (as the
// durable consumer would), the `live-recording` build joins the three files, uploads and
// ingests them, and attaches the asset to the episode; the peaks job then draws its waveform.
// The joined audio must be DJ 1, DJ 2, DJ 2 with no silence and none of the automation.
// Needs Docker, the dev Postgres and Garage, and the worker image's ffmpeg
// (PATH=$PWD/apps/worker/test/bin:$PATH, like CI). Own network and containers.

const exec = promisify(execFile);
const enabled = Boolean(process.env.S3_ENDPOINT);
if (!enabled) {
  if (process.env.CI) throw new Error('live recording engine test needs S3_ENDPOINT in CI');
  console.warn('live recording engine test skipped: S3_ENDPOINT is not set (.env.example)');
}

const repo = resolve(import.meta.dirname, '../../../../..');
const TOKEN = `live-rec-${randomBytes(8).toString('hex')}`;
const PASSWORD = `shared-${randomBytes(8).toString('hex')}`;
const run = randomBytes(4).toString('hex');
const network = `ondes-live-rec-${run}`;
const engineName = `ondes-live-rec-engine-${run}`;
const work = join(tmpdir(), `ondes-live-rec-${run}`);
const TONES = { auto: 440, dj1: 220, dj2: 330 };
const system: Actor = { type: 'system', name: 'test' };
const tools = defaultTools();

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

/** Mono 16-bit WAV sine, as the automation's item. */
function writeTone(path: string, freq: number, seconds: number) {
  const rate = 44100;
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 16384), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

function startDj(name: string, mount: string, freq: number): string {
  const container = `ondes-live-rec-${name}-${run}`;
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
  docker(['rm', '-f', container], false);
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

describe.skipIf(!enabled)('live recording on the real engine', () => {
  let tdb: TestDatabase;
  let storage: Storage;
  let engine: EngineAdapter;
  let scope: StationScope;
  let recordings: string;

  const endSession = (id: string, reason: string) =>
    tdb.sql`update live_session set ended_at = now(), end_reason = ${reason} where id = ${id}`;

  async function until(what: string, ok: (s: EngineState) => boolean, ms = 20_000) {
    let last: EngineState | undefined;
    for (let waited = 0; waited < ms; waited += 200) {
      last = await engine.state();
      if (ok(last)) return last;
      await sleep(200);
    }
    throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last?.live)}`);
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    storage = createS3Storage(loadStorageConfig());
    const org = await createOrganization(tdb.db, system, { slug: `rec-${run}`, name: 'Org' });
    const st = await createStation(
      tdb.db,
      { actor: system, scope: await resolveOrgScope(tdb.db, org.id) },
      { slug: `rec-fm-${run}`, name: 'FM', timezone: 'Europe/Paris' },
    );
    scope = await resolveStationScope(tdb.db, org.id, st.id);

    // `<cache root>/<station>/recordings`, as the lifecycle mounts it.
    recordings = join(work, 'cache', scope.stationId, 'recordings');
    mkdirSync(recordings, { recursive: true });
    mkdirSync(join(work, 'safety'), { recursive: true });
    writeTone(join(work, 'auto.wav'), TONES.auto, 120);

    const rendered = renderStationScript({
      stationId: scope.stationId,
      name: 'Live recording test',
      paths: { safetyDir: '/work/safety', emergencyFile: '/work/missing.wav' },
      crossfade: { duration: 1 },
      processing: { compressor: { enabled: false }, limiter: { enabled: false } },
      icecast: { host: '127.0.0.1', port: 9 },
      outputs: [{ mount: 'test.mp3', format: 'mp3', bitrate: 128 }],
      live: {
        enabled: true,
        mount: 'live',
        inputs: 2,
        buffer: 2,
        maxBuffer: 5,
        recordDir: '/recordings',
      },
    });
    writeFileSync(join(work, 'station.liq'), rendered.script);

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
      '-v',
      `${recordings}:/recordings`,
      liquidsoapImage(),
      '/work/station.liq',
    ]);
    const port = docker(['port', engineName, '7000/tcp']).split('\n')[0]?.split(':').pop();
    engine = createEngineAdapter({
      stationId: scope.stationId,
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
  }, 180_000);

  afterAll(async () => {
    for (const id of docker(['ps', '-aq', '--filter', `name=ondes-live-rec-.*-${run}`], false)
      .split('\n')
      .filter(Boolean))
      docker(['rm', '-f', id], false);
    docker(['network', 'rm', network], false);
    await tdb?.drop();
    if (!process.env.KEEP_LIVE_REC_WORK) rmSync(work, { recursive: true, force: true });
  });

  it('records a show with a handover and a reconnect into one rerun-ready episode', async () => {
    // The show and its episode, and the three sessions the switcher would open (#65, #66).
    const [s] = await tdb.db
      .insert(show)
      .values({ ...scope, name: 'Matinale', defaultSlotType: 'live' })
      .returning();
    const [ep] = await tdb.db
      .insert(episode)
      .values({ ...scope, showId: s!.id, number: 7, kind: 'live', status: 'aired' })
      .returning();
    const [S1, S2, S3] = [randomUUID(), randomUUID(), randomUUID()];
    const session = (id: string, input: number) => ({
      ...scope,
      id,
      input,
      trigger: 'slot' as const,
      showId: s!.id,
      episodeId: ep!.id,
      episodeNumber: 7,
      title: 'Matinale',
    });

    // What the log queues: each return from live drops the item live interrupted.
    for (const id of ['auto-1', 'auto-2', 'auto-3'])
      await engine.push({ item_id: id, uri: '/work/auto.wav', title: id });
    await until('automation on air', (st) => st.on_air.item_id === 'auto-1');

    startDj('dj1', 'live', TONES.dj1);
    await until('DJ 1 ready', (st) => st.live.inputs?.[0]?.ready === true);
    await tdb.db.insert(liveSession).values(session(S1, 1));
    await engine.setLive(true, { input: 1, sessionId: S1 });
    await until('DJ 1 on air', (st) => st.live.on_air === 1);
    await sleep(4000);

    // Handover inside the slot: same episode, one file per session, no gap between them.
    startDj('dj2', 'live-2', TONES.dj2);
    await until('DJ 2 ready', (st) => st.live.inputs?.[1]?.ready === true);
    await endSession(S1, 'handover');
    await tdb.db.insert(liveSession).values(session(S2, 2));
    await engine.setLive(true, { input: 2, sessionId: S2 });
    await until('DJ 2 on air', (st) => st.live.on_air === 2);
    await sleep(4000);

    // DJ 2 hangs up (their software is closed): automation airs, and isn't recorded.
    docker(['rm', '-f', `ondes-live-rec-dj2-${run}`], false);
    await until('DJ 2 gone', (st) => st.live.inputs?.[1]?.connected === false);
    await engine.setLive(false);
    await endSession(S2, 'disconnected');
    await until('automation back', (st) => st.live.on_air == null && st.on_air.source === 'queue');
    await sleep(3000);

    // DJ 2 reconnects within the slot: a new session on the same episode (ADR 0033).
    startDj('dj2', 'live-2', TONES.dj2);
    await until('DJ 2 ready again', (st) => st.live.inputs?.[1]?.ready === true);
    await tdb.db.insert(liveSession).values(session(S3, 2));
    await engine.setLive(true, { input: 2, sessionId: S3 });
    await until('DJ 2 on air again', (st) => st.live.on_air === 2);
    await sleep(3000);
    await engine.setLive(false);
    await until(
      'back to automation',
      (st) => st.live.on_air == null && st.on_air.source === 'queue',
    );
    await endSession(S3, 'returned');
    await sleep(500);

    // The engine's events through the api's recorder, in order, as the durable consumer runs it.
    const published: RealtimeEvent[] = [];
    const recorder = createLiveRecordingRecorder({
      db: tdb.db,
      publish: async (e) => {
        published.push(e);
      },
      logger: silentLogger,
    });
    const wire = await engine.events(0);
    const recordingEvents = wire.filter((e) => e.type.startsWith('live.recording.'));
    const sessionsOf = (type: string) =>
      recordingEvents.flatMap((e) =>
        e.type === type && 'session_id' in e.data ? [e.data.session_id] : [],
      );
    expect(sessionsOf('live.recording.started')).toEqual([S1, S2, S3]);
    expect(sessionsOf('live.recording.closed')).toEqual([S1, S2, S3]);
    for (const e of wire) await recorder.handle(toRealtimeEvent(e) as RealtimeEvent);
    // A redelivery changes nothing.
    for (const e of wire) await recorder.handle(toRealtimeEvent(e) as RealtimeEvent);

    const last = published.at(-1);
    expect(last?.type).toBe('live.recording.updated');
    if (last?.type !== 'live.recording.updated') throw new Error('no update');
    expect(last.data).toMatchObject({ episodeId: ep!.id, status: 'pending', version: 3 });
    const parts = await listLiveRecordingParts(tdb.db, scope, last.data.recordingId);
    expect(parts.map((p) => [p.sessionId, p.status])).toEqual([
      [S1, 'closed'],
      [S2, 'closed'],
      [S3, 'closed'],
    ]);
    expect(readdirSync(recordings).sort()).toEqual(parts.map((p) => p.file).sort());

    // The worker's build, as the `live.recording.updated` trigger would run it.
    const events: RealtimeEvent[] = [];
    const deps: LiveRecordingDeps = {
      db: tdb.db,
      storage,
      tools,
      publish: async (e) => {
        events.push(e);
      },
      cacheRoot: join(work, 'cache'),
      tmpDir: work,
    };
    const payload = {
      orgId: scope.orgId,
      stationId: scope.stationId,
      recordingId: last.data.recordingId,
      version: 3,
    };
    const t0 = Date.now();
    const result = await buildLiveRecording(deps, payload, { attempt: 1, isLastAttempt: true });
    const buildMs = Date.now() - t0;
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    // The same version again does nothing.
    expect(
      (await buildLiveRecording(deps, payload, { attempt: 1, isLastAttempt: true })).status,
    ).toBe('skipped');

    const [after] = await tdb.sql<
      { asset_id: string }[]
    >`select asset_id from episode where id = ${ep!.id}`;
    expect(after?.asset_id).toBe(result.assetId);
    const row = await getLiveRecording(tdb.db, scope, payload.recordingId);
    expect(row).toMatchObject({ status: 'ready', builtVersion: 3, assetId: result.assetId });
    const ingested = events.find((e) => e.type === 'asset.ingested');
    expect(ingested).toBeDefined();

    // Joined length: the three sessions on air (4 + 4 + 3 s plus the takeovers), nothing else.
    const onAir = parts.reduce(
      (sum, p) => sum + ((p.endedAt?.getTime() ?? 0) - p.startedAt.getTime()),
      0,
    );
    expect(Math.abs(result.durationMs - onAir)).toBeLessThan(1500);

    // What was joined: DJ 1, then DJ 2 (twice, the reconnect), no automation, no silence.
    const files = await listAssetFiles(tdb.db, scope, result.assetId);
    const playout = files.find((f) => f.role === 'playout');
    expect(playout).toBeDefined();
    const flac = join(work, 'joined.flac');
    const body = await storage.get(playout!.storageKey);
    const chunks: Buffer[] = [];
    for await (const c of body.body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    writeFileSync(flac, Buffer.concat(chunks));
    const wav = join(work, 'joined.wav');
    await exec(tools.ffmpeg, [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-i',
      flac,
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      wav,
    ]);
    const { rate, samples } = readWavChannel(wav);
    const windows = analyse(samples, rate);
    const runs = toneRuns(windows, TONES);
    expect(runs.map((r) => r.label)).toEqual(['dj1', 'dj2']);
    // The cut between S2 and S3 is the reconnect: a join, not a gap.
    expect(silentWindows(windows, runs[0]?.from ?? 0, runs.at(-1)?.to ?? 0)).toEqual([]);

    // The waveform, as the peaks job does on `asset.ingested`.
    if (ingested?.type !== 'asset.ingested') throw new Error('no asset.ingested');
    expect(
      await generateAssetPeaks(
        { db: tdb.db, storage, tools },
        {
          orgId: scope.orgId,
          stationId: scope.stationId,
          assetId: result.assetId,
          playoutSha256: ingested.data.playout.sha256,
        },
      ),
    ).toBe('stored');
    expect((await listAssetFiles(tdb.db, scope, result.assetId)).map((f) => f.role).sort()).toEqual(
      ['master', 'peaks', 'playout'],
    );

    console.log(
      JSON.stringify({
        msg: 'live recording build',
        audioMs: result.durationMs,
        buildMs,
        msPerAudioHour: Math.round((buildMs / result.durationMs) * 3_600_000),
      }),
    );
  }, 300_000);
});
