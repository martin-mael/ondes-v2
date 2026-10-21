import { randomBytes, randomUUID } from 'node:crypto';
import {
  addMembership,
  asRunEntry,
  createAsset,
  createOrganization,
  createStation,
  logDay,
  logItem,
  type OrgScope,
  putAssetFile,
  type StationScope,
  unsafeScope,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import { deleteEventQueue } from '@ondes/queue';
import {
  type Actor,
  type AsRunList,
  type AsRunRealtimeEvent,
  asRunRealtimeEventSchema,
  type EngineRealtimeEvent,
} from '@ondes/shared';
import { contentKey } from '@ondes/storage';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { createMemoryMailer } from '../../plugins/mail.ts';
import { createTestRabbit, waitFor } from '../alerts/testing.ts';
import { cookieHeader, signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../auth/testing.ts';
import { engineEventId } from '../engine/adapter/index.ts';
import { ASRUN_EVENT_QUEUE } from './plugin.ts';
import * as repo from './repo.ts';

// As-run end to end: engine track events go through the real RabbitMQ events exchange into
// the durable `asrun` queue, which records entries (idempotent on redelivery) and publishes
// asrun.* events; then the history API, its pagination and tenant isolation.
// Needs `pnpm dev:up` (Postgres, RabbitMQ).

const system: Actor = { type: 'system', name: 'test' };

let tdb: TestDatabase;
let rabbit: Awaited<ReturnType<typeof createTestRabbit>>;
let app: FastifyInstance;
let orgScope: OrgScope;
let member: { userId: string; cookie: string };
let outsider: { userId: string; cookie: string };
const asRunEvents: AsRunRealtimeEvent[] = [];

beforeAll(async () => {
  tdb = await createTestDatabase();
  rabbit = await createTestRabbit();
  const mailer = createMemoryMailer();
  app = await buildApp({
    db: { client: tdb },
    rabbit: { rabbit },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    alerts: { sweepIntervalMs: 0 },
    cache: { alertIntervalMs: 0 },
    fastify: { logger: false },
  });
  await app.ready();
  const sub = rabbit.subscribeEvents((raw) => {
    const parsed = asRunRealtimeEventSchema.safeParse(raw);
    if (parsed.success) asRunEvents.push(parsed.data);
  });
  await sub.ready;

  const org = await createOrganization(tdb.db, system, { slug: 'asrun', name: 'As-run' });
  orgScope = unsafeScope(org.id);
  const t = { app, tdb, outbox: mailer.outbox } as unknown as TestApp;
  member = await signUpAndLogin(t, 'member@asrun.test');
  outsider = await signUpAndLogin(t, 'outsider@asrun.test');
}, 60_000);

afterAll(async () => {
  await app?.close();
  if (rabbit) {
    await deleteEventQueue(rabbit.queue.rabbit, rabbit.queue.topology, ASRUN_EVENT_QUEUE).catch(
      () => {},
    );
    await rabbit.close();
  }
  await tdb?.drop();
}, 60_000);

let stations = 0;
async function newStation(withMember = true) {
  stations++;
  const ctx = { actor: system, scope: orgScope };
  const st = await createStation(tdb.db, ctx, {
    slug: `asrun-${stations}`,
    name: 'FM',
    timezone: 'Europe/Paris',
  });
  if (withMember) {
    await addMembership(tdb.db, ctx, {
      level: 'station',
      userId: member.userId,
      stationId: st.id,
      role: 'viewer',
    });
  }
  const scope = unsafeScope(orgScope.orgId, st.id);
  const bootId = randomUUID();
  let seq = 0;
  return {
    scope,
    bootId,
    /** Publishes an engine event of this station's boot (or another `bootId`). */
    async engine<T extends 'engine.track.started' | 'engine.track.ended' | 'engine.booted'>(
      type: T,
      data: Omit<Extract<EngineRealtimeEvent, { type: T }>['data'], 'bootId' | 'seq'>,
      options: { at: Date; bootId?: string },
    ) {
      const boot = options.bootId ?? bootId;
      seq++;
      const event = {
        id: engineEventId(st.id, boot, seq),
        stationId: st.id,
        at: options.at.toISOString(),
        type,
        data: { ...data, bootId: boot, seq },
      } as unknown as EngineRealtimeEvent;
      await rabbit.events.publish(event);
      return event;
    },
    api: (query: string, cookie = member.cookie) =>
      app.inject({
        method: 'GET',
        url: `/api/v1/stations/${st.id}/asrun?${query}`,
        headers: cookieHeader(cookie),
      }),
  };
}

async function song(scope: StationScope, title: string, artists: string[]) {
  const sha256 = randomBytes(32).toString('hex');
  const ctx = { actor: system, scope };
  const asset = await createAsset(tdb.db, ctx, { type: 'song', title, artists });
  await putAssetFile(tdb.db, ctx, asset.id, {
    role: 'playout',
    storageKey: contentKey({ orgId: scope.orgId, sha256, ext: 'flac' }),
    sha256,
    sizeBytes: 1000,
    codec: 'flac',
    sampleRate: 44_100,
    flacBlockSize: 1024,
  });
  return { assetId: asset.id, sha256 };
}

async function logItemFor(scope: StationScope, assetId: string, plannedStart: Date) {
  const [day] = await tdb.db
    .insert(logDay)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      localDate: '2026-06-10',
      startsAt: new Date(plannedStart.getTime() - 3_600_000),
      endsAt: new Date(plannedStart.getTime() + 3_600_000),
    })
    .returning();
  if (!day) throw new Error('no day');
  const [item] = await tdb.db
    .insert(logItem)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      logDayId: day.id,
      position: 0,
      kind: 'song',
      plannedStart,
      plannedDurationMs: 180_000,
      assetId,
      originType: 'manual',
    })
    .returning({ id: logItem.id });
  if (!item) throw new Error('no item');
  return item.id;
}

const rows = (scope: StationScope) =>
  tdb.db.select().from(asRunEntry).where(eq(asRunEntry.stationId, scope.stationId));

/** Waits until the station has `n` entries matching `done`. */
const waitRows = (
  scope: StationScope,
  what: string,
  done: (r: Awaited<ReturnType<typeof rows>>) => boolean,
) =>
  waitFor(what, async () => {
    const r = await rows(scope);
    return done(r) ? r : undefined;
  });

describe('recording', () => {
  it('records a log item from track.started and closes it on track.ended', async () => {
    const st = await newStation();
    const s = await song(st.scope, 'Gaby oh Gaby', ['Alain Bashung']);
    const plannedStart = new Date('2026-06-10T10:00:00.000Z');
    const itemId = await logItemFor(st.scope, s.assetId, plannedStart);
    const startedAt = new Date('2026-06-10T10:00:01.250Z');

    const started = await st.engine(
      'engine.track.started',
      {
        itemId,
        segmentId: null,
        source: 'queue',
        title: 'Gaby oh Gaby',
        artist: null,
        filename: `/cache/media/${s.sha256.slice(0, 2)}/${s.sha256}.flac`,
        rid: '7',
      },
      { at: startedAt },
    );
    const [entry] = await waitRows(st.scope, 'start', (r) => r.length === 1);
    expect(entry).toMatchObject({
      source: 'log',
      logItemId: itemId,
      kind: 'song',
      assetId: s.assetId,
      fileSha256: s.sha256,
      title: 'Gaby oh Gaby',
      artist: 'Alain Bashung',
      artists: ['Alain Bashung'],
      plannedStart,
      plannedDurationMs: 180_000,
      startedAt,
      endedAt: null,
      outcome: null,
      bootId: st.bootId,
      eventId: started.id,
    });
    const startEvent = await waitFor('asrun.started', () =>
      asRunEvents.find((e) => e.type === 'asrun.started' && e.data.id === entry?.id),
    );
    expect(startEvent.data.driftMs).toBe(1250);
    expect(startEvent.stationId).toBe(st.scope.stationId);

    await st.engine(
      'engine.track.ended',
      {
        itemId,
        segmentId: null,
        source: 'queue',
        startedAt: startedAt.toISOString(),
        played: 179.5,
      },
      { at: new Date(startedAt.getTime() + 179_500) },
    );
    const [ended] = await waitRows(st.scope, 'end', (r) => r[0]?.endedAt != null);
    expect(ended).toMatchObject({
      endedAt: new Date(startedAt.getTime() + 179_500),
      durationMs: 179_500,
      outcome: 'complete',
    });
    await waitFor('asrun.ended', () =>
      asRunEvents.find((e) => e.type === 'asrun.ended' && e.data.id === entry?.id),
    );
  });

  it('ignores redelivered events: no duplicate row, no second end, no new event id', async () => {
    const st = await newStation();
    const at = new Date('2026-06-10T12:00:00.000Z');
    const started = await st.engine(
      'engine.track.started',
      {
        itemId: null,
        segmentId: null,
        source: 'safety',
        title: 'Safety',
        artist: 'Someone',
        filename: '/safety/a.mp3',
        rid: '1',
      },
      { at },
    );
    const ended = await st.engine(
      'engine.track.ended',
      {
        itemId: null,
        segmentId: null,
        source: 'safety',
        startedAt: at.toISOString(),
        played: 60,
      },
      { at: new Date(at.getTime() + 60_000) },
    );
    const [first] = await waitRows(st.scope, 'ended', (r) => r[0]?.endedAt != null);
    const ids = () =>
      new Set(asRunEvents.filter((e) => e.stationId === st.scope.stationId).map((e) => e.id));
    await waitFor('both events', () => ids().size === 2);
    const before = ids();

    // Redeliveries (same ids), then a later event to know the queue got past them.
    await rabbit.events.publish(started);
    await rabbit.events.publish(ended);
    await rabbit.events.publish(started);
    await st.engine(
      'engine.track.started',
      {
        itemId: null,
        segmentId: null,
        source: 'safety',
        title: 'Next',
        artist: null,
        filename: null,
        rid: '2',
      },
      { at: new Date(at.getTime() + 60_000) },
    );
    const after = await waitRows(st.scope, 'sentinel', (r) => r.length === 2);
    expect(after.find((r) => r.id === first?.id)).toEqual(first);
    await waitFor('sentinel event', () =>
      asRunEvents.find((e) => e.stationId === st.scope.stationId && e.data.title === 'Next'),
    );
    // Redeliveries republish the same events (same ids); only the sentinel's is new.
    const now = ids();
    expect(now.size).toBe(before.size + 1);
    for (const id of before) expect(now.has(id)).toBe(true);
  });

  it('finds the asset of a file from its cache path', async () => {
    const st = await newStation();
    const s = await song(st.scope, 'Safety song', ['A', 'B']);
    const at = new Date('2026-06-10T13:00:00.000Z');
    await st.engine(
      'engine.track.started',
      {
        itemId: null,
        segmentId: null,
        source: 'queue',
        title: null,
        artist: null,
        filename: `media/${s.sha256.slice(0, 2)}/${s.sha256}.flac`,
        rid: '3',
      },
      { at },
    );
    const [entry] = await waitRows(st.scope, 'start', (r) => r.length === 1);
    expect(entry).toMatchObject({
      source: 'log',
      logItemId: null,
      assetId: s.assetId,
      fileSha256: s.sha256,
      title: 'Safety song',
      artist: 'A, B',
      artists: ['A', 'B'],
      plannedStart: null,
    });
  });

  it('closes the entry on air when the engine restarts (interrupted)', async () => {
    const st = await newStation();
    const s = await song(st.scope, 'Long', ['X']);
    const itemId = await logItemFor(st.scope, s.assetId, new Date('2026-06-10T14:00:00Z'));
    const at = new Date('2026-06-10T14:00:00.000Z');
    await st.engine(
      'engine.track.started',
      {
        itemId,
        segmentId: null,
        source: 'queue',
        title: 'Long',
        artist: 'X',
        filename: null,
        rid: '1',
      },
      { at },
    );
    await waitRows(st.scope, 'start', (r) => r.length === 1);
    const newBoot = randomUUID();
    await st.engine(
      'engine.booted',
      { version: '2.4.6' },
      { at: new Date(at.getTime() + 30_000), bootId: newBoot },
    );
    const [entry] = await waitRows(st.scope, 'interrupted', (r) => r[0]?.endedAt != null);
    expect(entry).toMatchObject({
      outcome: 'interrupted',
      durationMs: 30_000,
      endedAt: new Date(at.getTime() + 30_000),
      endSeq: null,
    });
    const ended = await waitFor('asrun.ended', () =>
      asRunEvents.find((e) => e.type === 'asrun.ended' && e.data.id === entry?.id),
    );
    expect(ended.data.outcome).toBe('interrupted');
  });

  it('closes entries of earlier boots even if the engine clock stepped back', async () => {
    const st = await newStation();
    const at = new Date('2026-06-10T14:30:00.000Z');
    await st.engine(
      'engine.track.started',
      {
        itemId: null,
        segmentId: null,
        source: 'safety',
        title: 'Before',
        artist: null,
        filename: null,
        rid: '1',
      },
      { at },
    );
    await waitRows(st.scope, 'start', (r) => r.length === 1);
    // The new boot's clock is 10 s behind the previous start.
    await st.engine(
      'engine.booted',
      { version: '2.4.6' },
      { at: new Date(at.getTime() - 10_000), bootId: randomUUID() },
    );
    const [entry] = await waitRows(st.scope, 'interrupted', (r) => r[0]?.endedAt != null);
    expect(entry).toMatchObject({ outcome: 'interrupted', durationMs: 0, endedAt: at });
  });

  it('marks an early end as cut and a near-immediate one as skipped', async () => {
    const st = await newStation();
    const s = await song(st.scope, 'Planned', ['P']);
    const t = new Date('2026-06-10T16:00:00.000Z');
    const cutItem = await logItemFor(st.scope, s.assetId, t);
    const [day] = await tdb.db.select().from(logItem).where(eq(logItem.id, cutItem));
    const [skipRow] = await tdb.db
      .insert(logItem)
      .values({
        orgId: st.scope.orgId,
        stationId: st.scope.stationId,
        logDayId: day?.logDayId as string,
        position: 1,
        kind: 'song',
        plannedStart: new Date(t.getTime() + 180_000),
        plannedDurationMs: 180_000,
        assetId: s.assetId,
        originType: 'manual',
      })
      .returning({ id: logItem.id });
    const skipItem = skipRow?.id as string;
    const play = async (itemId: string, startedAt: Date, played: number, rid: string) => {
      await st.engine(
        'engine.track.started',
        {
          itemId,
          segmentId: null,
          source: 'queue',
          title: null,
          artist: null,
          filename: null,
          rid,
        },
        { at: startedAt },
      );
      await st.engine(
        'engine.track.ended',
        { itemId, segmentId: null, source: 'queue', startedAt: startedAt.toISOString(), played },
        { at: new Date(startedAt.getTime() + played * 1000) },
      );
    };
    await play(cutItem, t, 90, '1');
    await play(skipItem, new Date(t.getTime() + 90_000), 2, '2');
    const done = await waitRows(
      st.scope,
      'two ended',
      (r) => r.filter((e) => e.endedAt).length === 2,
    );
    expect(done.find((e) => e.logItemId === cutItem)?.outcome).toBe('cut');
    expect(done.find((e) => e.logItemId === skipItem)?.outcome).toBe('skipped');
  });

  it("records the live session on air, and drops ids that are not this station's", async () => {
    const st = await newStation();
    const other = await newStation();
    const s = await song(other.scope, 'Elsewhere', ['O']);
    const foreignItem = await logItemFor(other.scope, s.assetId, new Date('2026-06-10T17:00:00Z'));
    const sessionId = randomUUID();
    const at = new Date('2026-06-10T17:00:00.000Z');
    await st.engine(
      'engine.track.started',
      {
        itemId: null,
        segmentId: null,
        source: 'live',
        title: 'Live show',
        artist: 'DJ',
        filename: null,
        rid: null,
        liveSessionId: sessionId,
      },
      { at },
    );
    await st.engine(
      'engine.track.started',
      {
        itemId: foreignItem,
        segmentId: randomUUID(),
        source: 'queue',
        title: 'Foreign',
        artist: null,
        filename: null,
        rid: '9',
        liveSessionId: randomUUID(),
      },
      { at: new Date(at.getTime() + 60_000) },
    );
    const entries = await waitRows(st.scope, 'both', (r) => r.length === 2);
    expect(entries.find((e) => e.source === 'live')).toMatchObject({ liveSessionId: sessionId });
    expect(entries.find((e) => e.title === 'Foreign')).toMatchObject({
      engineItemId: foreignItem,
      logItemId: null,
      segmentId: null,
      assetId: null,
      plannedStart: null,
      liveSessionId: null,
    });
  });

  it('records the whole entry from track.ended when its start was lost', async () => {
    const st = await newStation();
    const startedAt = new Date('2026-06-10T15:00:00.000Z');
    await st.engine(
      'engine.track.ended',
      {
        itemId: null,
        segmentId: null,
        source: 'live',
        startedAt: startedAt.toISOString(),
        played: 1800,
      },
      { at: new Date(startedAt.getTime() + 1_800_000) },
    );
    const [entry] = await waitRows(st.scope, 'end-only', (r) => r.length === 1);
    expect(entry).toMatchObject({
      source: 'live',
      startedAt,
      endedAt: new Date(startedAt.getTime() + 1_800_000),
      durationMs: 1_800_000,
      outcome: 'complete',
    });
    const ended = await waitFor('asrun.ended', () =>
      asRunEvents.find((e) => e.type === 'asrun.ended' && e.data.id === entry?.id),
    );
    expect(ended.data.endedAt).toBe(new Date(startedAt.getTime() + 1_800_000).toISOString());
  });
});

describe('queries', () => {
  async function seed(
    scope: StationScope,
    startedAt: Date,
    opts: { artists?: string[]; assetId?: string } = {},
  ) {
    const recorded = await repo.recordStart(tdb.db, scope, {
      eventId: randomUUID(),
      bootId: 'boot',
      seq: Math.floor(Math.random() * 1e9) + 1,
      at: startedAt,
      itemId: null,
      segmentId: null,
      source: 'safety',
      title: startedAt.toISOString(),
      artist: opts.artists?.[0] ?? null,
      filename: null,
      rid: null,
    });
    if (!recorded) throw new Error('not recorded');
    const { entry } = recorded;
    if (opts.assetId || opts.artists) {
      await tdb.db
        .update(asRunEntry)
        .set({ assetId: opts.assetId ?? null, artists: opts.artists ?? [] })
        .where(eq(asRunEntry.id, entry.id));
    }
    return entry;
  }

  it('lists a range in air order, pages with the cursor, and reads newest first', async () => {
    const st = await newStation();
    const base = Date.parse('2026-06-11T08:00:00Z');
    for (let i = 0; i < 5; i++) await seed(st.scope, new Date(base + i * 60_000));
    const from = new Date(base).toISOString();
    const to = new Date(base + 3_600_000).toISOString();

    const page1 = (await st.api(`from=${from}&to=${to}&limit=2`)).json() as AsRunList;
    expect(page1.items.map((e) => e.startedAt)).toEqual([
      new Date(base).toISOString(),
      new Date(base + 60_000).toISOString(),
    ]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = (
      await st.api(`from=${from}&to=${to}&limit=2&cursor=${page1.nextCursor}`)
    ).json() as AsRunList;
    const page3 = (
      await st.api(`from=${from}&to=${to}&limit=2&cursor=${page2.nextCursor}`)
    ).json() as AsRunList;
    expect([...page1.items, ...page2.items, ...page3.items]).toHaveLength(5);
    expect(page3.nextCursor).toBeNull();

    const latest = (await st.api(`from=${from}&to=${to}&order=desc&limit=1`)).json() as AsRunList;
    expect(latest.items[0]?.startedAt).toBe(new Date(base + 4 * 60_000).toISOString());

    expect((await st.api(`from=${from}&to=${to}&cursor=nope`)).statusCode).toBe(400);
    expect((await st.api(`from=${from}`)).statusCode).toBe(400);
  });

  it('covers the 25 h station-local day at the end of DST (Europe/Paris)', async () => {
    const st = await newStation();
    // 2026-10-25 local runs from 2026-10-24T22:00Z to 2026-10-25T23:00Z.
    await seed(st.scope, new Date('2026-10-24T21:59:59.999Z')); // 23:59:59 on the 24th
    await seed(st.scope, new Date('2026-10-24T22:00:00.000Z')); // 00:00 on the 25th
    await seed(st.scope, new Date('2026-10-25T00:30:00.000Z')); // 02:30 CEST
    await seed(st.scope, new Date('2026-10-25T01:30:00.000Z')); // 02:30 CET, the repeated hour
    await seed(st.scope, new Date('2026-10-25T22:59:59.999Z')); // 23:59:59 on the 25th
    await seed(st.scope, new Date('2026-10-25T23:00:00.000Z')); // 00:00 on the 26th
    const day = (await st.api('date=2026-10-25')).json() as AsRunList;
    expect(day.from).toBe('2026-10-24T22:00:00.000Z');
    expect(day.to).toBe('2026-10-25T23:00:00.000Z');
    expect(day.items.map((e) => e.startedAt)).toEqual([
      '2026-10-24T22:00:00.000Z',
      '2026-10-25T00:30:00.000Z',
      '2026-10-25T01:30:00.000Z',
      '2026-10-25T22:59:59.999Z',
    ]);
    // Spring forward: 2026-03-29 local runs from 2026-03-28T23:00Z to 2026-03-29T22:00Z (23 h).
    await seed(st.scope, new Date('2026-03-28T22:59:59.999Z')); // 23:59:59 on the 28th
    await seed(st.scope, new Date('2026-03-28T23:00:00.000Z')); // 00:00 on the 29th
    await seed(st.scope, new Date('2026-03-29T00:59:59.000Z')); // 01:59:59 CET
    await seed(st.scope, new Date('2026-03-29T01:00:00.000Z')); // 03:00 CEST (02:xx skipped)
    await seed(st.scope, new Date('2026-03-29T21:59:59.999Z')); // 23:59:59 on the 29th
    await seed(st.scope, new Date('2026-03-29T22:00:00.000Z')); // 00:00 on the 30th
    const spring = (await st.api('date=2026-03-29')).json() as AsRunList;
    expect(spring.from).toBe('2026-03-28T23:00:00.000Z');
    expect(spring.to).toBe('2026-03-29T22:00:00.000Z');
    expect(spring.items.map((e) => e.startedAt)).toEqual([
      '2026-03-28T23:00:00.000Z',
      '2026-03-29T00:59:59.000Z',
      '2026-03-29T01:00:00.000Z',
      '2026-03-29T21:59:59.999Z',
    ]);
  });

  it("is tenant-scoped: another station's history never shows, outsiders get a 404", async () => {
    const a = await newStation();
    const b = await newStation(false);
    const at = new Date('2026-06-12T08:00:00Z');
    await seed(a.scope, at);
    await seed(b.scope, at);
    const range = `from=${at.toISOString()}&to=${new Date(at.getTime() + 60_000).toISOString()}`;
    const list = (await a.api(range)).json() as AsRunList;
    expect(list.items.map((e) => e.stationId)).toEqual([a.scope.stationId]);
    expect((await b.api(range)).statusCode).toBe(404);
    expect((await a.api(range, outsider.cookie)).statusCode).toBe(404);
    expect((await a.api(range, '')).statusCode).toBe(401);
  });

  it('answers last aired by asset and artist, and what is on air', async () => {
    const st = await newStation();
    const s = await song(st.scope, 'T', ['Kas Product']);
    const t0 = Date.parse('2026-06-13T08:00:00Z');
    await seed(st.scope, new Date(t0), { assetId: s.assetId, artists: ['Kas Product'] });
    await seed(st.scope, new Date(t0 + 3_600_000), {
      assetId: s.assetId,
      artists: ['Kas Product', 'Other'],
    });
    const byAsset = await repo.lastAiredByAsset(
      tdb.db,
      st.scope,
      [s.assetId],
      new Date(t0 + 7_200_000),
    );
    expect(byAsset.get(s.assetId)?.toISOString()).toBe(new Date(t0 + 3_600_000).toISOString());
    // `since` bounds the search: nothing aired in [t0 + 1 h + 1 ms, t0 + 2 h).
    const bounded = await repo.lastAiredByAsset(
      tdb.db,
      st.scope,
      [s.assetId],
      new Date(t0 + 7_200_000),
      new Date(t0 + 3_600_001),
    );
    expect(bounded.size).toBe(0);
    const byArtist = await repo.lastAiredByArtist(
      tdb.db,
      st.scope,
      ['Kas Product', 'Nobody'],
      new Date(t0 - 1),
      new Date(t0 + 7_200_000),
    );
    expect([...byArtist.keys()]).toEqual(['Kas Product']);
    expect(byArtist.get('Kas Product')?.toISOString()).toBe(new Date(t0 + 3_600_000).toISOString());
    const onAir = await repo.getOnAir(tdb.db, st.scope);
    expect(onAir?.startedAt).toBe(new Date(t0 + 3_600_000).toISOString());
  });
});
