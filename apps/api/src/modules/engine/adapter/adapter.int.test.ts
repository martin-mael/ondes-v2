import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  connectQueue,
  createEventPublisher,
  deleteTopology,
  type EventPublisher,
  type EventSubscription,
  type QueueConnection,
  subscribeEvents,
} from '@ondes/queue';
import {
  type EngineRealtimeEvent,
  type EngineState,
  engineRealtimeEventSchema,
} from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderStationScript } from '../config/index.ts';
import { EngineNotQueuedError, EngineUnresolvableError } from './errors.ts';
import type { ResyncReason } from './ingest.ts';
import { createEngineEventsHandler } from './route.ts';
import { createStationEngine, type StationEngine } from './station.ts';

/**
 * Adapter against a real Liquidsoap running the station template (testing/compose.yml, its
 * own compose project and ports), with events going through the real RabbitMQ fanout.
 * Needs Docker and RabbitMQ (`pnpm dev:up`, or CI's service container).
 */

const run = promisify(execFile);
const composeFile = fileURLToPath(new URL('./testing/compose.yml', import.meta.url));
/** The rendered station script goes here (gitignored); compose mounts it into the engine. */
const renderedDir = fileURLToPath(new URL('./testing/.rendered/', import.meta.url));
const project = 'ondes-engine-adapter-it';
const controlPort = Number(process.env.ENGINE_IT_CONTROL_PORT ?? 17180);
const eventsPort = Number(process.env.ENGINE_IT_EVENTS_PORT ?? 17181);
const rabbitUrl = process.env.RABBITMQ_URL ?? 'amqp://ondes:ondes@127.0.0.1:5672/ondes';
const STATION = 'it-station';

const compose = (...args: string[]) =>
  run('docker', ['compose', '-p', project, '-f', composeFile, ...args], {
    env: {
      ...process.env,
      ENGINE_IT_CONTROL_PORT: String(controlPort),
      ENGINE_IT_EVENTS_PORT: String(eventsPort),
    },
  });

let queue: QueueConnection;
let publisher: EventPublisher<EngineRealtimeEvent>;
let subscription: EventSubscription;
let server: Server;
let station: StationEngine;
/** What came back through RabbitMQ, i.e. what SSE clients would see. */
const received: EngineRealtimeEvent[] = [];
const resyncs: Array<{ reason: ResyncReason; state: EngineState }> = [];
let configVersion = '';

async function waitFor<T>(what: string, find: () => T | undefined, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${what}. Received: ${received.map((e) => e.type).join(', ')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const started = (itemId: string, after = 0) =>
  received.slice(after).find((e) => e.type === 'engine.track.started' && e.data.itemId === itemId);

beforeAll(async () => {
  queue = await connectQueue(rabbitUrl, { prefix: `test-${randomUUID().slice(0, 8)}` });
  publisher = createEventPublisher(queue.rabbit, queue.topology, engineRealtimeEventSchema);
  subscription = subscribeEvents(queue.rabbit, queue.topology, engineRealtimeEventSchema, (e) => {
    received.push(e);
  });
  await subscription.ready;

  station = createStationEngine({
    stationId: STATION,
    baseUrl: `http://127.0.0.1:${controlPort}`,
    token: 'it-token',
    publish: (event) => publisher.publish(event),
    onResync: (state, reason) => {
      resyncs.push({ state, reason });
    },
    health: { intervalMs: 250, downAfter: 2 },
  });

  // The engine reaches this through host.docker.internal, hence 0.0.0.0.
  // The template sends the control token on event posts (#27): require it.
  const handle = createEngineEventsHandler({
    ingestFor: () => station.ingest,
    token: 'it-token',
  });
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
  await new Promise<void>((resolve) => server.listen(eventsPort, '0.0.0.0', resolve));

  // The station template (#27), rendered for this test's station like the api will.
  const rendered = renderStationScript({
    stationId: STATION,
    name: 'Ondes integration test',
    eventsUrl: `http://host.docker.internal:${eventsPort}/internal/engine/stations/${STATION}/events`,
    paths: { safetyDir: '/media/safety', emergencyFile: '/media/emergency.wav' },
    crossfade: { duration: 0.5 },
    blank: { maxSeconds: 4 },
    outputs: [{ mount: 'it.mp3', format: 'mp3', bitrate: 128 }],
  });
  configVersion = rendered.version;
  mkdirSync(renderedDir, { recursive: true });
  writeFileSync(`${renderedDir}station.liq`, rendered.script);

  await compose('down', '-v', '--remove-orphans');
  await compose('up', '-d');
  station.start();
  await waitFor('engine up', () => station.health.status() === 'up' || undefined, 120_000);
}, 300_000);

afterAll(async () => {
  station?.stop();
  await compose('down', '-v', '--remove-orphans').catch(() => {});
  await new Promise((resolve) => server?.close(resolve));
  await subscription?.close();
  await publisher?.close();
  if (queue) {
    await deleteTopology(queue.rabbit, queue.topology);
    await queue.close();
  }
}, 60_000);

describe('engine adapter against Liquidsoap', () => {
  it('publishes engine.up and the boot event', async () => {
    const up = await waitFor('engine.up', () => received.find((e) => e.type === 'engine.up'));
    const booted = await waitFor('engine.booted', () =>
      received.find((e) => e.type === 'engine.booted'),
    );
    expect(booted.data).toMatchObject({ seq: 1, bootId: up.data.bootId, version: '2.4.6' });
    expect((await station.adapter.health()).config_version).toBe(configVersion);
    // Empty queue at boot: the safety playlist plays.
    await waitFor('safety on air', () =>
      received.find((e) => e.type === 'engine.track.started' && e.data.source === 'safety'),
    );
  });

  it('pushes, removes, skips and reports as-run', async () => {
    const mark = received.length;
    await expect(
      station.adapter.push({ item_id: 'missing', uri: '/media/missing.wav' }),
    ).rejects.toBeInstanceOf(EngineUnresolvableError);

    const a = await station.adapter.push({
      item_id: 'A',
      uri: '/media/tone-a.wav',
      cue_in: 1,
      cue_out: 4,
      title: 'Say "hi", Lyon',
      artist: 'Ondes',
    });
    expect(a).toMatchObject({ item_id: 'A', uri: expect.stringMatching(/:\/media\/tone-a\.wav$/) });
    await station.adapter.push({ item_id: 'B', uri: '/media/tone-b.wav', cue_out: 8 });
    await station.adapter.push({ item_id: 'C', uri: '/media/tone-c.wav' });

    const state = await station.adapter.state();
    expect(state.queue.map((r) => r.item_id)).toContain('C');
    expect(await station.adapter.remove('C')).toEqual({ removed: 1 });
    await expect(station.adapter.remove('C')).rejects.toBeInstanceOf(EngineNotQueuedError);

    // The refilled queue takes over from safety right away.
    const aStarted = await waitFor('A on air', () => started('A', mark));
    expect(aStarted.data).toMatchObject({ source: 'queue', title: 'Say "hi", Lyon' });
    await waitFor('B on air', () => started('B', mark));
    const aEnded = received
      .slice(mark)
      .find((e) => e.type === 'engine.track.ended' && e.data.itemId === 'A');
    // A airs its 3 s cue window minus the crossfades around it (and the takeover from safety),
    // about 2.5 s; a loaded CI runner measures less. What matters: it played, it wasn't skipped.
    expect(aEnded?.type === 'engine.track.ended' && aEnded.data.played).toBeGreaterThan(1);

    await station.adapter.skip();
    const bEnded = await waitFor('B ended', () =>
      received.slice(mark).find((e) => e.type === 'engine.track.ended' && e.data.itemId === 'B'),
    );
    expect(bEnded.type === 'engine.track.ended' && bEnded.data.played).toBeLessThan(8);
    expect(started('C', mark)).toBeUndefined();

    // Events arrived in order, once each.
    const seqs = received.slice(mark).flatMap((e) => ('seq' in e.data ? [e.data.seq] : []));
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
  }, 60_000);

  it('opens the live gate', async () => {
    await station.adapter.setLive(true);
    await waitFor('live.gate', () =>
      received.find((e) => e.type === 'engine.live.gate' && e.data.enabled),
    );
    await station.adapter.setLive(false);
    expect((await station.adapter.state()).live.enabled).toBe(false);
  });

  it('pushes an island segment as one queue entry', async () => {
    const mark = received.length;
    const result = await station.adapter.pushSegment({
      segment_id: 'island-1',
      parts: [
        { item_id: 'S1', uri: '/media/tone-d.wav', cue_out: 2 },
        { item_id: 'S2', uri: '/media/tone-e.wav', cue_out: 2, amplify_db: 0 },
      ],
      cross_in: 0.5,
    });
    expect(result.segment_id).toBe('island-1');
    expect(result.requests.map((r) => [r.item_id, r.segment_id])).toEqual([
      ['S1', 'island-1'],
      ['S2', 'island-1'],
    ]);
    const s1 = await waitFor('S1 on air', () => started('S1', mark));
    const s2 = await waitFor('S2 on air', () => started('S2', mark));
    for (const e of [s1, s2]) {
      expect(e.type === 'engine.track.started' && e.data.segmentId).toBe('island-1');
    }
  }, 30_000);

  it('resyncs after the engine restarts', async () => {
    const oldBoot = station.ingest.cursor()?.bootId;
    const mark = received.length;
    await compose('restart', 'engine');
    const booted = await waitFor(
      'new boot',
      () =>
        received.slice(mark).find((e) => e.type === 'engine.booted' && e.data.bootId !== oldBoot),
      60_000,
    );
    expect(booted.type === 'engine.booted' && booted.data.seq).toBe(1);
    await waitFor('engine.up for the new boot', () =>
      received
        .slice(mark)
        .find((e) => e.type === 'engine.up' && e.data.bootId === booted.data.bootId),
    );
    await waitFor('cursor on the new boot', () =>
      station.ingest.cursor()?.bootId === booted.data.bootId ? true : undefined,
    );
    const resync = await waitFor('resync on the new boot', () =>
      resyncs.find((r) => r.state.boot_id === booted.data.bootId),
    );
    // A restarted engine has an empty queue: the feeder re-pushes from here.
    expect(resync.state.queue).toEqual([]);
  }, 90_000);
});
