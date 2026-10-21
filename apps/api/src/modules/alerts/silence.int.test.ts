import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createOrganization, createStation, type StationScope, unsafeScope } from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import {
  type Actor,
  type AlertRealtimeEvent,
  alertTypes,
  type EngineRealtimeEvent,
  realtimeEventSchema,
} from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { createMemoryMailer } from '../../plugins/mail.ts';
import type { Rabbit } from '../../plugins/rabbit.ts';
import { TEST_AUTH_CONFIG } from '../auth/testing.ts';
import {
  createEngineEventsHandler,
  createStationEngine,
  type StationEngine,
} from '../engine/adapter/index.ts';
import { renderStationScript } from '../engine/config/index.ts';
import * as repo from './repo.ts';
import { createTestRabbit, waitFor } from './testing.ts';

/**
 * Acceptance for #33, against a real Liquidsoap running the station template (its own compose
 * project and ports, testing/compose.yml): a silent file in the queue makes the engine's
 * blank.detect fire `blank.detected` within the configured time; the api raises the silence
 * alert and runs the station's action (skip), the next item airs, `blank.recovered` resolves
 * the alert. Needs Docker, Postgres and RabbitMQ (`pnpm dev:up`, or CI's service containers).
 */

const run = promisify(execFile);
const composeFile = fileURLToPath(new URL('./testing/compose.yml', import.meta.url));
const renderedDir = fileURLToPath(new URL('./testing/.rendered/', import.meta.url));
const project = 'ondes-alerts-it';
const controlPort = Number(process.env.ALERTS_IT_CONTROL_PORT ?? 17280);
const eventsPort = Number(process.env.ALERTS_IT_EVENTS_PORT ?? 17281);
const MAX_SECONDS = 3;
const system: Actor = { type: 'system', name: 'test' };

const compose = (...args: string[]) =>
  run('docker', ['compose', '-p', project, '-f', composeFile, ...args], {
    env: { ...process.env, ALERTS_IT_CONTROL_PORT: String(controlPort) },
  });

let tdb: TestDatabase;
let rabbit: Rabbit;
let app: FastifyInstance;
let server: Server;
let station: StationEngine;
let scope: StationScope;
/** Everything on the fanout, with when the test saw it. */
const received: Array<{ event: EngineRealtimeEvent | AlertRealtimeEvent }> = [];

const find = <T extends (EngineRealtimeEvent | AlertRealtimeEvent)['type']>(
  type: T,
  where: (e: Extract<EngineRealtimeEvent | AlertRealtimeEvent, { type: T }>) => boolean = () =>
    true,
) =>
  received.find(
    (
      r,
    ): r is {
      event: Extract<EngineRealtimeEvent | AlertRealtimeEvent, { type: T }>;
    } => r.event.type === type && where(r.event as never),
  );

beforeAll(async () => {
  tdb = await createTestDatabase();
  rabbit = await createTestRabbit();
  const org = await createOrganization(tdb.db, system, { slug: 'silence', name: 'Silence' });
  const st = await createStation(
    tdb.db,
    { actor: system, scope: unsafeScope(org.id) },
    { slug: 'silence-fm', name: 'Silence FM', timezone: 'Europe/Paris' },
  );
  scope = unsafeScope(org.id, st.id);
  await repo.updateSilenceSettings(tdb.db, scope, { maxSeconds: MAX_SECONDS, action: 'skip' });
  const settings = await repo.getSilenceSettings(tdb.db, scope);

  station = createStationEngine({
    stationId: st.id,
    baseUrl: `http://127.0.0.1:${controlPort}`,
    token: 'it-token',
    publish: (event) => rabbit.events.publish(event),
    health: { intervalMs: 250, downAfter: 2 },
  });
  app = await buildApp({
    db: { client: tdb },
    rabbit: { rabbit },
    mail: { mailer: createMemoryMailer() },
    auth: TEST_AUTH_CONFIG,
    alerts: { engineFor: () => station.adapter, sweepIntervalMs: 0 },
    fastify: { logger: false },
  });
  await app.ready();
  const sub = rabbit.subscribeEvents((raw) => {
    const parsed = realtimeEventSchema.safeParse(raw);
    // Only engine and alert events matter here (the union also has log and other events).
    if (parsed.success && /^(engine|alert)\./.test(parsed.data.type)) {
      received.push({ event: parsed.data as EngineRealtimeEvent | AlertRealtimeEvent });
    }
  });
  await sub.ready;

  // The engine posts its events here through host.docker.internal, hence 0.0.0.0.
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
  await new Promise<void>((resolve) => server.listen(eventsPort, '0.0.0.0', resolve));

  // Rendered with the station's silence settings, as the engine lifecycle (#35) will.
  const rendered = renderStationScript({
    stationId: st.id,
    name: 'Silence FM',
    eventsUrl: `http://host.docker.internal:${eventsPort}/internal/engine/stations/${st.id}/events`,
    paths: { safetyDir: '/media/safety', emergencyFile: '/media/emergency.wav' },
    crossfade: { duration: 0.5 },
    blank: { maxSeconds: settings.maxSeconds, thresholdDb: settings.thresholdDb },
    outputs: [{ mount: 'silence.mp3', format: 'mp3', bitrate: 128 }],
  });
  mkdirSync(renderedDir, { recursive: true });
  writeFileSync(`${renderedDir}station.liq`, rendered.script);

  await compose('down', '-v', '--remove-orphans');
  await compose('up', '-d');
  station.start();
  await waitFor('engine up', () => station.health.status() === 'up', 120_000);
  // Safety plays on an empty queue: there's sound before the silent file.
  await waitFor(
    'safety on air',
    () => find('engine.track.started', (e) => e.data.source === 'safety'),
    30_000,
  );
}, 300_000);

afterAll(async () => {
  station?.stop();
  await compose('down', '-v', '--remove-orphans').catch(() => {});
  await new Promise((resolve) => server?.close(resolve));
  await app?.close();
  await rabbit?.close();
  await tdb?.drop();
}, 60_000);

describe('silence detection against Liquidsoap', () => {
  it('a silent file in the queue triggers the alert and the skip within the configured time', async () => {
    // 12 s of digital silence, then a tone.
    await station.adapter.push({ item_id: 'SILENT', uri: '/media/silence.wav' });
    await station.adapter.push({ item_id: 'NEXT', uri: '/media/tone-a.wav' });

    const silent = await waitFor(
      'silent item on air',
      () => find('engine.track.started', (e) => e.data.itemId === 'SILENT'),
      20_000,
    );
    const detected = await waitFor('blank.detected', () => find('engine.blank.detected'), 20_000);
    const raised = await waitFor('silence alert', () =>
      find('alert.raised', (e) => e.data.type === alertTypes.silence),
    );
    // Within the configured time, on the engine's clock (event times, not arrival times, so a
    // loaded machine doesn't skew it): blank.detected max_blank after the silent item started
    // (give or take the crossfade), then the alert as soon as the api handles the event.
    const at = (e: { at: string }) => Date.parse(e.at) / 1000;
    const detectAfter = at(detected.event) - at(silent.event);
    expect(detectAfter).toBeGreaterThanOrEqual(MAX_SECONDS - 1);
    expect(detectAfter).toBeLessThan(MAX_SECONDS + 1.5);
    expect(at(raised.event) - at(detected.event)).toBeLessThan(5);
    expect(raised.event.data.severity).toBe('warning');

    // The action skipped the silent item long before its 12 s end: the next one airs.
    const next = await waitFor(
      'next item on air',
      () => find('engine.track.started', (e) => e.data.itemId === 'NEXT'),
      15_000,
    );
    expect(at(next.event) - at(silent.event)).toBeLessThan(10);

    await waitFor('blank.recovered', () => find('engine.blank.recovered'), 10_000);
    const resolved = await waitFor('alert resolved', () =>
      find('alert.resolved', (e) => e.data.type === alertTypes.silence),
    );
    expect(resolved.event.data.resolution).toBe('recovered');

    const [alert] = (
      await repo.listAlerts(tdb.db, scope, { status: 'all', type: alertTypes.silence })
    ).items;
    expect(alert).toMatchObject({
      status: 'resolved',
      action: { name: 'engine.skip', state: 'done', attempts: 1 },
    });
  }, 60_000);
});
