import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  asRunEntry,
  createAsset,
  createOrganization,
  createStation,
  logDay,
  logItem,
  markCacheFileReady,
  markIslandRendered,
  putAssetFile,
  type StationScope,
  unsafeScope,
  whereStation,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import {
  type Actor,
  type EnginePushItem,
  type EnginePushSegment,
  type EngineRealtimeEvent,
  islandStorageKey,
  playoutRelPath,
} from '@ondes/shared';
import { contentKey } from '@ondes/storage';
import { asc } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAsRunRecorder } from '../../asrun/recorder.ts';
import { createSegue } from '../../segues/repo.ts';
import { silentLogger } from '../adapter/logger.ts';
import { createEngineEventsHandler } from '../adapter/route.ts';
import { createStationEngine, type StationEngine } from '../adapter/station.ts';
import { renderStationScript } from '../config/index.ts';
import { createStationFeeder, type StationFeeder } from './feeder.ts';
import { createFeederPushStore, loadFeedIslands, loadFeedWindow } from './repo.ts';

/**
 * Islands on air (#57): the feeder against a real Liquidsoap running the station template and a
 * real database with two voice-tracked transitions, A → B with its island rendered and cached,
 * C → D with none (its render pending). The first airs as one segment `A body, island, B body`,
 * the second as the fallback, a plain crossfade with the voice laid over it. The as-run
 * recorder then reads the engine's events. Whether the island splice has a seam is the template
 * test's (`pnpm test:engine:template`, which plays the body `buildPushChain` makes); here the
 * files are tones and the island a stand-in of the right length.
 * Needs Docker and Postgres (`pnpm dev:up`); the compose file is the feeder test's.
 */

const run = promisify(execFile);
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const composeFile = here('./testing/compose.yml');
const runId = randomUUID().slice(0, 8);
const renderedDir = here(`./testing/.rendered/islands-${runId}/`);
const cacheDir = here(`./testing/.cache/islands-${runId}/`);
const project = `ondes-engine-islands-it-${runId}`;
let controlPort = 0;
const system: Actor = { type: 'system', name: 'test' };
const SR = 44_100;
/** Each tone is 6 s; each item plays 5 s of it and overlaps the next by 0.5 s. */
const PLAY_MS = 5_000;
const OVERLAP_MS = 500;
const SLOT_MS = PLAY_MS - OVERLAP_MS + 20;

const compose = (...args: string[]) =>
  run('docker', ['compose', '-p', project, '-f', composeFile, ...args], {
    env: {
      ...process.env,
      FEEDER_IT_CONTROL_PORT: String(controlPort),
      FEEDER_IT_RENDERED: renderedDir,
      FEEDER_IT_CACHE: cacheDir,
    },
  });

let tdb: TestDatabase;
let scope: StationScope;
let server: Server;
let station: StationEngine;
let feeder: StationFeeder;
let ticker: NodeJS.Timeout;
const received: EngineRealtimeEvent[] = [];
const pushes: (EnginePushItem | EnginePushSegment)[] = [];
let ids: { x: string; a: string; b: string; c: string; d: string; e: string };
let voice: { assetId: string };
let islandHashAB: string;

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** 16-bit stereo PCM WAV of a sine tone, `frames` long. */
function tone(hz: number, frames: number): Buffer {
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * hz * i) / SR) * 0.3 * 32767);
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Writes `bytes` where the playout cache keeps `<sha256>.<ext>`, and records it ready. */
async function placeInCache(bytes: Buffer, ext: string) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const rel = playoutRelPath({ sha256, ext });
  mkdirSync(`${cacheDir}${rel.slice(0, rel.lastIndexOf('/'))}`, { recursive: true });
  writeFileSync(`${cacheDir}${rel}`, bytes);
  await markCacheFileReady(tdb.db, scope, {
    sha256,
    ext,
    sizeBytes: bytes.length,
    lastNeededAt: null,
  });
  return sha256;
}

async function toneAsset(hz: number, seconds: number, type: 'song' | 'vt' = 'song') {
  const bytes = tone(hz, seconds * SR);
  const ctx = { actor: system, scope };
  const asset = await createAsset(tdb.db, ctx, { type, title: `Tone ${hz}` });
  const sha256 = await placeInCache(bytes, 'wav');
  await putAssetFile(tdb.db, ctx, asset.id, {
    role: 'playout',
    storageKey: contentKey({ orgId: scope.orgId, sha256, ext: 'wav' }),
    sha256,
    sizeBytes: bytes.length,
    codec: 'flac',
    sampleRate: SR,
    flacBlockSize: 1024,
    durationSamples: seconds * SR,
  });
  return { assetId: asset.id, sha256 };
}

async function waitFor<T>(what: string, find: () => T | undefined | false, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const starts = () =>
  received.flatMap((e) =>
    e.type === 'engine.track.started' && e.data.source === 'queue'
      ? [{ itemId: e.data.itemId, segmentId: e.data.segmentId ?? null }]
      : [],
  );

/** A segue whose 2 s voice starts 1 s before A's end, A ducked to −12 dB under it. */
const lanes = (voiceAssetId: string) => ({
  out: {
    envelope: [
      { at: -1.5 * SR, gainDb: 0 },
      { at: -1.25 * SR, gainDb: -12 },
    ],
  },
  in: { start: -0.5 * SR, envelope: [] },
  voices: [{ assetId: voiceAssetId, start: -1 * SR, gainDb: 0, envelope: [] }],
});

beforeAll(async () => {
  controlPort = await freePort();
  tdb = await createTestDatabase();
  const org = await createOrganization(tdb.db, system, { slug: 'islands', name: 'Islands' });
  const st = await createStation(
    tdb.db,
    { actor: system, scope: unsafeScope(org.id) },
    { slug: 'islands', name: 'Islands FM', timezone: 'Europe/Paris' },
  );
  scope = unsafeScope(org.id, st.id);
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });

  const songs = [];
  for (let i = 0; i < 12; i++) songs.push(await toneAsset(300 + i * 40, 6));
  voice = await toneAsset(1000, 2, 'vt');

  station = createStationEngine({
    stationId: scope.stationId,
    baseUrl: `http://127.0.0.1:${controlPort}`,
    token: 'it-token',
    publish: async (event) => {
      received.push(event);
      feeder?.onEvent(event);
    },
    health: { intervalMs: 250, downAfter: 2 },
  });
  const handle = createEngineEventsHandler({ ingestFor: () => station.ingest, token: 'it-token' });
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const match = req.url?.match(/^\/internal\/engine\/stations\/([^/]+)\/events$/);
    if (req.method !== 'POST' || !match?.[1]) return res.writeHead(404).end();
    const out = await handle({
      stationId: decodeURIComponent(match[1]),
      headers: req.headers,
      body: JSON.parse(raw || 'null'),
    });
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const eventsPort = (server.address() as AddressInfo).port;

  const rendered = renderStationScript({
    stationId: scope.stationId,
    name: 'Ondes islands test',
    eventsUrl: `http://host.docker.internal:${eventsPort}/internal/engine/stations/${scope.stationId}/events`,
    paths: { safetyDir: '/cache/safety', emergencyFile: '/cache/emergency.wav' },
    crossfade: { duration: 0.5 },
    outputs: [{ mount: 'islands-it.mp3', format: 'mp3', bitrate: 128 }],
  });
  mkdirSync(renderedDir, { recursive: true });
  writeFileSync(`${renderedDir}station.liq`, rendered.script);
  await compose('up', '-d');
  station.start();
  await waitFor('engine up', () => station.health.status() === 'up', 120_000);

  // The log: X, A, B, C, D, E, … back to back from now.
  const start = Date.now() + 1_000;
  const [day] = await tdb.db
    .insert(logDay)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      localDate: '2026-10-21',
      startsAt: new Date(start - 3_600_000),
      endsAt: new Date(start + 3_600_000),
      status: 'published',
    })
    .returning();
  if (!day) throw new Error('no day');
  const rows = await tdb.db
    .insert(logItem)
    .values(
      songs.map((a, position) => ({
        orgId: scope.orgId,
        stationId: scope.stationId,
        logDayId: day.id,
        position,
        kind: 'song' as const,
        plannedStart: new Date(start + position * SLOT_MS),
        plannedDurationMs: SLOT_MS,
        assetId: a.assetId,
        cueOverrides: { sampleRate: SR, cueOut: (PLAY_MS * SR) / 1000, crossOutMs: OVERLAP_MS },
        originType: 'manual' as const,
      })),
    )
    .returning({ id: logItem.id });
  const [x, a, b, c, d, e] = rows.map((r) => r.id) as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  ids = { x, a, b, c, d, e };

  // A → B: rendered and cached. C → D: left pending (the fallback).
  const ctx = { actor: system, scope };
  const ab = await createSegue(tdb.db, ctx, {
    fromItemId: a,
    toItemId: b,
    ...lanes(voice.assetId),
  });
  await createSegue(tdb.db, ctx, { fromItemId: c, toItemId: d, ...lanes(voice.assetId) });
  const island = ab.sync.islands[0];
  if (!island) throw new Error(`no island for A → B: ${JSON.stringify(ab.sync.segues)}`);
  islandHashAB = island.hash;
  // A stand-in render of the right length (the template test checks a real one's splice).
  const sha256 = await placeInCache(tone(700, island.lengthSamples), 'flac');
  await markIslandRendered(tdb.db, scope, {
    hash: island.hash,
    storageKey: islandStorageKey(scope.orgId, island.hash),
    file: { sha256, sizeBytes: island.lengthSamples * 4 + 44 },
  });
}, 300_000);

afterAll(async () => {
  clearInterval(ticker);
  feeder?.stop();
  station?.stop();
  await compose('down', '-v', '--remove-orphans').catch(() => {});
  await new Promise((resolve) => server?.close(resolve));
  rmSync(renderedDir, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
  await tdb?.drop();
}, 60_000);

describe('islands against Liquidsoap', () => {
  it('airs a ready island as one segment, and a pending one as the fallback', async () => {
    const adapter = station.adapter;
    feeder = createStationFeeder({
      scope,
      engine: async () => ({
        state: () => adapter.state(),
        remove: (id) => adapter.remove(id),
        clear: () => adapter.clear(),
        push: (item) => {
          pushes.push(item);
          return adapter.push(item);
        },
        pushSegment: (segment) => {
          pushes.push(segment);
          return adapter.pushSegment(segment);
        },
      }),
      load: (range) => loadFeedWindow(tdb.db, scope, range),
      islands: (itemIds) => loadFeedIslands(tdb.db, scope, itemIds),
      store: createFeederPushStore(tdb.db, scope),
      cache: { requestUrgentFetch: async () => {}, requestSync: async () => {} },
      alerts: { raise: async () => {}, resolve: async () => {} },
      options: { minItems: 2, minAheadMs: 8_000, lookaheadMs: 60_000 },
    });
    ticker = setInterval(() => void feeder.sync().catch(() => {}), 1_000);
    await feeder.sync();
    await waitFor('E on air', () => starts().some((s) => s.itemId === ids.e), 90_000);

    const island = `island:${islandHashAB}`;
    const order = starts().map((s) => s.itemId);
    expect(order.slice(order.indexOf(ids.x), order.indexOf(ids.e) + 1)).toEqual([
      ids.x,
      ids.a,
      island,
      ids.b,
      ids.c,
      ids.d,
      ids.e,
    ]);
    // A, the island and B are one queue entry; C and D are not.
    const segmentOf = (id: string) => starts().find((s) => s.itemId === id)?.segmentId;
    expect([ids.a, island, ids.b].map(segmentOf)).toEqual([ids.a, ids.a, ids.a]);
    expect([ids.c, ids.d].map(segmentOf)).toEqual([null, null]);
    // B never went out on its own; C carried the voice over its crossfade into D.
    expect(pushes.some((p) => !('parts' in p) && p.item_id === ids.b)).toBe(false);
    const c = pushes.find((p) => !('parts' in p) && p.item_id === ids.c) as EnginePushItem;
    expect(c.overlay).toEqual([
      expect.objectContaining({ at: expect.closeTo(4, 2), duration: 2, duck_db: -12 }),
    ]);

    // The as-run reads the same events: the island carries its transition and its voice.
    const recorder = createAsRunRecorder({ db: tdb.db, logger: silentLogger });
    for (const event of received) await recorder.handle(event);
    const entries = await tdb.db
      .select()
      .from(asRunEntry)
      .where(whereStation(asRunEntry, scope))
      .orderBy(asc(asRunEntry.seq));
    const islandEntry = entries.find((r) => r.engineItemId === island);
    expect(islandEntry).toMatchObject({
      logItemId: null,
      outcome: 'complete',
      transition: {
        rendered: true,
        hash: islandHashAB,
        voices: [{ assetId: voice.assetId, durationMs: 2000 }],
      },
    });
    // A body is planned to its island, so it airs `complete`, not `cut`.
    const aEntry = entries.find((r) => r.logItemId === ids.a);
    expect(aEntry?.plannedDurationMs).toBeLessThan(PLAY_MS);
    expect(aEntry?.outcome).toBe('complete');
    expect(entries.find((r) => r.logItemId === ids.c)?.transition).toMatchObject({
      rendered: false,
      voices: [{ assetId: voice.assetId, offsetMs: expect.any(Number) }],
    });
  }, 150_000);
});
