import { randomUUID } from 'node:crypto';
import {
  addMembership,
  asRunEntry,
  createOrganization,
  createStation,
  liveNowPlaying,
  liveSession,
  logDay,
  logItem,
  type OrgScope,
  type StationScope,
  streamer,
  unsafeScope,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import { type Actor, type OnAir, onAirSchema } from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { createMemoryMailer } from '../../plugins/mail.ts';
import { cookieHeader, signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../auth/testing.ts';
import { createEpisode, createShow, createSlot } from '../shows/repo.ts';

// On air (#70): `GET …/on-air` on a real database. The item on air keeps the as-run's engine
// time to the millisecond (the 1 s drift budget of ADR 0034 is the client's), the next items
// move with its drift, the mode follows the source, the show block and the next show come from
// the calendar. Needs `pnpm dev:up` (Postgres).

const system: Actor = { type: 'system', name: 'test' };
const TZ = 'Europe/Paris';

let tdb: TestDatabase;
let app: FastifyInstance;
let orgScope: OrgScope;
let member: { userId: string; cookie: string };
let outsider: { userId: string; cookie: string };

beforeAll(async () => {
  tdb = await createTestDatabase();
  const mailer = createMemoryMailer();
  app = await buildApp({
    db: { client: tdb },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    alerts: { sweepIntervalMs: 0 },
    cache: { alertIntervalMs: 0 },
    fastify: { logger: false },
  });
  await app.ready();
  const org = await createOrganization(tdb.db, system, { slug: 'on-air', name: 'On air' });
  orgScope = unsafeScope(org.id);
  const t = { app, tdb, outbox: mailer.outbox } as unknown as TestApp;
  member = await signUpAndLogin(t, 'member@on-air.test');
  outsider = await signUpAndLogin(t, 'outsider@on-air.test');
}, 60_000);

afterAll(async () => {
  await app?.close();
  await tdb?.drop();
}, 60_000);

let stations = 0;
async function newStation() {
  stations++;
  const ctx = { actor: system, scope: orgScope };
  const st = await createStation(tdb.db, ctx, {
    slug: `on-air-${stations}`,
    name: 'FM',
    timezone: TZ,
  });
  await addMembership(tdb.db, ctx, {
    level: 'station',
    userId: member.userId,
    stationId: st.id,
    role: 'viewer',
  });
  return unsafeScope(orgScope.orgId, st.id);
}

async function seedLog(scope: StationScope, now: number) {
  const [day] = await tdb.db
    .insert(logDay)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      localDate: '2026-10-23',
      startsAt: new Date(now - 12 * 3_600_000),
      endsAt: new Date(now + 12 * 3_600_000),
      status: 'published',
    })
    .returning();
  if (!day) throw new Error('no day');
  let position = 0;
  const item = async (
    plannedStart: number,
    title: string,
    more: Partial<typeof logItem.$inferInsert> = {},
  ) => {
    const [row] = await tdb.db
      .insert(logItem)
      .values({
        orgId: scope.orgId,
        stationId: scope.stationId,
        logDayId: day.id,
        position: position++,
        kind: 'song',
        plannedStart: new Date(plannedStart),
        plannedDurationMs: 180_000,
        title,
        originType: 'manual',
        ...more,
      })
      .returning({ id: logItem.id });
    if (!row) throw new Error('no item');
    return row.id;
  };
  const a = await item(now - 60_000, 'A');
  await item(now + 120_000, 'B');
  await item(now + 300_000, 'News', {
    timing: 'hard',
    anchorAt: new Date(now + 300_000),
    plannedDurationMs: 60_000,
  });
  await item(now + 360_000, 'C');
  return { a };
}

let seq = 0;
async function airing(scope: StationScope, values: Partial<typeof asRunEntry.$inferInsert>) {
  seq++;
  await tdb.db.insert(asRunEntry).values({
    orgId: scope.orgId,
    stationId: scope.stationId,
    eventId: randomUUID(),
    bootId: 'boot',
    seq,
    source: 'log',
    startedAt: new Date(),
    ...values,
  });
}

async function onAir(scope: StationScope, cookie = member.cookie) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/stations/${scope.stationId}/on-air`,
    headers: cookieHeader(cookie),
  });
}

/** `HH:MM` and the local date of `at` in the station's zone, for a one-off show slot. */
function local(at: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

describe('GET /stations/:stationId/on-air', () => {
  it('returns the item on air on the engine clock and re-estimates the next items', async () => {
    const scope = await newStation();
    const now = Date.now();
    const { a } = await seedLog(scope, now);
    // A went on air 3.25 s late, on the engine's clock.
    const startedAt = new Date(now - 56_750);
    await airing(scope, {
      logItemId: a,
      kind: 'song',
      title: 'A',
      artist: 'Artist',
      startedAt,
      plannedStart: new Date(now - 60_000),
      plannedDurationMs: 180_000,
    });

    const res = await onAir(scope);
    expect(res.statusCode).toBe(200);
    const body: OnAir = onAirSchema.parse(res.json());
    expect(body.mode).toEqual({ kind: 'automation', djName: null });
    expect(body.current).toMatchObject({ title: 'A', artist: 'Artist', durationMs: 180_000 });
    // The engine's start, to the millisecond: the client's elapsed time is computed from it.
    expect(Date.parse(body.current?.startedAt ?? '')).toBe(startedAt.getTime());
    expect(Math.abs(Date.parse(body.at) - Date.now())).toBeLessThan(5_000);

    expect(body.next.map((i) => i.title)).toEqual(['B', 'News', 'C']);
    expect(body.next.map((i) => Date.parse(i.estimatedStart))).toEqual([
      now + 120_000 + 3_250,
      now + 300_000,
      now + 360_000,
    ]);
    expect(body.nextHardEvent).toMatchObject({ kind: 'hard_start', title: 'News' });
    expect(body.show).toBeNull();
  }, 30_000);

  it('shows the DJ on air in live mode', async () => {
    const scope = await newStation();
    const [dj] = await tdb.db
      .insert(streamer)
      .values({
        orgId: scope.orgId,
        stationId: scope.stationId,
        displayName: 'Nova',
        username: 'nova',
        passwordHash: 'x',
      })
      .returning({ id: streamer.id });
    const [session] = await tdb.db
      .insert(liveSession)
      .values({
        orgId: scope.orgId,
        stationId: scope.stationId,
        streamerId: dj?.id,
        input: 1,
        trigger: 'slot',
      })
      .returning({ id: liveSession.id });
    await airing(scope, { source: 'live', liveSessionId: session?.id ?? null, title: 'Live' });

    const body = onAirSchema.parse((await onAir(scope)).json());
    expect(body.mode).toEqual({ kind: 'live', djName: 'Nova' });
    expect(body.current?.source).toBe('live');
  }, 30_000);

  it('reads the live now-playing while a DJ is on air (#68)', async () => {
    const scope = await newStation();
    const [session] = await tdb.db
      .insert(liveSession)
      .values({
        orgId: scope.orgId,
        stationId: scope.stationId,
        input: 1,
        trigger: 'slot',
        title: 'Night Shift',
        episodeNumber: 12,
        streamerName: 'DJ Nova',
      })
      .returning({ id: liveSession.id });
    const sessionId = session?.id ?? '';
    // The as-run keeps the live entry's first tags; the snapshot shows what the streams show.
    await airing(scope, { source: 'live', liveSessionId: sessionId, title: 'First tags' });

    let body = onAirSchema.parse((await onAir(scope)).json());
    expect(body.live).toMatchObject({
      sessionId,
      input: 1,
      title: 'Night Shift #12',
      artist: 'DJ Nova',
      source: 'default',
    });
    expect(body.current).toMatchObject({ title: 'Night Shift #12', artist: 'DJ Nova' });

    await tdb.db.insert(liveNowPlaying).values({
      sessionId,
      orgId: scope.orgId,
      stationId: scope.stationId,
      title: 'Live at the Marché',
      artist: 'Kiosque',
      source: 'manual',
    });
    body = onAirSchema.parse((await onAir(scope)).json());
    expect(body.live).toMatchObject({ title: 'Live at the Marché', source: 'manual' });
    expect(body.current).toMatchObject({ title: 'Live at the Marché', artist: 'Kiosque' });

    // Another station's snapshot never reads it.
    const other = onAirSchema.parse((await onAir(await newStation())).json());
    expect(other.live ?? null).toBeNull();
  }, 30_000);

  it('reports safety mode, and off air when nothing is on air', async () => {
    const scope = await newStation();
    expect(onAirSchema.parse((await onAir(scope)).json()).mode.kind).toBe('off_air');
    await airing(scope, { source: 'safety', title: 'Safe' });
    expect(onAirSchema.parse((await onAir(scope)).json()).mode.kind).toBe('safety');
  }, 30_000);

  it('gives the show block with its episode, and the next show as the next hard event', async () => {
    const scope = await newStation();
    const ctx = { actor: system, scope };
    const now = Date.now();
    const show = await createShow(tdb.db, ctx, {
      name: 'Matinale',
      colour: '#ff8800',
      artworkUrl: 'https://example.test/matinale.png',
    });
    const block = local(now - 30 * 60_000);
    const slot = await createSlot(tdb.db, ctx, show.id, {
      type: 'live',
      rule: { freq: 'once', ...block },
      durationMs: 2 * 3_600_000,
    });
    await createEpisode(tdb.db, ctx, show.id, {
      number: 42,
      slotId: slot.id,
      occurrenceDate: block.date,
    });
    const later = await createShow(tdb.db, ctx, { name: 'Soirée' });
    await createSlot(tdb.db, ctx, later.id, {
      type: 'live',
      rule: { freq: 'once', ...local(now + 3 * 3_600_000) },
      durationMs: 3_600_000,
    });

    const body = onAirSchema.parse((await onAir(scope)).json());
    expect(body.show).toMatchObject({
      name: 'Matinale',
      colour: '#ff8800',
      artworkUrl: 'https://example.test/matinale.png',
      type: 'live',
      episode: { number: 42 },
      rerun: false,
    });
    expect(body.nextHardEvent).toMatchObject({ kind: 'show', title: 'Soirée', showId: later.id });
  }, 30_000);

  it("refuses a station the user isn't a member of, and keeps stations apart", async () => {
    const scope = await newStation();
    await airing(scope, { source: 'safety', title: 'Theirs' });
    expect((await onAir(scope, outsider.cookie)).statusCode).toBe(404);
    const other = await newStation();
    expect(onAirSchema.parse((await onAir(other)).json()).current).toBeNull();
  }, 30_000);
});
