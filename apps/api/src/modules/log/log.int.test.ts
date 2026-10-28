import { randomUUID } from 'node:crypto';
import {
  addMembership,
  asRunEntry,
  assetFile,
  auditLog,
  createAsset,
  createOrganization,
  createStation,
  feederPush,
  logItem,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
} from '@ondes/db';
import { createTestDatabase } from '@ondes/db/testing';
import {
  connectQueue,
  createEventPublisher,
  createJobPublisher,
  deleteTopology,
  type QueueConnection,
  subscribeEvents,
} from '@ondes/queue';
import {
  type Actor,
  addDays,
  type LogItem,
  type LogRangeResponse,
  localDateOf,
  type RealtimeEvent,
  realtimeEventSchema,
} from '@ondes/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../../app.ts';
import { createMemoryMailer } from '../../plugins/mail.ts';
import type { Rabbit } from '../../plugins/rabbit.ts';
import { signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../auth/testing.ts';
import { buildFixtureDay, FIXTURE_LIBRARY, type FixtureAsset } from './fixture.ts';
import { type LogDayItemInput, writeLogDay } from './repo.ts';
import { localDayBounds } from './time.ts';

// The log API on the real app: auth and tenant scoping, edits with audit and events on the
// RabbitMQ fanout, range queries across a DST day.

const system: Actor = { type: 'system', name: 'test' };
const rabbitUrl = process.env.RABBITMQ_URL ?? 'amqp://ondes:ondes@127.0.0.1:5672/ondes';

let t: TestApp;
let queue: QueueConnection;
let closeRabbit: () => Promise<void>;
const events: RealtimeEvent[] = [];

let scope: StationScope;
let otherScope: StationScope;
let stationId: string;
let otherStationId: string;
const songs: string[] = [];
let otherAsset: string;
const cookies: Record<'programmer' | 'viewer' | 'outsider', string> = {
  programmer: '',
  viewer: '',
  outsider: '',
};

beforeAll(async () => {
  queue = await connectQueue(rabbitUrl, { prefix: `test-${randomUUID().slice(0, 8)}` });
  const publisher = createEventPublisher(queue.rabbit, queue.topology, z.unknown());
  const jobs = createJobPublisher(queue.rabbit, queue.topology);
  const rabbit: Rabbit = {
    queue,
    jobs,
    events: publisher,
    subscribeEvents: (onEvent) =>
      subscribeEvents(queue.rabbit, queue.topology, z.unknown(), onEvent),
    close: async () => {},
  };
  const sub = subscribeEvents(queue.rabbit, queue.topology, realtimeEventSchema, (e) => {
    events.push(e);
  });
  await sub.ready;
  closeRabbit = async () => {
    await sub.close();
    await Promise.all([publisher.close(), jobs.close()]);
    await deleteTopology(queue.rabbit, queue.topology);
    await queue.close();
  };

  const tdb = await createTestDatabase();
  const mailer = createMemoryMailer();
  const app = await buildApp({
    db: { client: tdb },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    rabbit: { rabbit },
    fastify: { logger: false },
  });
  await app.ready();
  t = {
    app,
    tdb,
    outbox: mailer.outbox,
    close: async () => {
      await app.close();
      await tdb.drop();
    },
  };

  const db = tdb.db;
  const org = await createOrganization(db, system, { slug: 'log-org', name: 'Org' });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: 'log-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  stationId = st.id;
  scope = await resolveStationScope(db, org.id, st.id);
  for (const title of ['A', 'B', 'C', 'D']) {
    songs.push(
      (await createAsset(db, { actor: system, scope }, { type: 'song', title, durationMs: 60_000 }))
        .id,
    );
  }

  const other = await createOrganization(db, system, { slug: 'other-org', name: 'Other' });
  const otherOrgScope = await resolveOrgScope(db, other.id);
  const ost = await createStation(
    db,
    { actor: system, scope: otherOrgScope },
    { slug: 'other-fm', name: 'Other FM', timezone: 'Europe/Paris' },
  );
  otherStationId = ost.id;
  otherScope = await resolveStationScope(db, other.id, ost.id);
  otherAsset = (
    await createAsset(db, { actor: system, scope: otherScope }, { type: 'song', title: 'X' })
  ).id;

  for (const role of ['programmer', 'viewer'] as const) {
    const { userId, cookie } = await signUpAndLogin(t, `${role}@log.test`);
    await addMembership(
      db,
      { actor: system, scope: orgScope },
      { level: 'station', stationId, userId, role },
    );
    cookies[role] = cookie;
  }
  // Owner of the other org: a member somewhere, but not of this station.
  const outsider = await signUpAndLogin(t, 'outsider@log.test');
  await addMembership(
    db,
    { actor: system, scope: otherOrgScope },
    { level: 'org', userId: outsider.userId, role: 'owner' },
  );
  cookies.outsider = outsider.cookie;
}, 60_000);

afterAll(async () => {
  await t?.close();
  await closeRabbit?.();
});

function call(
  who: keyof typeof cookies,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  station = stationId,
) {
  return t.app.inject({
    method,
    url: `/api/v1/stations/${station}${url}`,
    cookies: { ondes_session: cookies[who] },
    ...(payload ? { payload } : {}),
  });
}

const song = (assetId: string, ms = 60_000): LogDayItemInput => ({
  kind: 'song',
  assetId,
  plannedDurationMs: ms,
  origin: { type: 'clock', clockId: null, slotIndex: 0 },
});

async function range(from: string, to: string, who: keyof typeof cookies = 'programmer') {
  const res = await call(who, 'GET', `/log?from=${from}&to=${to}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as LogRangeResponse;
}

/** Waits for events matching `pred` (the fanout is asynchronous). */
async function waitForEvents(pred: (e: RealtimeEvent) => boolean, count: number) {
  for (let i = 0; i < 100; i++) {
    const found = events.filter(pred);
    if (found.length >= count) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`expected ${count} events, got ${events.filter(pred).length}`);
}

describe('log reads', () => {
  it('serves a DST day (25 h) and range queries across the switch', async () => {
    // Last Sunday of October 2026, Europe/Paris: 03:00 CEST → 02:00 CET.
    const localDate = '2026-10-25';
    const { startsAt, endsAt } = localDayBounds(localDate, 'Europe/Paris');
    const assets: FixtureAsset[] = [];
    for (const spec of FIXTURE_LIBRARY) {
      const a = await createAsset(t.tdb.db, { actor: system, scope }, spec);
      assets.push({ id: a.id, type: a.type, title: a.title, durationMs: spec.durationMs });
    }
    await writeLogDay(
      t.tdb.db,
      { actor: system, scope },
      {
        localDate,
        status: 'published',
        items: buildFixtureDay(localDate, 'Europe/Paris', assets),
        cause: 'fixture',
      },
    );

    const day = await range(startsAt.toISOString(), endsAt.toISOString());
    expect(day.days).toHaveLength(1);
    expect(day.days[0]).toMatchObject({
      localDate,
      startsAt: '2026-10-24T22:00:00.000Z',
      endsAt: '2026-10-25T23:00:00.000Z',
      status: 'published',
    });
    expect(day.items[0]?.plannedStart).toBe(startsAt.toISOString());
    const last = day.items.at(-1) as LogItem;
    expect(Date.parse(last.plannedStart) + last.plannedDurationMs).toBe(endsAt.getTime());
    // Two markers for local 02:00: one in summer time, one in winter time.
    const twoAm = day.items.filter((i) => i.kind === 'marker' && i.title === 'Top of hour 02:00');
    expect(twoAm.map((i) => i.plannedStart)).toEqual([
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T01:00:00.000Z',
    ]);
    // Voice tracks are segue lanes now (the seed creates them): the fixture has no segments.
    expect(day.items.some((i) => i.kind === 'segment')).toBe(false);
    expect(day.items.some((i) => i.segmentId !== null)).toBe(false);

    // The hour around the switch, starting mid-item: the item on air at `from` is included.
    const from = '2026-10-25T00:30:00.000Z';
    const to = '2026-10-25T01:30:00.000Z';
    const hour = await range(from, to);
    const first = hour.items[0] as LogItem;
    expect(Date.parse(first.plannedStart)).toBeLessThanOrEqual(Date.parse(from));
    expect(Date.parse(first.plannedStart) + first.plannedDurationMs).toBeGreaterThan(
      Date.parse(from),
    );
    for (const i of hour.items) expect(Date.parse(i.plannedStart)).toBeLessThan(Date.parse(to));

    // A range across two days returns both days and the items of both.
    const prevDay = await range('2026-10-24T21:00:00.000Z', '2026-10-24T23:00:00.000Z');
    expect(prevDay.days.map((d) => d.localDate)).toEqual([localDate]);
    expect(prevDay.items[0]?.plannedStart).toBe(startsAt.toISOString());

    // Now: the current item and the next ones.
    const now = await call('viewer', 'GET', `/log/now?at=${from}&next=3`);
    expect(now.statusCode, now.body).toBe(200);
    expect(now.json().current.id).toBe(first.id);
    expect(now.json().next.map((i: LogItem) => i.id)).toEqual(
      hour.items.slice(1, 4).map((i) => i.id),
    );
    const empty = await call('viewer', 'GET', '/log/now?at=2030-01-01T00:00:00Z');
    expect(empty.json()).toMatchObject({ current: null, next: [] });
  });

  it('validates the range', async () => {
    const res = await call(
      'programmer',
      'GET',
      '/log?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z',
    );
    expect(res.statusCode).toBe(400);
    const long = await call(
      'programmer',
      'GET',
      '/log?from=2026-10-01T00:00:00Z&to=2026-10-20T00:00:00Z',
    );
    expect(long.statusCode).toBe(400);
  });
});

describe('log edits', () => {
  const localDate = '2026-11-10';
  const dayStart = localDayBounds(localDate, 'Europe/Paris').startsAt;
  const at = (min: number) => new Date(dayStart.getTime() + Math.round(min * 60_000)).toISOString();
  let ids: string[] = [];

  beforeAll(async () => {
    await writeLogDay(
      t.tdb.db,
      { actor: system, scope },
      {
        localDate,
        status: 'published',
        items: [
          song(songs[0] as string),
          song(songs[1] as string),
          {
            kind: 'marker',
            title: 'news',
            timing: 'hard',
            anchorAt: at(10),
            origin: { type: 'manual' },
          },
          song(songs[2] as string),
        ],
        cause: 'fixture',
      },
    );
    const day = await range(at(0), at(60));
    ids = day.items.map((i) => i.id);
    expect(day.items.map((i) => i.plannedStart)).toEqual([at(0), at(1), at(10), at(10)]);
  });

  const audits = (entityId: string) =>
    t.tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, entityId), eq(auditLog.stationId, stationId)));

  it('inserts, retimes the flow after it, audits and publishes', async () => {
    const before = events.length;
    const res = await call('programmer', 'POST', '/log/items', {
      placement: { after: ids[0] },
      item: { kind: 'song', assetId: songs[3], plannedDurationMs: 30_000 },
    });
    expect(res.statusCode, res.body).toBe(201);
    const { item, days } = res.json();
    expect(item).toMatchObject({ position: 1, plannedStart: at(1), origin: { type: 'manual' } });
    expect(item.asset).toMatchObject({ id: songs[3], title: 'D', type: 'song' });
    const day = await range(at(0), at(60));
    expect(day.items.map((i) => i.plannedStart)).toEqual([at(0), at(1), at(1.5), at(10), at(10)]);
    expect(day.days[0]?.version).toBe(days[0].version);

    const [audit] = await audits(item.id);
    expect(audit).toMatchObject({ action: 'log_item.insert', actorType: 'user' });

    const published = (await waitForEvents(() => true, before + 2)).slice(before);
    const changed = published.find((e) => e.type === 'log.item.changed');
    const updated = published.find((e) => e.type === 'log.updated');
    expect(changed).toMatchObject({
      stationId,
      data: { itemId: item.id, change: 'inserted', item: { id: item.id } },
    });
    expect(updated).toMatchObject({
      stationId,
      data: {
        cause: 'edit',
        // D is new and B moved; the marker and C changed position only.
        from: at(1),
        to: at(11),
        days: [{ localDate, version: days[0].version }],
      },
    });
    ids = day.items.map((i) => i.id);
  });

  it('replaces, moves, locks and deletes', async () => {
    const target = ids[1] as string;
    const replaced = await call('programmer', 'PUT', `/log/items/${target}`, {
      kind: 'jingle',
      assetId: songs[3],
      plannedDurationMs: 10_000,
      title: 'now a jingle',
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json().item).toMatchObject({ id: target, kind: 'jingle', position: 1 });

    // Move the first song after the second: B now opens the day.
    const moved = await call('programmer', 'POST', `/log/items/${ids[0]}/move`, {
      placement: { after: ids[2] },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    let day = await range(at(0), at(60));
    expect(day.items.map((i) => i.id)).toEqual([ids[1], ids[2], ids[0], ids[3], ids[4]]);
    expect(day.items.map((i) => i.position)).toEqual([0, 1, 2, 3, 4]);
    expect(day.items.map((i) => i.plannedStart)).toEqual([
      at(0),
      at(1 / 6),
      at(7 / 6),
      at(10),
      at(10),
    ]);

    const locked = await call('programmer', 'PUT', `/log/items/${ids[0]}/lock`, { locked: true });
    expect(locked.json().item.locked).toBe(true);
    const refused = await call('programmer', 'DELETE', `/log/items/${ids[0]}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('log_item_locked');
    await call('programmer', 'PUT', `/log/items/${ids[0]}/lock`, { locked: false });
    const deleted = await call('programmer', 'DELETE', `/log/items/${ids[0]}`);
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json().item).toBeNull();

    day = await range(at(0), at(60));
    expect(day.items.map((i) => i.id)).toEqual([ids[1], ids[2], ids[3], ids[4]]);
    expect((await audits(ids[0] as string)).map((a) => a.action).sort()).toEqual([
      'log_item.delete',
      'log_item.lock',
      'log_item.move',
      'log_item.unlock',
    ]);
    await waitForEvents(
      (e) =>
        e.type === 'log.item.changed' && e.data.itemId === ids[0] && e.data.change === 'deleted',
      1,
    );
  });

  it('replaces and moves in one edit: one transaction, one audit row (#52)', async () => {
    // [jingle, B, marker at :10, C]: the marker moves to :00:30, before B.
    const [jingle, b, marker, c] = (await range(at(0), at(60))).items.map((i) => i.id);
    const self = await call('programmer', 'PUT', `/log/items/${marker}`, {
      kind: 'marker',
      plannedDurationMs: 0,
      title: 'news',
      timing: 'soft',
      anchorAt: at(0.5),
      capMs: 20_000,
      placement: { before: marker },
    });
    expect(self.statusCode).toBe(422);
    const res = await call('programmer', 'PUT', `/log/items/${marker}`, {
      kind: 'marker',
      plannedDurationMs: 0,
      title: 'news',
      timing: 'soft',
      anchorAt: at(0.5),
      capMs: 20_000,
      placement: { before: b },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().item).toMatchObject({ id: marker, timing: 'soft', anchorAt: at(0.5) });
    const day = await range(at(0), at(60));
    expect(day.items.map((i) => i.id)).toEqual([jingle, marker, b, c]);
    expect((await audits(marker as string)).map((a) => a.action)).toEqual(['log_item.replace']);
  });

  it('handles segments as one item', async () => {
    const res = await call('programmer', 'POST', '/log/items', {
      placement: { localDate },
      item: {
        kind: 'segment',
        parts: [
          { kind: 'song', assetId: songs[0], plannedDurationMs: 40_000 },
          { kind: 'song', assetId: songs[1], plannedDurationMs: 20_000 },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const seg = res.json().item as LogItem;
    // Raw part lengths plus one 20 ms transition out of the segment.
    expect(seg).toMatchObject({ kind: 'segment', plannedDurationMs: 60_020 });
    expect(seg.parts.map((p) => p.segmentId)).toEqual([seg.id, seg.id]);
    expect(Date.parse(seg.parts[1]?.plannedStart ?? '')).toBe(
      Date.parse(seg.plannedStart) + 40_000,
    );

    const partId = seg.parts[0]?.id as string;
    expect((await call('programmer', 'DELETE', `/log/items/${partId}`)).json().error).toBe(
      'segment_part',
    );
    expect(
      (
        await call('programmer', 'POST', '/log/items', {
          placement: { before: partId },
          item: { kind: 'marker' },
        })
      ).statusCode,
    ).toBe(422);

    const del = await call('programmer', 'DELETE', `/log/items/${seg.id}`);
    expect(del.statusCode, del.body).toBe(200);
    const left = await t.tdb.db.select().from(logItem).where(eq(logItem.segmentId, seg.id));
    expect(left).toHaveLength(0);
  });

  it('creates a draft day when inserting into an empty date', async () => {
    const res = await call('programmer', 'POST', '/log/items', {
      placement: { localDate: '2026-03-29' },
      item: { kind: 'marker', title: 'start' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().days[0]).toMatchObject({
      localDate: '2026-03-29',
      status: 'draft',
      startsAt: '2026-03-28T23:00:00.000Z',
      endsAt: '2026-03-29T22:00:00.000Z',
    });
    expect(res.json().item.plannedStart).toBe('2026-03-28T23:00:00.000Z');
  });
});

describe('log timing, concurrency and status', () => {
  const bounds = (d: string) => localDayBounds(d, 'Europe/Paris');
  const write = (
    localDate: string,
    items: LogDayItemInput[],
    status: 'draft' | 'published' = 'published',
  ) =>
    writeLogDay(t.tdb.db, { actor: system, scope }, { localDate, status, items, cause: 'fixture' });
  const dayItems = async (localDate: string) => {
    const { startsAt, endsAt } = bounds(localDate);
    return (await range(startsAt.toISOString(), endsAt.toISOString())).items.filter(
      (i) => Date.parse(i.plannedStart) >= startsAt.getTime(),
    );
  };

  it("refuses anchors outside the item's day", async () => {
    const localDate = '2026-12-01';
    await write(localDate, [song(songs[0] as string)]);
    const { endsAt } = bounds(localDate);
    const res = await call('programmer', 'POST', '/log/items', {
      placement: { localDate },
      item: { kind: 'marker', timing: 'hard', anchorAt: endsAt.toISOString() },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error).toBe('anchor_outside_day');
    // Moving an anchored item to another day is refused the same way.
    const ok = await call('programmer', 'POST', '/log/items', {
      placement: { localDate },
      item: {
        kind: 'marker',
        timing: 'hard',
        anchorAt: new Date(endsAt.getTime() - 60_000).toISOString(),
      },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const moved = await call('programmer', 'POST', `/log/items/${ok.json().item.id}/move`, {
      placement: { localDate: '2026-12-02' },
    });
    expect(moved.statusCode).toBe(422);
    expect(moved.json().error).toBe('anchor_outside_day');
  });

  it('reports conflicts, and serves /now in play order', async () => {
    const localDate = '2026-12-03';
    const { startsAt } = bounds(localDate);
    const at = (s: number) => new Date(startsAt.getTime() + s * 1000).toISOString();
    await write(localDate, [
      song(songs[0] as string, 90_000),
      // The song ends at 90 s: a 30 s overrun into this hard start.
      {
        kind: 'marker',
        title: 'hard',
        timing: 'hard',
        anchorAt: at(60),
        origin: { type: 'manual' },
      },
      song(songs[1] as string, 60_000),
      {
        kind: 'marker',
        title: 'later',
        timing: 'hard',
        anchorAt: at(300),
        origin: { type: 'manual' },
      },
      song(songs[2] as string, 60_000),
    ]);
    const items = await dayItems(localDate);
    expect(items.map((i) => i.conflict)).toEqual([
      null,
      { kind: 'overrun', ms: 30_000 },
      null,
      { kind: 'gap', ms: 180_000 },
      null,
    ]);
    // At 70 s the first song (0–90 s) and the second (60–120 s) both cover `at`: the later one
    // in play order is current.
    const now = (await call('viewer', 'GET', `/log/now?at=${at(70)}&next=2`)).json();
    expect(now.current.id).toBe(items[2]?.id);
    expect(now.next.map((i: LogItem) => i.id)).toEqual([items[3]?.id, items[4]?.id]);
    // In the gap, a marker exactly at `at` is the first next item.
    const gap = (await call('viewer', 'GET', `/log/now?at=${at(300)}&next=2`)).json();
    expect(gap.current?.id).toBe(items[4]?.id);
    const before = (await call('viewer', 'GET', `/log/now?at=${at(200)}&next=2`)).json();
    expect(before.current).toBeNull();
    expect(before.next.map((i: LogItem) => i.id)).toEqual([items[3]?.id, items[4]?.id]);
  });

  it('chains days at midnight', async () => {
    const [d1, d2] = ['2026-12-10', '2026-12-11'];
    const { endsAt } = bounds(d1);
    const late = new Date(endsAt.getTime() - 30_000).toISOString();
    await write(d2, [song(songs[0] as string)]);
    // Day 1 ends 30 s after midnight: day 2's first item reports the overrun.
    await write(d1, [
      { kind: 'marker', timing: 'hard', anchorAt: late, origin: { type: 'manual' } },
      song(songs[1] as string, 60_000),
    ]);
    expect((await dayItems(d2))[0]?.conflict).toEqual({ kind: 'overrun', ms: 30_000 });
    // Shortening day 1's last item through an edit turns it into a gap, and bumps day 2.
    const last = (await dayItems(d1)).at(-1) as LogItem;
    const res = await call('programmer', 'PUT', `/log/items/${last.id}`, {
      kind: 'song',
      assetId: songs[1],
      plannedDurationMs: 10_000,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().days.map((d: { localDate: string }) => d.localDate)).toEqual([d1, d2]);
    expect((await dayItems(d2))[0]?.conflict).toEqual({ kind: 'gap', ms: 20_000 });
  });

  it('serializes concurrent move and delete of the same item', async () => {
    const [d1, d2] = ['2026-12-20', '2026-12-21'];
    for (let round = 0; round < 5; round++) {
      await write(
        d1,
        songs.map((a) => song(a)),
        'published',
      );
      await write(d2, [song(songs[0] as string), song(songs[1] as string)]);
      const before1 = await dayItems(d1);
      const before2 = await dayItems(d2);
      const victim = before1[1] as LogItem;
      const [moved, deleted] = await Promise.all([
        call('programmer', 'POST', `/log/items/${victim.id}/move`, {
          placement: { localDate: d2 },
        }),
        call('programmer', 'DELETE', `/log/items/${victim.id}`),
      ]);
      // Whatever the order, the victim is gone or moved, and nothing else was touched.
      expect([200, 404, 409]).toContain(moved.statusCode);
      expect([200, 404, 409]).toContain(deleted.statusCode);
      const after = [...(await dayItems(d1)), ...(await dayItems(d2))].map((i) => i.id);
      const others = [...before1, ...before2].filter((i) => i.id !== victim.id).map((i) => i.id);
      expect(after.filter((id) => id !== victim.id).sort()).toEqual(others.sort());
      if (deleted.statusCode === 200) expect(after).not.toContain(victim.id);
    }
  });

  it('never lets a replace overwrite a concurrent lock', async () => {
    const localDate = '2026-12-24';
    for (let round = 0; round < 5; round++) {
      await write(localDate, [song(songs[0] as string), song(songs[1] as string)]);
      const target = (await dayItems(localDate))[1] as LogItem;
      const [locked, replaced] = await Promise.all([
        call('programmer', 'PUT', `/log/items/${target.id}/lock`, { locked: true }),
        call('programmer', 'PUT', `/log/items/${target.id}`, {
          kind: 'song',
          assetId: songs[2],
          plannedDurationMs: 5_000,
        }),
      ]);
      expect(locked.statusCode, locked.body).toBe(200);
      expect([200, 409]).toContain(replaced.statusCode);
      if (replaced.statusCode === 409) expect(replaced.json().error).toBe('log_item_locked');
      const item = (await dayItems(localDate))[1] as LogItem;
      expect(item.locked).toBe(true);
    }
  });

  it('publishes and unpublishes a day', async () => {
    const localDate = '2026-12-28';
    const { day } = await write(localDate, [song(songs[0] as string)], 'draft');
    const before = events.length;
    const res = await call('programmer', 'PUT', `/log/days/${localDate}/status`, {
      status: 'published',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().day).toMatchObject({ status: 'published', version: day.version + 1 });
    const [event] = (await waitForEvents(() => true, before + 1)).slice(before);
    expect(event).toMatchObject({ type: 'log.updated', data: { cause: 'status' } });
    const [audit] = await t.tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, day.id), eq(auditLog.action, 'log_day.status')));
    expect(audit?.diff).toEqual({ status: { from: 'draft', to: 'published' } });
    expect(
      (await call('programmer', 'PUT', '/log/days/2027-05-01/status', { status: 'draft' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('viewer', 'PUT', `/log/days/${localDate}/status`, { status: 'draft' }))
        .statusCode,
    ).toBe(403);
  });

  it('checks cue override sample rates against the playout copy', async () => {
    const a = await createAsset(
      t.tdb.db,
      { actor: system, scope },
      { type: 'song', title: 'Rated' },
    );
    await t.tdb.db.insert(assetFile).values({
      assetId: a.id,
      orgId: scope.orgId,
      stationId: scope.stationId,
      role: 'playout',
      storageKey: `test/${a.id}.flac`,
      sha256: '0'.repeat(64),
      sizeBytes: 1,
      codec: 'flac',
      sampleRate: 44_100,
      flacBlockSize: 1024,
    });
    const item = (sampleRate: number) => ({
      placement: { localDate: '2026-12-29' },
      item: {
        kind: 'song',
        assetId: a.id,
        plannedDurationMs: 1_000,
        cueOverrides: { sampleRate, cueIn: 10 },
      },
    });
    const bad = await call('programmer', 'POST', '/log/items', item(48_000));
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toBe('sample_rate_mismatch');
    expect((await call('programmer', 'POST', '/log/items', item(44_100))).statusCode).toBe(201);
  });
});

describe('log edits leave the past alone', () => {
  // Days relative to the real clock: the guard compares planned starts with now.
  const today = localDateOf(new Date(), 'Europe/Paris');
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);
  let past: string[] = [];
  let future: string[] = [];

  beforeAll(async () => {
    for (const localDate of [yesterday, tomorrow]) {
      await writeLogDay(
        t.tdb.db,
        { actor: system, scope },
        {
          localDate,
          status: 'published',
          items: [song(songs[0] as string), song(songs[1] as string), song(songs[2] as string)],
          cause: 'fixture',
        },
      );
    }
    const ids = async (localDate: string) => {
      const { startsAt, endsAt } = localDayBounds(localDate, 'Europe/Paris');
      return (await range(startsAt.toISOString(), endsAt.toISOString())).items
        .filter((i) => Date.parse(i.plannedStart) >= startsAt.getTime())
        .map((i) => i.id);
    };
    past = await ids(yesterday);
    future = await ids(tomorrow);
    const startedAt = new Date(Date.now() - 86_400_000);
    // Yesterday's first item aired (as-run); its second was pushed to the engine.
    await t.tdb.db.insert(asRunEntry).values({
      ...scope,
      eventId: randomUUID(),
      bootId: 'boot-guard',
      seq: 1,
      source: 'log',
      logItemId: past[0],
      startedAt,
    });
    await t.tdb.db.insert(feederPush).values([
      { ...scope, bootId: 'boot-guard', entryId: past[1] as string, fingerprint: 'x' },
      // Pushed ahead of air: still editable, the feeder re-plans.
      { ...scope, bootId: 'boot-guard', entryId: future[0] as string, fingerprint: 'y' },
    ]);
  });

  it('refuses replace, move, lock and delete of aired and on-air items', async () => {
    for (const id of [past[0], past[1]] as string[]) {
      const attempts = [
        call('programmer', 'PUT', `/log/items/${id}`, {
          kind: 'song',
          assetId: songs[3],
          plannedDurationMs: 30_000,
        }),
        call('programmer', 'POST', `/log/items/${id}/move`, { placement: { after: past[2] } }),
        call('programmer', 'PUT', `/log/items/${id}/lock`, { locked: true }),
        call('programmer', 'DELETE', `/log/items/${id}`),
      ];
      for (const res of await Promise.all(attempts)) {
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json().error).toBe('log_item_aired');
      }
    }
  });

  it('still edits items that only sit in the engine queue, or never aired', async () => {
    const queued = await call('programmer', 'PUT', `/log/items/${future[0]}/lock`, {
      locked: true,
    });
    expect(queued.statusCode, queued.body).toBe(200);
    const unplayed = await call('programmer', 'PUT', `/log/items/${past[2]}/lock`, {
      locked: true,
    });
    expect(unplayed.statusCode, unplayed.body).toBe(200);
  });
});

describe('log permissions and tenancy', () => {
  it('lets a viewer read but not write', async () => {
    expect((await call('viewer', 'GET', '/log/now')).statusCode).toBe(200);
    const res = await call('viewer', 'POST', '/log/items', {
      placement: { localDate: '2026-11-10' },
      item: { kind: 'marker' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('hides the station from other tenants', async () => {
    expect((await call('outsider', 'GET', '/log/now')).statusCode).toBe(404);
    const [any] = await t.tdb.db
      .select()
      .from(logItem)
      .where(eq(logItem.stationId, stationId))
      .limit(1);
    // The other org's owner, on their own station, naming this station's item.
    const res = await call(
      'outsider',
      'DELETE',
      `/log/items/${any?.id}`,
      undefined,
      otherStationId,
    );
    expect(res.statusCode).toBe(404);
    const lock = await call(
      'outsider',
      'PUT',
      `/log/items/${any?.id}/lock`,
      { locked: true },
      otherStationId,
    );
    expect(lock.statusCode).toBe(404);
    const other = await call(
      'outsider',
      'GET',
      '/log?from=2026-10-24T00:00:00Z&to=2026-10-26T00:00:00Z',
      undefined,
      otherStationId,
    );
    expect(other.json().items).toEqual([]);
  });

  it("refuses another station's asset", async () => {
    const res = await call('programmer', 'POST', '/log/items', {
      placement: { localDate: '2026-11-10' },
      item: { kind: 'song', assetId: otherAsset, plannedDurationMs: 1_000 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('unknown_asset');
    void otherScope;
  });
});
