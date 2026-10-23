import { createHash, randomUUID } from 'node:crypto';
import {
  addMembership,
  asRunEntry,
  asset,
  auditLog,
  createAsset,
  createOrganization,
  createStation,
  promoPlacement,
  putAssetFile,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
  segue,
  updateCues,
} from '@ondes/db';
import { createTestDatabase } from '@ondes/db/testing';
import type { JobPublisher } from '@ondes/queue';
import {
  type Actor,
  addDays,
  type LogEditResult,
  localDateOf,
  type Promo,
  type PromoList,
  type PromoPlays,
  type RealtimeEvent,
  realtimeEventSchema,
  type StationRole,
  type VtPool,
  type VtPoolList,
} from '@ondes/shared';
import { contentKey } from '@ondes/storage';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { createMemoryMailer } from '../../plugins/mail.ts';
import { signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../auth/testing.ts';
import { createPromoEventHandler } from './plugin.ts';

// The promos API on the real app (#60): VT pools and promos (validity on the asset, audit,
// permissions, tenancy), the consumer that turns the generator's placements into default
// segues, the re-check that drops a placement whose promo can't air any more (and deletes its
// segue), and play counts from the as-run.

const system: Actor = { type: 'system', name: 'test' };
const SR = 44_100;
const sec = (n: number) => Math.round(n * SR);
const DATE = '2026-11-02';

let t: TestApp;
let scope: StationScope;
let stationId: string;
let otherScope: StationScope;
let otherStationId: string;
const users: Record<string, { userId: string; cookie: string }> = {};
type Who = 'programmer' | 'presenter' | 'outsider';
let handle: ReturnType<typeof createPromoEventHandler>;
let logDayId: string;

const published: RealtimeEvent[] = [];
const sink = {
  publish: async (event: RealtimeEvent) => {
    published.push(realtimeEventSchema.parse(JSON.parse(JSON.stringify(event))));
  },
};
const enqueued: string[] = [];
const jobs = {
  enqueue: async (job: { name: string }) => {
    enqueued.push(job.name);
  },
  close: async () => {},
} as unknown as JobPublisher;

function call(
  who: Who,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  station = stationId,
) {
  return t.app.inject({
    method,
    url: `/api/v1/stations/${station}${url}`,
    cookies: { ondes_session: users[who]?.cookie ?? '' },
    ...(payload ? { payload } : {}),
  });
}

async function ok<T>(res: Awaited<ReturnType<typeof call>>, status = 200): Promise<T> {
  expect(res.statusCode, res.body).toBe(status);
  return (res.body ? res.json() : undefined) as T;
}

async function newAsset(s: StationScope, name: string, seconds: number, type: 'song' | 'vt') {
  const a = await createAsset(t.tdb.db, { actor: system, scope: s }, { type, title: name });
  const sha256 = createHash('sha256').update(`${s.stationId}:${name}`).digest('hex');
  await putAssetFile(t.tdb.db, { actor: system, scope: s }, a.id, {
    role: 'playout',
    storageKey: contentKey({ orgId: s.orgId, sha256, ext: 'flac' }),
    sha256,
    sizeBytes: 1000,
    codec: 'flac',
    sampleRate: SR,
    channels: 2,
    bitDepth: 24,
    flacBlockSize: 1024,
    durationSamples: sec(seconds),
  });
  return a.id;
}

async function addSong(assetId: string) {
  const res = await ok<LogEditResult>(
    await call('programmer', 'POST', '/log/items', {
      placement: { localDate: DATE },
      item: { kind: 'song', assetId, plannedDurationMs: 180_000 },
    }),
    201,
  );
  if (!res.item) throw new Error('no item');
  logDayId = res.item.logDayId;
  return res.item;
}

const logUpdated = () =>
  handle({
    id: randomUUID(),
    stationId,
    at: new Date().toISOString(),
    type: 'log.updated',
    data: {
      from: '',
      to: '',
      days: [{ logDayId, localDate: DATE, version: 1 }],
      cause: 'generate',
    },
  } as unknown as RealtimeEvent);

async function placement(
  promoId: string,
  assetId: string,
  poolId: string,
  a: { id: string; plannedStart: string; plannedDurationMs: number },
  b: { id: string },
) {
  const [row] = await t.tdb.db
    .insert(promoPlacement)
    .values({
      orgId: scope.orgId,
      stationId,
      promoId,
      assetId,
      poolId,
      logDayId,
      localDate: DATE,
      fromItemId: a.id,
      toItemId: b.id,
      plannedAt: new Date(Date.parse(a.plannedStart) + a.plannedDurationMs),
    })
    .returning();
  if (!row) throw new Error('no placement');
  return row;
}

const placementRow = async (id: string) =>
  (await t.tdb.db.select().from(promoPlacement).where(eq(promoPlacement.id, id)))[0];

const audits = (entityId: string) =>
  t.tdb.db.select().from(auditLog).where(eq(auditLog.entityId, entityId)).orderBy(asc(auditLog.at));

beforeAll(async () => {
  const tdb = await createTestDatabase();
  const mailer = createMemoryMailer();
  const app = await buildApp({
    db: { client: tdb },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    fastify: { logger: false },
    promos: { events: sink, jobs },
    segues: { events: sink, jobs },
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
  handle = createPromoEventHandler({ db, events: sink, jobs, logger: app.log });
  const org = await createOrganization(db, system, { slug: 'promos-org', name: 'Org' });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: 'promos-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  stationId = st.id;
  scope = await resolveStationScope(db, org.id, st.id);
  const other = await createOrganization(db, system, { slug: 'promos-other', name: 'Other' });
  const otherOrg = await resolveOrgScope(db, other.id);
  const ost = await createStation(
    db,
    { actor: system, scope: otherOrg },
    { slug: 'promos-other-fm', name: 'Other', timezone: 'Europe/Paris' },
  );
  otherStationId = ost.id;
  otherScope = await resolveStationScope(db, other.id, ost.id);
  const roles: [Who, StationRole][] = [
    ['programmer', 'programmer'],
    ['presenter', 'presenter'],
  ];
  for (const [who, role] of roles) {
    users[who] = await signUpAndLogin(t, `${who}@promos.test`);
    await addMembership(
      db,
      { actor: system, scope: orgScope },
      { level: 'station', stationId, userId: users[who].userId, role },
    );
  }
  users.outsider = await signUpAndLogin(t, 'outsider@promos.test');
}, 60_000);

afterAll(() => t?.close());

describe('VT pools', () => {
  it('creates, renames and deletes, audited, names unique per station', async () => {
    const pool = await ok<VtPool>(
      await call('programmer', 'POST', '/vt-pools', { name: 'Weekend events' }),
      201,
    );
    expect(pool).toMatchObject({ name: 'Weekend events', promoCount: 0, activeCount: 0 });
    expect(
      (await call('programmer', 'POST', '/vt-pools', { name: 'weekend EVENTS' })).statusCode,
    ).toBe(409);
    const renamed = await ok<VtPool>(
      await call('programmer', 'PATCH', `/vt-pools/${pool.id}`, { color: '#aa3300' }),
    );
    expect(renamed.color).toBe('#aa3300');
    await ok(await call('programmer', 'DELETE', `/vt-pools/${pool.id}`), 204);
    expect((await audits(pool.id)).map((a) => a.action)).toEqual([
      'vt_pool.create',
      'vt_pool.update',
      'vt_pool.delete',
    ]);
  });

  it('needs voice_track:write to edit, voice_track:read to list, and stays in its station', async () => {
    expect((await call('presenter', 'POST', '/vt-pools', { name: 'Nope' })).statusCode).toBe(403);
    expect((await call('presenter', 'GET', '/vt-pools')).statusCode).toBe(200);
    // Not a member: the station doesn't exist for them.
    expect((await call('outsider', 'GET', '/vt-pools')).statusCode).toBe(404);
    const pool = await ok<VtPool>(
      await call('programmer', 'POST', '/vt-pools', { name: 'Mine' }),
      201,
    );
    const others = await ok<VtPoolList>(await call('programmer', 'GET', '/vt-pools'));
    expect(others.items.map((p) => p.id)).toContain(pool.id);
    // Another station's id: not found from here.
    expect(
      (await call('programmer', 'PATCH', `/vt-pools/${randomUUID()}`, { name: 'x' })).statusCode,
    ).toBe(404);
  });
});

describe('promos', () => {
  let poolId: string;
  let promoId: string;
  let voiceId: string;

  it('makes a vt asset a promo, its validity written to the asset', async () => {
    poolId = (
      await ok<VtPool>(await call('programmer', 'POST', '/vt-pools', { name: 'Concerts' }), 201)
    ).id;
    voiceId = await newAsset(scope, 'Promo concert', 20, 'vt');
    const songId = await newAsset(scope, 'A song', 180, 'song');
    expect((await call('programmer', 'POST', '/promos', { assetId: songId })).statusCode).toBe(422);
    const otherVoice = await newAsset(otherScope, 'Elsewhere', 20, 'vt');
    expect((await call('programmer', 'POST', '/promos', { assetId: otherVoice })).statusCode).toBe(
      422,
    );
    const created = await ok<Promo>(
      await call('programmer', 'POST', '/promos', {
        assetId: voiceId,
        poolIds: [poolId],
        weight: 3,
        maxPlaysPerDay: 4,
        eventName: 'Concert',
        dayparts: [{ weekdays: [1, 2, 3, 4, 5], startHour: 6, endHour: 20 }],
        startAt: '2026-10-01T00:00:00Z',
        killAt: '2026-12-01T00:00:00Z',
      }),
      201,
    );
    promoId = created.id;
    expect(created).toMatchObject({
      title: 'Promo concert',
      status: 'active',
      weight: 3,
      maxPlaysPerDay: 4,
      poolIds: [poolId],
      version: 1,
      plays: { airedTotal: 0, planned: 0 },
    });
    const [row] = await t.tdb.db.select().from(asset).where(eq(asset.id, voiceId));
    expect(row?.killAt?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect((await call('programmer', 'POST', '/promos', { assetId: voiceId })).statusCode).toBe(
      409,
    );
    expect((await audits(promoId)).map((a) => a.action)).toEqual(['promo.create']);
    expect((await audits(voiceId)).map((a) => a.action)).toContain('asset.update');
    const pools = await ok<VtPoolList>(await call('programmer', 'GET', '/vt-pools'));
    expect(pools.items.find((p) => p.id === poolId)).toMatchObject({
      promoCount: 1,
      activeCount: 1,
    });
    // Not visible from another station.
    expect(
      (await call('programmer', 'GET', `/promos/${promoId}`, undefined, otherStationId)).statusCode,
    ).toBe(404);
  });

  it('refuses a stale version and an unknown pool', async () => {
    expect(
      (await call('programmer', 'PATCH', `/promos/${promoId}`, { weight: 2, version: 9 }))
        .statusCode,
    ).toBe(409);
    expect(
      (await call('programmer', 'PATCH', `/promos/${promoId}`, { poolIds: [randomUUID()] }))
        .statusCode,
    ).toBe(422);
  });

  it('turns a placement into a default segue over the transition', async () => {
    const songA = await newAsset(scope, 'Song A', 180, 'song');
    const songB = await newAsset(scope, 'Song B', 180, 'song');
    // A's outro: the last 10 s; B's intro: 6 s.
    await updateCues(t.tdb.db, { actor: system, scope }, songA, {
      sampleRate: SR,
      outroStart: { samples: sec(170) },
    });
    await updateCues(t.tdb.db, { actor: system, scope }, songB, {
      sampleRate: SR,
      introEnd: { samples: sec(6) },
    });
    const a = await addSong(songA);
    const b = await addSong(songB);
    const p = await placement(promoId, voiceId, poolId, a, b);
    const result = await logUpdated();
    expect(result).toMatchObject({ placed: 1, dropped: 0 });
    const placed = await placementRow(p.id);
    expect(placed?.status).toBe('placed');
    const [s] = await t.tdb.db
      .select()
      .from(segue)
      .where(eq(segue.id, placed?.segueId ?? ''));
    expect(s).toMatchObject({ fromItemId: a.id, toItemId: b.id, origin: 'auto' });
    expect(s?.voices).toEqual([{ assetId: voiceId, start: -sec(10), gainDb: 0, envelope: [] }]);
    // Voice 20 s from −10 s ends at +10 s; B's 6 s intro ends with it: B starts at +4 s.
    expect(s?.inLane.start).toBe(sec(4));
    expect(s?.outLane.envelope.at(-1)).toEqual({ at: -sec(10), gainDb: -8 });
    expect((await audits(s?.id ?? '')).map((x) => x.action)).toEqual(['segue.create']);
    expect((await audits(p.id)).map((x) => x.action)).toEqual(['promo_placement.update']);
    expect(published.some((e) => e.type === 'segue.changed')).toBe(true);
    // Again: nothing to do.
    expect(await logUpdated()).toMatchObject({ placed: 0, dropped: 0 });

    const promo = await ok<Promo>(await call('programmer', 'GET', `/promos/${promoId}`));
    expect(promo.plays.planned).toBe(1);
  });

  it('drops a placement whose promo expired and deletes its generated segue', async () => {
    const [p] = await t.tdb.db
      .select()
      .from(promoPlacement)
      .where(and(eq(promoPlacement.promoId, promoId), eq(promoPlacement.status, 'placed')));
    if (!p?.segueId) throw new Error('no placed placement');
    const before = await ok<Promo>(await call('programmer', 'GET', `/promos/${promoId}`));
    const updated = await ok<Promo>(
      await call('programmer', 'PATCH', `/promos/${promoId}`, {
        killAt: '2026-11-01T00:00:00Z',
        version: before.version,
      }),
    );
    // Still active today; past its kill date by the placement's day (2026-11-02).
    expect(updated.status).toBe('active');
    expect(updated.plays.planned).toBe(0);
    const dropped = await placementRow(p.id);
    expect(dropped).toMatchObject({ status: 'dropped', segueId: null });
    expect(dropped?.detail).toMatch(/kill/);
    expect(await t.tdb.db.select().from(segue).where(eq(segue.id, p.segueId))).toEqual([]);
    expect((await audits(p.segueId)).map((x) => x.action)).toEqual([
      'segue.create',
      'segue.delete',
    ]);
  });

  it('keeps a segue a person saved, even after its placement is dropped', async () => {
    await ok(
      await call('programmer', 'PATCH', `/promos/${promoId}`, { killAt: '2026-12-01T00:00:00Z' }),
    );
    const a = await addSong(await newAsset(scope, 'Song C', 180, 'song'));
    const b = await addSong(await newAsset(scope, 'Song D', 180, 'song'));
    const p = await placement(promoId, voiceId, poolId, a, b);
    await logUpdated();
    const placed = await placementRow(p.id);
    await t.tdb.db
      .update(segue)
      .set({ origin: 'manual' })
      .where(eq(segue.id, placed?.segueId ?? ''));
    await ok(await call('programmer', 'PATCH', `/promos/${promoId}`, { enabled: false }));
    expect((await placementRow(p.id))?.status).toBe('dropped');
    expect(
      await t.tdb.db
        .select()
        .from(segue)
        .where(eq(segue.id, placed?.segueId ?? '')),
    ).toHaveLength(1);
    await ok(await call('programmer', 'PATCH', `/promos/${promoId}`, { enabled: true }));
  });

  it('counts aired plays from the as-run: vt items and transition voices', async () => {
    const now = new Date();
    const entry = async (startedAt: Date, more: Partial<typeof asRunEntry.$inferInsert>) => {
      await t.tdb.db.insert(asRunEntry).values({
        orgId: scope.orgId,
        stationId,
        eventId: randomUUID(),
        bootId: 'boot',
        seq: Math.floor(Math.random() * 1e9),
        source: 'log',
        startedAt,
        endedAt: new Date(startedAt.getTime() + 180_000),
        durationMs: 180_000,
        outcome: 'complete',
        ...more,
      });
    };
    const voices = (offsetMs: number) => ({
      rendered: true,
      islandId: null,
      hash: 'h',
      segueIds: [],
      voices: [{ assetId: voiceId, title: 'Promo concert', offsetMs, durationMs: 20_000 }],
    });
    await entry(new Date(now.getTime() - 60_000), { kind: 'vt', assetId: voiceId });
    await entry(new Date(now.getTime() - 3 * 86_400_000), {
      kind: 'song',
      transition: voices(170_000),
    });
    // The entry left the air before the voice started: not a play.
    await entry(new Date(now.getTime() - 3 * 86_400_000), {
      kind: 'song',
      transition: voices(190_000),
    });
    await entry(new Date(now.getTime() - 30 * 86_400_000), {
      kind: 'song',
      transition: voices(1000),
    });
    const promo = await ok<Promo>(await call('programmer', 'GET', `/promos/${promoId}`));
    expect(promo.plays).toMatchObject({ airedToday: 1, aired7d: 2, airedTotal: 3 });
    expect(promo.plays.lastAiredAt).not.toBeNull();
    // From 10 days ago (the 30-day-old play is out) to past the placements' day.
    const today = localDateOf(now, 'Europe/Paris');
    const from = addDays(today, -10);
    const to = [addDays(DATE, 1), addDays(today, 1)].sort().at(-1);
    const plays = await ok<PromoPlays>(
      await call('presenter', 'GET', `/promos/${promoId}/plays?from=${from}&to=${to}`),
    );
    expect(plays.items.filter((i) => i.kind === 'aired')).toHaveLength(2);
    expect(plays.airedByDay.reduce((n, d) => n + d.count, 0)).toBe(2);
    expect(plays.items.some((i) => i.kind === 'planned' && i.placementStatus === 'dropped')).toBe(
      true,
    );
    const list = await ok<PromoList>(await call('programmer', 'GET', `/promos?poolId=${poolId}`));
    expect(list.items.map((i) => i.id)).toEqual([promoId]);
  });

  it('deleting a promo retires its coming placements and their generated segues', async () => {
    const a = await addSong(await newAsset(scope, 'Song E', 180, 'song'));
    const b = await addSong(await newAsset(scope, 'Song F', 180, 'song'));
    const p = await placement(promoId, voiceId, poolId, a, b);
    await logUpdated();
    const segueId = (await placementRow(p.id))?.segueId;
    expect(segueId).toBeTruthy();
    await ok(await call('programmer', 'DELETE', `/promos/${promoId}`), 204);
    expect(
      await t.tdb.db
        .select()
        .from(segue)
        .where(eq(segue.id, segueId ?? '')),
    ).toEqual([]);
    expect((await call('programmer', 'GET', `/promos/${promoId}`)).statusCode).toBe(404);
    expect((await audits(promoId)).map((x) => x.action).at(-1)).toBe('promo.delete');
    // The asset stays in the library.
    expect(await t.tdb.db.select().from(asset).where(eq(asset.id, voiceId))).toHaveLength(1);
  });
});
