import { randomUUID } from 'node:crypto';
import { get, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  asRunEntry,
  createOrganization,
  createStation,
  type OrgScope,
  type StationScope,
  station,
  unsafeScope,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import {
  type Actor,
  type PublicNowPlaying,
  publicHistorySchema,
  publicNowPlayingSchema,
} from '@ondes/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppOptions, buildApp } from '../../app.ts';
import { createMemoryMailer } from '../../plugins/mail.ts';
import { TEST_AUTH_CONFIG } from '../auth/testing.ts';
import { publicOperations } from './openapi.ts';

// Public API (#74) on a real database: anonymous reads by slug, the public cut (no internal
// ids), the shared snapshot (cached until an event, ETag/304), CORS, rate limits, the SSE
// stream pushing changes to every listener, and the OpenAPI document. Needs `pnpm dev:up`
// (Postgres). Events are fed in with `app.publicApi.onEvent`, as the RabbitMQ fanout would.

const system: Actor = { type: 'system', name: 'test' };

let tdb: TestDatabase;
let orgScope: OrgScope;
const apps: FastifyInstance[] = [];

async function newApp(publicApi: AppOptions['publicApi'] = {}) {
  const app = await buildApp({
    db: { client: tdb },
    mail: { mailer: createMemoryMailer() },
    auth: TEST_AUTH_CONFIG,
    alerts: { sweepIntervalMs: 0 },
    cache: { alertIntervalMs: 0 },
    publicApi,
    fastify: { logger: false },
  });
  await app.ready();
  apps.push(app);
  return app;
}

let app: FastifyInstance;

beforeAll(async () => {
  tdb = await createTestDatabase();
  const org = await createOrganization(tdb.db, system, { slug: 'public-api', name: 'Public' });
  orgScope = unsafeScope(org.id);
  app = await newApp();
}, 60_000);

afterAll(async () => {
  for (const a of apps) await a.close();
  await tdb?.drop();
}, 60_000);

let stations = 0;
async function newStation() {
  stations++;
  const slug = `public-fm-${stations}`;
  const st = await createStation(
    tdb.db,
    { actor: system, scope: orgScope },
    { slug, name: `FM ${stations}`, timezone: 'Europe/Paris' },
  );
  return { slug, scope: unsafeScope(orgScope.orgId, st.id) as StationScope };
}

let seq = 0;
async function airing(scope: StationScope, values: Partial<typeof asRunEntry.$inferInsert>) {
  seq++;
  const [row] = await tdb.db
    .insert(asRunEntry)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      eventId: randomUUID(),
      bootId: 'boot',
      seq,
      source: 'log',
      kind: 'song',
      startedAt: new Date(),
      ...values,
    })
    .returning({ id: asRunEntry.id });
  if (!row) throw new Error('no entry');
  return row.id;
}

const nowPlaying = (slug: string, headers: Record<string, string> = {}, on = app) =>
  on.inject({ method: 'GET', url: `/api/v1/public/stations/${slug}/now-playing`, headers });

describe('GET /api/v1/public/stations/:slug/now-playing', () => {
  it('answers anonymously by slug with public fields only, CORS open, cacheable', async () => {
    const { slug, scope } = await newStation();
    const startedAt = new Date(Date.now() - 30_000);
    const entryId = await airing(scope, {
      title: 'Song',
      artist: 'Artist',
      startedAt,
      plannedDurationMs: 200_000,
    });

    const res = await nowPlaying(slug);
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toMatch(/^public, max-age=\d+/);
    expect(res.headers.etag).toMatch(/^"[\w-]+"$/);
    const body: PublicNowPlaying = publicNowPlayingSchema.parse(res.json());
    expect(body).toMatchObject({
      station: { slug, name: expect.any(String), timezone: 'Europe/Paris' },
      mode: 'automation',
      live: false,
      current: { kind: 'track', title: 'Song', artist: 'Artist', durationMs: 200_000 },
      show: null,
      liveInfo: null,
    });
    expect(Date.parse(body.current?.startedAt ?? '')).toBe(startedAt.getTime());
    // Nothing internal: not the station's id, not the as-run entry's, not the org's.
    for (const id of [scope.stationId, scope.orgId, entryId]) expect(res.body).not.toContain(id);
    expect(Object.keys(body).sort()).toEqual(
      ['at', 'current', 'live', 'liveInfo', 'mode', 'next', 'show', 'station'].sort(),
    );

    const again = await nowPlaying(slug, { 'if-none-match': res.headers.etag as string });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
  }, 30_000);

  it('serves the shared snapshot until an event for the station invalidates it', async () => {
    const { slug, scope } = await newStation();
    const first = await airing(scope, { title: 'First', startedAt: new Date(Date.now() - 60_000) });
    expect((await nowPlaying(slug)).json().current.title).toBe('First');

    await tdb.db
      .update(asRunEntry)
      .set({ endedAt: new Date(), durationMs: 60_000, outcome: 'complete' })
      .where(eq(asRunEntry.id, first));
    await airing(scope, { title: 'Second' });
    // No event yet: still the snapshot.
    expect((await nowPlaying(slug)).json().current.title).toBe('First');
    // Another station's event changes nothing here.
    app.publicApi.onEvent({ type: 'asrun.started', stationId: randomUUID() });
    expect((await nowPlaying(slug)).json().current.title).toBe('First');

    app.publicApi.onEvent({ type: 'asrun.started', stationId: scope.stationId });
    expect((await nowPlaying(slug)).json().current.title).toBe('Second');
  }, 30_000);

  it('rebuilds on asset.updated only for cue changes of the asset on air', async () => {
    const { slug, scope } = await newStation();
    const assetId = randomUUID();
    const entry = await airing(scope, { title: 'Cued', assetId });
    expect((await nowPlaying(slug)).json().current.title).toBe('Cued');
    // Changed behind the snapshot's back: a rebuild would show it.
    await tdb.db.update(asRunEntry).set({ title: 'Rebuilt' }).where(eq(asRunEntry.id, entry));

    const updated = (id: string, changes: string[]) =>
      app.publicApi.onEvent({
        type: 'asset.updated',
        stationId: scope.stationId,
        data: { assetId: id, changes },
      });
    updated(randomUUID(), ['cues']);
    updated(assetId, ['loudness', 'settings']);
    expect((await nowPlaying(slug)).json().current.title).toBe('Cued');
    updated(assetId, ['cues']);
    expect((await nowPlaying(slug)).json().current.title).toBe('Rebuilt');
  }, 30_000);

  it('is off air with nothing on air, and 404 for an unknown slug, 400 for a malformed one', async () => {
    const { slug } = await newStation();
    expect((await nowPlaying(slug)).json()).toMatchObject({
      mode: 'off_air',
      current: null,
      show: null,
      next: [],
    });
    const missing = await nowPlaying('no-such-station');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'not_found' });
    expect(missing.headers['access-control-allow-origin']).toBe('*');
    expect((await nowPlaying('Not_A_Slug')).statusCode).toBe(400);
  }, 30_000);

  it('answers CORS preflights', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/public/stations/any/now-playing',
      headers: {
        origin: 'https://vandaleradio.org',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'if-none-match',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-headers']).toMatch(/If-None-Match/);
    expect(res.headers['access-control-allow-methods']).toMatch(/GET/);
  });

  it('rate limits per client IP', async () => {
    const limited = await newApp({ rateLimit: { max: 2, timeWindowMs: 60_000 } });
    const { slug } = await newStation();
    const from = (ip: string) =>
      limited.inject({
        method: 'GET',
        url: `/api/v1/public/stations/${slug}/now-playing`,
        remoteAddress: ip,
      });
    expect((await from('10.0.0.1')).statusCode).toBe(200);
    expect((await from('10.0.0.1')).statusCode).toBe(200);
    const third = await from('10.0.0.1');
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: 'rate_limited' });
    expect(third.headers['retry-after']).toBeDefined();
    expect((await from('10.0.0.2')).statusCode).toBe(200);
  }, 30_000);
});

describe('GET /api/v1/public/stations/:slug/history', () => {
  it('lists what aired, newest first, without interludes, skips or the item on air', async () => {
    const { slug, scope } = await newStation();
    const t0 = Date.now() - 3_600_000;
    const ended = (i: number, more: Partial<typeof asRunEntry.$inferInsert>) =>
      airing(scope, {
        startedAt: new Date(t0 + i * 60_000),
        endedAt: new Date(t0 + i * 60_000 + 50_000),
        durationMs: 50_000,
        outcome: 'complete',
        ...more,
      });
    await ended(0, { title: 'Oldest', artist: 'A' });
    await ended(1, { kind: 'jingle', title: 'ID' });
    await ended(2, { title: 'Skipped', outcome: 'skipped', durationMs: 2_000 });
    await ended(3, { kind: 'episode', title: 'Episode' });
    await ended(4, { title: 'Newest', artist: 'B' });
    await airing(scope, { title: 'On air' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/stations/${slug}/history?limit=2`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBeDefined();
    const body = publicHistorySchema.parse(res.json());
    expect(body.items.map((i) => i.title)).toEqual(['Newest', 'Episode']);
    const all = publicHistorySchema.parse(
      (await app.inject({ method: 'GET', url: `/api/v1/public/stations/${slug}/history` })).json(),
    );
    expect(all.items.map((i) => [i.kind, i.title])).toEqual([
      ['track', 'Newest'],
      ['episode', 'Episode'],
      ['track', 'Oldest'],
    ]);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/public/stations/${slug}/history?limit=51` }))
        .statusCode,
    ).toBe(400);
  }, 30_000);
});

/** Reads SSE `now_playing` frames off a response. */
function frames(res: IncomingMessage) {
  let buffer = '';
  const queue: PublicNowPlaying[] = [];
  const waiters: Array<(f: PublicNowPlaying) => void> = [];
  res.setEncoding('utf8');
  res.on('data', (chunk: string) => {
    buffer += chunk;
    let end = buffer.indexOf('\n\n');
    while (end >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (block.includes('event: now_playing')) {
        const data = block
          .split('\n')
          .find((l) => l.startsWith('data: '))
          ?.slice(6);
        const parsed = publicNowPlayingSchema.parse(JSON.parse(data ?? 'null'));
        const waiter = waiters.shift();
        if (waiter) waiter(parsed);
        else queue.push(parsed);
      }
      end = buffer.indexOf('\n\n');
    }
  });
  return {
    next: () =>
      new Promise<PublicNowPlaying>((resolve, reject) => {
        const queued = queue.shift();
        if (queued) return resolve(queued);
        const timer = setTimeout(() => reject(new Error('no frame within 5 s')), 5_000);
        waiters.push((f) => {
          clearTimeout(timer);
          resolve(f);
        });
      }),
  };
}

describe('GET /api/v1/public/stations/:slug/events', () => {
  it('sends the snapshot on connect, then each change to every listener', async () => {
    const live = await newApp({ stream: { debounceMs: 20, heartbeatMs: 1_000 } });
    await live.listen({ port: 0, host: '127.0.0.1' });
    const { port } = live.server.address() as AddressInfo;
    const { slug, scope } = await newStation();
    await airing(scope, { title: 'Before' });

    const open = () =>
      new Promise<IncomingMessage>((resolve, reject) => {
        get(`http://127.0.0.1:${port}/api/v1/public/stations/${slug}/events`, resolve).on(
          'error',
          reject,
        );
      });
    const [a, b] = await Promise.all([open(), open()]);
    expect(a.statusCode).toBe(200);
    expect(a.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(a.headers['access-control-allow-origin']).toBe('*');
    const fa = frames(a);
    const fb = frames(b);
    expect((await fa.next()).current?.title).toBe('Before');
    expect((await fb.next()).current?.title).toBe('Before');
    expect(live.publicApi.listeners).toBe(2);

    await airing(scope, { title: 'After' });
    live.publicApi.onEvent({ type: 'asrun.started', stationId: scope.stationId });
    expect((await fa.next()).current?.title).toBe('After');
    expect((await fb.next()).current?.title).toBe('After');

    a.destroy();
    b.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(live.publicApi.listeners).toBe(0);
  }, 30_000);

  it('keeps streaming through a station.updated, with the station re-read', async () => {
    const live = await newApp({ stream: { debounceMs: 20, heartbeatMs: 1_000 } });
    await live.listen({ port: 0, host: '127.0.0.1' });
    const { port } = live.server.address() as AddressInfo;
    const { slug, scope } = await newStation();
    await airing(scope, { title: 'Song' });
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      get(`http://127.0.0.1:${port}/api/v1/public/stations/${slug}/events`, resolve).on(
        'error',
        reject,
      );
    });
    const f = frames(res);
    expect((await f.next()).station.slug).toBe(slug);

    const renamed = `${slug}-renamed`;
    await tdb.db
      .update(station)
      .set({ slug: renamed, name: 'Renamed FM' })
      .where(eq(station.id, scope.stationId));
    // A burst, as a settings form saving several fields would send.
    for (let i = 0; i < 3; i++) {
      live.publicApi.onEvent({ type: 'station.updated', stationId: scope.stationId });
    }
    await live.publicApi.settled();
    expect((await f.next()).station).toMatchObject({ slug: renamed, name: 'Renamed FM' });

    // The stream still follows the station after the refresh.
    await airing(scope, { title: 'Next song' });
    live.publicApi.onEvent({ type: 'asrun.started', stationId: scope.stationId });
    expect((await f.next()).current?.title).toBe('Next song');

    expect((await nowPlaying(slug, {}, live)).statusCode).toBe(404);
    expect((await nowPlaying(renamed, {}, live)).json().station.name).toBe('Renamed FM');
    res.destroy();
  }, 30_000);

  it('caps open streams per client IP and refuses unknown slugs before streaming', async () => {
    const capped = await newApp({ stream: { maxClientsPerIp: 1 } });
    await capped.listen({ port: 0, host: '127.0.0.1' });
    const { port } = capped.server.address() as AddressInfo;
    const { slug } = await newStation();
    const open = (path: string) =>
      new Promise<IncomingMessage>((resolve, reject) => {
        get(`http://127.0.0.1:${port}${path}`, resolve).on('error', reject);
      });
    const first = await open(`/api/v1/public/stations/${slug}/events`);
    expect(first.statusCode).toBe(200);
    const second = await open(`/api/v1/public/stations/${slug}/events`);
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBe('30');
    second.resume();
    const unknown = await open('/api/v1/public/stations/nope/events');
    expect(unknown.statusCode).toBe(404);
    unknown.resume();
    first.destroy();
  }, 30_000);

  it('answers 503 with Retry-After when the process has no room for another stream', async () => {
    const full = await newApp({ stream: { maxClients: 1 } });
    await full.listen({ port: 0, host: '127.0.0.1' });
    const { port } = full.server.address() as AddressInfo;
    const { slug } = await newStation();
    const open = () =>
      new Promise<IncomingMessage>((resolve, reject) => {
        get(`http://127.0.0.1:${port}/api/v1/public/stations/${slug}/events`, resolve).on(
          'error',
          reject,
        );
      });
    const first = await open();
    expect(first.statusCode).toBe(200);
    // The process cap comes before the per-IP one (10 by default).
    const second = await open();
    expect(second.statusCode).toBe(503);
    expect(second.headers['retry-after']).toBe('30');
    second.resume();
    first.destroy();
  }, 30_000);
});

describe('GET /api/v1/public/openapi.json', () => {
  it('documents every public route, and every documented route exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    const doc = res.json() as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    for (const op of publicOperations) {
      expect(doc.paths).toHaveProperty(`/api/v1/public${op.path.replace(/:(\w+)/g, '{$1}')}`);
      expect(app.hasRoute({ method: 'GET', url: `/api/v1/public${op.path}` })).toBe(true);
    }
  });
});
