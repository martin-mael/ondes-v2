import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createAsset,
  createOrganization,
  createStation,
  logDay,
  logItem,
  markCacheFileReady,
  putAssetFile,
  type StationScope,
  unsafeScope,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import {
  type Actor,
  type EngineRealtimeEvent,
  type FeederItemPassedOverEvent,
  playoutRelPath,
} from '@ondes/shared';
import { contentKey } from '@ondes/storage';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngineEventsHandler } from '../adapter/route.ts';
import { createStationEngine, type StationEngine } from '../adapter/station.ts';
import { renderStationScript } from '../config/index.ts';
import { createStationFeeder, type StationFeeder } from './feeder.ts';
import { createFeederPushStore, loadFeedWindow } from './repo.ts';

/**
 * The feeder against a real Liquidsoap running the station template (testing/compose.yml,
 * its own compose project and free ports per run) and a real database: the log, the library and the cache
 * table are the real ones, the files are sine tones in the engine's playout cache. Engine
 * events go straight from the adapter's ingest to the feeder (no RabbitMQ needed).
 * Needs Docker and Postgres (`pnpm dev:up`).
 */

const run = promisify(execFile);
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const composeFile = here('./testing/compose.yml');
// Per run: compose project, host ports and files, so two worktrees (or two runs) never collide.
const runId = randomUUID().slice(0, 8);
const renderedDir = here(`./testing/.rendered/${runId}/`);
const cacheDir = here(`./testing/.cache/${runId}/`);
const project = `ondes-engine-feeder-it-${runId}`;
let controlPort = 0;
let eventsPort = 0;
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
const skips: FeederItemPassedOverEvent[] = [];
const fetches: string[] = [];
let items: { id: string; assetId: string; sha256: string }[] = [];
let uncached: { id: string; fileId: string };
let spare: { assetId: string; sha256: string };

/** A host port free right now (Docker binds it a moment later). */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** 16-bit stereo PCM WAV of a sine tone. */
function tone(hz: number, seconds: number): Buffer {
  const frames = Math.round(seconds * SR);
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

/** An asset whose playout file is a tone, written to the cache dir (and marked ready). */
async function toneAsset(hz: number, cached: boolean) {
  const bytes = tone(hz, 6);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ctx = { actor: system, scope };
  const asset = await createAsset(tdb.db, ctx, { type: 'song', title: `Tone ${hz}` });
  // The playout copy is FLAC in production (and the table insists); WAV keeps the test free of
  // an encoder, and the engine decodes either. The extension comes from the storage key.
  const { file } = await putAssetFile(tdb.db, ctx, asset.id, {
    role: 'playout',
    storageKey: contentKey({ orgId: scope.orgId, sha256, ext: 'wav' }),
    sha256,
    sizeBytes: bytes.length,
    codec: 'flac',
    sampleRate: SR,
    flacBlockSize: 1024,
    durationSamples: 6 * SR,
  });
  if (cached) {
    const rel = playoutRelPath({ sha256, ext: 'wav' });
    mkdirSync(`${cacheDir}${rel.slice(0, rel.lastIndexOf('/'))}`, { recursive: true });
    writeFileSync(`${cacheDir}${rel}`, bytes);
    await markCacheFileReady(tdb.db, scope, {
      sha256,
      ext: 'wav',
      sizeBytes: bytes.length,
      lastNeededAt: null,
    });
  }
  return { assetId: asset.id, fileId: file.id, sha256 };
}

async function waitFor<T>(what: string, find: () => T | undefined | false, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) {
      const seen = received
        .filter((e) => e.type === 'engine.track.started')
        .map((e) => (e.type === 'engine.track.started' ? `${e.data.source}:${e.data.itemId}` : ''));
      throw new Error(`Timed out waiting for ${what}. Started: ${seen.join(', ')}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const started = (itemId: string, after = 0) =>
  received
    .slice(after)
    .find((e) => e.type === 'engine.track.started' && e.data.itemId === itemId) as
    | Extract<EngineRealtimeEvent, { type: 'engine.track.started' }>
    | undefined;

beforeAll(async () => {
  controlPort = await freePort();
  tdb = await createTestDatabase();
  const org = await createOrganization(tdb.db, system, { slug: 'feeder', name: 'Feeder' });
  const st = await createStation(
    tdb.db,
    { actor: system, scope: unsafeScope(org.id) },
    { slug: 'feeder', name: 'Feeder FM', timezone: 'Europe/Paris' },
  );
  scope = unsafeScope(org.id, st.id);

  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  const assets: Awaited<ReturnType<typeof toneAsset>>[] = [];
  for (let i = 0; i < 40; i++) assets.push(await toneAsset(300 + i * 20, i !== 1));
  spare = await toneAsset(1500, true);

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
  eventsPort = (server.address() as AddressInfo).port;

  const rendered = renderStationScript({
    stationId: scope.stationId,
    name: 'Ondes feeder test',
    eventsUrl: `http://host.docker.internal:${eventsPort}/internal/engine/stations/${scope.stationId}/events`,
    paths: { safetyDir: '/cache/safety', emergencyFile: '/cache/emergency.wav' },
    crossfade: { duration: 0.5 },
    outputs: [{ mount: 'feeder-it.mp3', format: 'mp3', bitrate: 128 }],
  });
  mkdirSync(renderedDir, { recursive: true });
  writeFileSync(`${renderedDir}station.liq`, rendered.script);

  await compose('up', '-d');
  station.start();
  await waitFor('engine up', () => station.health.status() === 'up', 120_000);

  // Seeded once the engine is up, so a slow start (an image pull) can't make the log late.
  // A published day with 40 back-to-back items from now, the second one not in the cache.
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
      assets.map((a, position) => ({
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
  items = rows.map((r, i) => ({
    id: r.id,
    assetId: assets[i]?.assetId as string,
    sha256: assets[i]?.sha256 as string,
  }));
  uncached = { id: items[1]?.id as string, fileId: assets[1]?.fileId as string };
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

/** A feeder for the test's station, recording what it pushed in `feeder_push`. */
function newFeeder(): StationFeeder {
  return createStationFeeder({
    scope,
    engine: async () => station.adapter,
    load: (range) => loadFeedWindow(tdb.db, scope, range),
    store: createFeederPushStore(tdb.db, scope),
    cache: {
      requestUrgentFetch: async (_s, fileId) => {
        fetches.push(fileId);
      },
      requestSync: async () => {},
    },
    alerts: { raise: async () => {}, resolve: async () => {} },
    publish: async (e) => {
      skips.push(e);
    },
    options: { minItems: 2, minAheadMs: 8_000, lookaheadMs: 60_000 },
  });
}

describe('feeder against Liquidsoap', () => {
  it('plays the log in order from the cache, skipping the uncached item', async () => {
    feeder = newFeeder();
    ticker = setInterval(() => void feeder.sync().catch(() => {}), 1_000);
    await feeder.sync();

    const [a, b, c, d] = items;
    const aStarted = await waitFor('first item on air', () => started(a?.id as string));
    expect(aStarted.data).toMatchObject({ source: 'queue', title: 'Tone 300' });
    expect(aStarted.data.filename).toContain(a?.sha256);
    await waitFor('third item on air', () => started(c?.id as string));
    await waitFor('fourth item on air', () => started(d?.id as string));
    expect(started(b?.id as string)).toBeUndefined();
    expect(fetches).toContain(uncached.fileId);
    await waitFor('skip reported', () => skips.find((s) => s.data.itemId === uncached.id));
    // The uncached item was replaced by the next one, back to back from the queue.
    const order = received
      .filter((e) => e.type === 'engine.track.started' && e.data.source === 'queue')
      .map((e) => (e.type === 'engine.track.started' ? e.data.itemId : null));
    expect(order.slice(0, 3)).toEqual([a?.id, c?.id, d?.id]);
  }, 60_000);

  it('editing the item after next changes what airs; the item on air plays out', async () => {
    const state = await station.adapter.state();
    const onAirId = state.on_air.item_id as string;
    const index = items.findIndex((i) => i.id === onAirId);
    const afterNext = items[index + 2] as (typeof items)[number];
    const mark = received.length;

    await tdb.db
      .update(logItem)
      .set({ assetId: spare.assetId })
      .where(eq(logItem.id, afterNext.id));
    await feeder.sync();
    const queued = (await station.adapter.state()).queue.map((r) => [r.item_id, r.uri]);
    expect(queued[1]?.[0]).toBe(afterNext.id);
    expect(queued[1]?.[1]).toContain(spare.sha256);

    const replaced = await waitFor('edited item on air', () => started(afterNext.id, mark), 30_000);
    expect(replaced.data.filename).toContain(spare.sha256);
    // The item that was on air during the edit aired its whole cue window (minus overlaps).
    const ended = received
      .slice(mark)
      .find((e) => e.type === 'engine.track.ended' && e.data.itemId === onAirId);
    expect(ended?.type === 'engine.track.ended' && ended.data.played).toBeGreaterThan(3);
  }, 45_000);

  it('a feeder taking over the station resumes the queue without re-pushing it', async () => {
    // Replica A stops; replica B starts from nothing but the database and the engine.
    clearInterval(ticker);
    feeder.stop();
    await feeder.sync().catch(() => {});
    const before = (await station.adapter.state()).queue.map((r) => r.item_id);
    expect(before.length).toBeGreaterThanOrEqual(1);
    feeder = newFeeder();
    const result = await feeder.sync();
    // Same queue, nothing removed; it only tops up if an item went on air meanwhile.
    expect(result.removed).toEqual([]);
    expect(result.pushed.filter((id) => before.includes(id))).toEqual([]);
    ticker = setInterval(() => void feeder.sync().catch(() => {}), 1_000);
  }, 30_000);

  it('re-feeds the engine after it restarts with an empty queue', async () => {
    const oldBoot = (await station.adapter.state()).boot_id;
    const mark = received.length;
    await compose('restart', 'engine');
    const booted = await waitFor(
      'new boot',
      () =>
        received.slice(mark).find((e) => e.type === 'engine.booted' && e.data.bootId !== oldBoot),
      60_000,
    );
    const bootId = booted.type === 'engine.booted' ? booted.data.bootId : '';
    const back = await waitFor(
      'log back on air',
      () =>
        received
          .slice(mark)
          .find(
            (e) =>
              e.type === 'engine.track.started' &&
              e.data.bootId === bootId &&
              e.data.source === 'queue' &&
              items.some((i) => i.id === e.data.itemId),
          ),
      30_000,
    );
    expect(back).toBeDefined();
    // And the queue is kept ahead again (topped up within a tick of each track change).
    const deadline = Date.now() + 10_000;
    let queued = 0;
    while (queued < 1 && Date.now() < deadline) {
      queued = (await station.adapter.state()).queue.length;
      if (queued < 1) await new Promise((r) => setTimeout(r, 200));
    }
    expect(queued).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
