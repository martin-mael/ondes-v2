import { randomUUID } from 'node:crypto';
import {
  addMembership,
  asRunEntry,
  createOrganization,
  createStation,
  logDay,
  logItem,
  type OrgScope,
  type StationScope,
  unsafeScope,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import type { Actor, AsRunOverlay } from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { createMemoryMailer } from '../../plugins/mail.ts';
import { cookieHeader, signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../auth/testing.ts';
import { getAsRunOverlay } from './overlay-routes.ts';

// Log vs as-run (#53): the overlay endpoint on a real database: the station-local day, entries
// that aired after midnight for the day's last item, permissions and tenant isolation.
// Needs `pnpm dev:up` (Postgres).

const system: Actor = { type: 'system', name: 'test' };

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
  const org = await createOrganization(tdb.db, system, { slug: 'overlay', name: 'Overlay' });
  orgScope = unsafeScope(org.id);
  const t = { app, tdb, outbox: mailer.outbox } as unknown as TestApp;
  member = await signUpAndLogin(t, 'member@overlay.test');
  outsider = await signUpAndLogin(t, 'outsider@overlay.test');
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
    slug: `overlay-${stations}`,
    name: 'FM',
    timezone: 'Europe/Paris',
  });
  await addMembership(tdb.db, ctx, {
    level: 'station',
    userId: member.userId,
    stationId: st.id,
    role: 'viewer',
  });
  return unsafeScope(orgScope.orgId, st.id);
}

// 2025-10-26, the last Sunday of October: 25 hours in Europe/Paris, from 22:00 UTC the day before.
const DATE = '2025-10-26';
const DAY_START = new Date('2025-10-25T22:00:00Z');
const DAY_END = new Date('2025-10-26T23:00:00Z');

async function seedDay(scope: StationScope) {
  const [day] = await tdb.db
    .insert(logDay)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      localDate: DATE,
      startsAt: DAY_START,
      endsAt: DAY_END,
      status: 'published',
    })
    .returning();
  if (!day) throw new Error('no day');
  const item = async (position: number, plannedStart: Date, title: string) => {
    const [row] = await tdb.db
      .insert(logItem)
      .values({
        orgId: scope.orgId,
        stationId: scope.stationId,
        logDayId: day.id,
        position,
        kind: 'song',
        plannedStart,
        plannedDurationMs: 180_000,
        title,
        originType: 'manual',
      })
      .returning({ id: logItem.id });
    if (!row) throw new Error('no item');
    return row.id;
  };
  // 02:30 local, the second time (UTC+1), and the day's last item at 23:59 local.
  const aired = await item(0, new Date('2025-10-26T01:30:00Z'), 'Aired');
  const missed = await item(1, new Date('2025-10-26T10:00:00Z'), 'Missed');
  const late = await item(2, new Date('2025-10-26T22:59:00Z'), 'Late');
  let seq = 0;
  const entry = async (startedAt: Date, more: Partial<typeof asRunEntry.$inferInsert> = {}) => {
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
        startedAt,
        endedAt: new Date(startedAt.getTime() + 180_000),
        durationMs: 180_000,
        outcome: 'complete',
        ...more,
      })
      .returning({ id: asRunEntry.id });
    return row?.id as string;
  };
  await entry(new Date('2025-10-26T01:30:03Z'), {
    logItemId: aired,
    plannedStart: new Date('2025-10-26T01:30:00Z'),
  });
  const safety = await entry(new Date('2025-10-26T09:59:00Z'), { source: 'safety' });
  // Past midnight, still the day's last item.
  await entry(new Date('2025-10-26T23:01:00Z'), { logItemId: late });
  // The next day's off-plan audio stays out.
  await entry(new Date('2025-10-26T23:30:00Z'), { source: 'safety' });
  return { aired, missed, late, safety };
}

describe('GET …/asrun/overlay', () => {
  it('lays the as-run over the station-local day, with the right statuses', async () => {
    const scope = await newStation();
    const ids = await seedDay(scope);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/stations/${scope.stationId}/asrun/overlay?date=${DATE}`,
      headers: cookieHeader(member.cookie),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AsRunOverlay;
    expect(body.from).toBe(DAY_START.toISOString());
    expect(body.to).toBe(DAY_END.toISOString());
    expect(body.rows.map((r) => [r.status, r.plan?.logItemId ?? null])).toEqual([
      ['aired', ids.aired],
      ['safety', null],
      ['replaced', ids.missed],
      ['aired', ids.late],
    ]);
    expect(body.rows[0]?.entry?.driftMs).toBe(3000);
    expect(body.rows[2]?.replacedBy).toEqual([ids.safety]);
  });

  it('marks what has not aired yet as pending against the api clock', async () => {
    const scope = await newStation();
    await seedDay(scope);
    const overlay = await getAsRunOverlay(
      tdb.db,
      scope,
      { date: DATE },
      new Date('2025-10-26T05:00:00Z'),
    );
    expect(overlay.rows.find((r) => r.plan?.title === 'Missed')?.status).toBe('pending');
  });

  it('is scoped to the station', async () => {
    const scope = await newStation();
    const other = await newStation();
    await seedDay(other);
    const overlay = await getAsRunOverlay(tdb.db, scope, { date: DATE });
    expect(overlay.rows).toEqual([]);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/stations/${scope.stationId}/asrun/overlay?date=${DATE}`,
      headers: cookieHeader(outsider.cookie),
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('refuses a bad date', async () => {
    const scope = await newStation();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/stations/${scope.stationId}/asrun/overlay?date=yesterday`,
      headers: cookieHeader(member.cookie),
    });
    expect(res.statusCode).toBe(400);
  });
});
