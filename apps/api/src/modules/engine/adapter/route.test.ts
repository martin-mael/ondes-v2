import type { EngineRealtimeEvent } from '@ondes/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEngineEventsHandler,
  ENGINE_EVENTS_ROUTE,
  engineEventsUrl,
  registerEngineEventRoutes,
} from './route.ts';
import { createStationEngine, StationEngines } from './station.ts';
import { type FakeEngine, startFakeEngine } from './testing/fake-engine.ts';

let engine: FakeEngine;
let engines: StationEngines;
let published: EngineRealtimeEvent[];
let failPublish: boolean;

beforeEach(async () => {
  engine = await startFakeEngine();
  published = [];
  failPublish = false;
  engines = new StationEngines();
  engines.add(
    createStationEngine({
      stationId: engine.stationId,
      baseUrl: engine.url,
      async publish(event) {
        if (failPublish) throw new Error('rabbit down');
        published.push(event);
      },
    }),
  );
});

afterEach(async () => {
  engines.stopAll();
  await engine.close();
});

describe('engine events route', () => {
  const TOKEN = 't0ken';
  const auth = { authorization: `Bearer ${TOKEN}` };
  const handler = (token = TOKEN) =>
    createEngineEventsHandler({ ingestFor: engines.ingestFor, token });

  it('ingests a valid batch', async () => {
    const res = await handler()({
      stationId: engine.stationId,
      headers: auth,
      body: engine.log,
    });
    expect(res).toEqual({ status: 200, body: { published: 1, duplicates: 0 } });
    expect(published.map((e) => e.type)).toEqual(['engine.booted']);
  });

  it('answers 400 on a batch that breaks the contract', async () => {
    const res = await handler()({
      stationId: engine.stationId,
      headers: auth,
      body: [{ ...engine.log[0], type: 'nope' }],
    });
    expect(res.status).toBe(400);
  });

  it('answers 404 for an unknown station and 409 for a mismatched one', async () => {
    expect((await handler()({ stationId: 'nope', headers: auth, body: [] })).status).toBe(404);
    const other = new StationEngines();
    other.add(
      createStationEngine({ stationId: 'other', baseUrl: engine.url, publish: async () => {} }),
    );
    const res = await createEngineEventsHandler({ ingestFor: other.ingestFor, token: TOKEN })({
      stationId: 'other',
      headers: auth,
      body: engine.log,
    });
    expect(res.status).toBe(409);
  });

  it('answers 503 when it cannot publish, so the engine retries', async () => {
    failPublish = true;
    const res = await handler()({ stationId: engine.stationId, headers: auth, body: engine.log });
    expect(res.status).toBe(503);
  });

  it('always requires the bearer token', async () => {
    const h = handler();
    expect((await h({ stationId: engine.stationId, headers: {}, body: [] })).status).toBe(401);
    const wrong = { authorization: 'Bearer nope!' };
    expect((await h({ stationId: engine.stationId, headers: wrong, body: [] })).status).toBe(401);
    expect((await h({ stationId: engine.stationId, headers: auth, body: [] })).status).toBe(200);
    expect(() => createEngineEventsHandler({ ingestFor: engines.ingestFor, token: '' })).toThrow();
  });

  it('registers on a Fastify-shaped router', async () => {
    const routes = new Map<
      string,
      Parameters<Parameters<typeof registerEngineEventRoutes>[0]['post']>[1]
    >();
    registerEngineEventRoutes(
      { post: (path, handler) => routes.set(path, handler) },
      { ingestFor: engines.ingestFor, token: TOKEN },
    );
    const route = routes.get(ENGINE_EVENTS_ROUTE);
    let code = 0;
    const body = await route?.(
      { params: { stationId: engine.stationId }, headers: auth, body: engine.log },
      { code: (c: number) => (code = c) },
    );
    expect(code).toBe(200);
    expect(body).toEqual({ published: 1, duplicates: 0 });
  });

  it('builds the URL to give the engine', () => {
    expect(engineEventsUrl('http://api:3000/', 'st 1')).toBe(
      'http://api:3000/internal/engine/stations/st%201/events',
    );
  });
});
