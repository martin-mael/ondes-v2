import { randomUUID } from 'node:crypto';
import {
  addMembership,
  alert,
  asset,
  auditLog,
  category,
  categoryMember,
  clock,
  clockGrid,
  clockSlot,
  createOrganization,
  createStation,
  loadGeneratorSnapshot,
  logDay,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
  writeGeneratedDay,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import {
  connectQueue,
  createEventPublisher,
  deleteTopology,
  type JobPublisher,
  type QueueConnection,
  subscribeEvents,
} from '@ondes/queue';
import { generateDays, regenPolicy } from '@ondes/scheduling';
import {
  type Actor,
  addDays,
  type JobEnvelope,
  type LocalDate,
  type LogRegenPreviewResponse,
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
import { createRegenAlerts } from './regen-alerts.ts';
import { SCHEDULE_ROUTES } from './regen-plugin.ts';

// Regeneration on the real app (#101, ADR 0030): horizon settings, the dry-run and its diff,
// applying (queued jobs, audit, stale previews), the `schedule.changed` hook and the
// generation alerts.

const system: Actor = { type: 'system', name: 'test' };
const rabbitUrl = process.env.RABBITMQ_URL ?? 'amqp://ondes:ondes@127.0.0.1:5672/ondes';
const TZ = 'Europe/Paris';
const HOUR = 3_600_000;

let t: TestApp;
let tdb: TestDatabase;
let queue: QueueConnection;
let closeRabbit: () => Promise<void>;
const events: RealtimeEvent[] = [];
const enqueued: { name: string; payload: unknown }[] = [];

let scope: StationScope;
let stationId: string;
let musicId: string;
const songIds: string[] = [];
const cookies: Record<'programmer' | 'viewer', string> = { programmer: '', viewer: '' };
let today: LocalDate;
let tomorrow: LocalDate;

beforeAll(async () => {
  queue = await connectQueue(rabbitUrl, { prefix: `test-${randomUUID().slice(0, 8)}` });
  const publisher = createEventPublisher(queue.rabbit, queue.topology, z.unknown());
  // Jobs are recorded, not run: the worker's side has its own tests.
  const jobs: JobPublisher = {
    async enqueue(job, payload) {
      enqueued.push({ name: job.name, payload: job.schema.parse(payload) });
      return {} as JobEnvelope;
    },
    close: async () => {},
  };
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
    await publisher.close();
    await deleteTopology(queue.rabbit, queue.topology);
    await queue.close();
  };

  tdb = await createTestDatabase();
  const mailer = createMemoryMailer();
  const app = await buildApp({
    db: { client: tdb },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    rabbit: { rabbit },
    regen: { sweepIntervalMs: 0 },
    alerts: { sweepIntervalMs: 0 },
    episodeCheck: { intervalMs: 0 },
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
  const org = await createOrganization(db, system, { slug: 'regen-org', name: 'Org' });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: 'regen-fm', name: 'FM', timezone: TZ },
  );
  stationId = st.id;
  scope = await resolveStationScope(db, org.id, st.id);
  const base = { orgId: scope.orgId, stationId };
  const songs = await db
    .insert(asset)
    .values(
      Array.from({ length: 120 }, (_, i) => ({
        ...base,
        type: 'song' as const,
        title: `Song ${i}`,
        artists: [`Artist ${i % 40}`],
        durationMs: 180_000 + (i % 7) * 15_000,
      })),
    )
    .returning({ id: asset.id });
  songIds.push(...songs.map((s) => s.id));
  const [music] = await db
    .insert(category)
    .values({ ...base, name: 'Music', assetType: 'song', restMinutes: 120 })
    .returning({ id: category.id });
  if (!music) throw new Error('no category');
  musicId = music.id;
  await db
    .insert(categoryMember)
    .values(
      songIds.map((assetId) => ({
        ...base,
        categoryId: musicId,
        assetId,
        mode: 'include' as const,
      })),
    );
  const [c] = await db
    .insert(clock)
    .values({ ...base, name: 'Hour', targetDurationMs: HOUR })
    .returning({ id: clock.id });
  if (!c) throw new Error('no clock');
  await db.insert(clockSlot).values(
    Array.from({ length: 16 }, (_, i) => ({
      ...base,
      clockId: c.id,
      position: i,
      kind: 'category' as const,
      categoryId: musicId,
    })),
  );
  await db.insert(clockGrid).values({ ...base, defaultClockId: c.id, version: 1 });

  for (const role of ['programmer', 'viewer'] as const) {
    const { userId, cookie } = await signUpAndLogin(t, `${role}@regen.test`);
    await addMembership(
      db,
      { actor: system, scope: orgScope },
      { level: 'station', stationId, userId, role },
    );
    cookies[role] = cookie;
  }

  today = localDateOf(new Date(), TZ);
  tomorrow = addDays(today, 1);
  // Tomorrow and the day after, as the worker would have generated them.
  const dates = [tomorrow, addDays(tomorrow, 1)];
  const now = new Date();
  const keep = regenPolicy(now);
  const loaded = await loadGeneratorSnapshot(db, scope, { dates, now, mode: 'regenerate', keep });
  if (!loaded) throw new Error('no snapshot');
  for (const day of generateDays(loaded.snapshot, dates)) {
    await writeGeneratedDay(db, { actor: system, scope }, day, { keep });
  }
}, 60_000);

afterAll(async () => {
  await t?.close();
  await closeRabbit?.();
});

function call(
  who: keyof typeof cookies,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  payload?: object,
) {
  return t.app.inject({
    method,
    url: `/api/v1/stations/${stationId}${url}`,
    cookies: { ondes_session: cookies[who] },
    ...(payload ? { payload } : {}),
  });
}

const dayOf = async (localDate: LocalDate) =>
  (
    await tdb.db
      .select()
      .from(logDay)
      .where(and(eq(logDay.stationId, stationId), eq(logDay.localDate, localDate)))
  )[0];

const audits = async (action: string) =>
  (await tdb.db.select().from(auditLog)).filter(
    (a) => a.action === action && a.stationId === stationId,
  );

describe('horizon settings', () => {
  it('reads the defaults, saves with an audit row, refuses viewers', async () => {
    const res = await call('viewer', 'GET', '/log/regen/settings');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ horizonDays: 14, newDayStatus: 'draft' });
    expect(
      (
        await call('viewer', 'PUT', '/log/regen/settings', {
          horizonDays: 7,
          newDayStatus: 'draft',
        })
      ).statusCode,
    ).toBe(403);
    const put = await call('programmer', 'PUT', '/log/regen/settings', {
      horizonDays: 7,
      newDayStatus: 'published',
    });
    expect(put.statusCode).toBe(200);
    expect((await call('viewer', 'GET', '/log/regen/settings')).json()).toEqual({
      horizonDays: 7,
      newDayStatus: 'published',
    });
    expect(await audits('log_regen_setting.update')).toHaveLength(1);
    expect(
      (
        await call('programmer', 'PUT', '/log/regen/settings', {
          horizonDays: 99,
          newDayStatus: 'draft',
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('dry-run', () => {
  it('finds nothing to change when nothing changed', async () => {
    const res = await call('programmer', 'POST', '/log/regen/preview', {
      from: tomorrow,
      to: addDays(tomorrow, 1),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LogRegenPreviewResponse;
    expect(body.days.map((d) => d.change)).toEqual(['unchanged', 'unchanged']);
    expect(body.totals).toMatchObject({ added: 0, removed: 0, moved: 0 });
    expect(body.days[0]?.items.length).toBeGreaterThan(300);
  });

  it('diffs a schedule change against the current log, and writes nothing', async () => {
    const before = await dayOf(tomorrow);
    await tdb.sql`delete from category_member where category_id = ${musicId}
      and asset_id = any(${songIds.slice(0, 60)})`;
    const res = await call('programmer', 'POST', '/log/regen/preview', {
      from: tomorrow,
      to: tomorrow,
    });
    expect(res.statusCode).toBe(200);
    const [day] = (res.json() as LogRegenPreviewResponse).days;
    expect(day?.change).toBe('changed');
    expect(day?.logDayId).toBe(before?.id);
    expect(day?.version).toBe(before?.version);
    expect(day?.removed.length).toBeGreaterThan(0);
    expect(day?.added.length).toBeGreaterThan(0);
    const gone = new Set(songIds.slice(0, 60));
    expect(day?.removed.every((i) => i.id !== null)).toBe(true);
    expect(day?.added.every((i) => i.id === null && !gone.has(i.assetId as string))).toBe(true);
    expect(day?.added[0]?.asset).toMatchObject({ type: 'song', title: expect.any(String) });
    const after = await dayOf(tomorrow);
    expect(after?.version).toBe(before?.version);
  });

  it('refuses past days and ranges over a week; viewers may not run it', async () => {
    const past = await call('programmer', 'POST', '/log/regen/preview', {
      from: addDays(today, -1),
      to: today,
    });
    expect(past.statusCode).toBe(422);
    expect(past.json()).toMatchObject({ error: 'log_regen_past' });
    const long = await call('programmer', 'POST', '/log/regen/preview', {
      from: tomorrow,
      to: addDays(tomorrow, 7),
    });
    expect(long.statusCode).toBe(400);
    expect(
      (await call('viewer', 'POST', '/log/regen/preview', { from: tomorrow, to: tomorrow }))
        .statusCode,
    ).toBe(403);
  });
});

describe('apply', () => {
  it('queues the jobs (14 days each) with the station settings, audited', async () => {
    enqueued.length = 0;
    const res = await call('programmer', 'POST', '/log/regen', {
      from: tomorrow,
      to: addDays(tomorrow, 15),
      seed: 'fresh',
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ jobs: 2 });
    expect(enqueued.map((j) => j.name)).toEqual(['log-generate', 'log-generate']);
    expect(enqueued[0]?.payload).toMatchObject({
      orgId: scope.orgId,
      stationId,
      seed: 'fresh',
      status: 'published',
    });
    expect((enqueued[0]?.payload as { localDates: string[] }).localDates).toHaveLength(14);
    expect((enqueued[1]?.payload as { localDates: string[] }).localDates).toHaveLength(2);
    expect(await audits('log_day.regenerate')).toHaveLength(1);
  });

  it('refuses a preview gone stale (409), nothing queued', async () => {
    enqueued.length = 0;
    const day = await dayOf(tomorrow);
    const res = await call('programmer', 'POST', '/log/regen', {
      from: tomorrow,
      to: addDays(tomorrow, 2),
      expectedVersions: {
        [tomorrow]: (day?.version ?? 0) + 1,
        [addDays(tomorrow, 2)]: null,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'log_regen_stale',
      details: { localDates: [tomorrow] },
    });
    expect(enqueued).toEqual([]);
    const ok = await call('programmer', 'POST', '/log/regen', {
      from: tomorrow,
      to: tomorrow,
      expectedVersions: { [tomorrow]: day?.version ?? 0 },
    });
    expect(ok.statusCode).toBe(202);
  });
});

describe('schedule changes', () => {
  it('watches routes that exist (a renamed route would silently stop regenerating)', () => {
    for (const url of Object.keys(SCHEDULE_ROUTES)) {
      const methods = (['POST', 'PUT', 'PATCH', 'DELETE'] as const).filter((method) =>
        t.app.hasRoute({ method, url }),
      );
      expect(methods, url).not.toEqual([]);
    }
  });

  it('publishes schedule.changed after a successful schedule mutation, not after a failed one', async () => {
    const ok = await call('programmer', 'PATCH', `/categories/${musicId}`, { name: 'Music 2' });
    expect(ok.statusCode).toBe(200);
    const bad = await call('programmer', 'PATCH', `/categories/${musicId}`, {});
    expect(bad.statusCode).toBe(400);
    await expect
      .poll(() => events.filter((e) => e.type === 'schedule.changed'), { timeout: 5_000 })
      .toHaveLength(1);
    expect(events.find((e) => e.type === 'schedule.changed')).toMatchObject({
      stationId,
      data: { orgId: scope.orgId, areas: ['categories'], from: null },
    });
  });
});

describe('generation alerts', () => {
  it('raises one alert per day with issues, and resolves it when a regeneration has none', async () => {
    const regenAlerts = createRegenAlerts({ db: tdb.db, alerts: t.app.alerts, logger: t.app.log });
    const day = await dayOf(tomorrow);
    const event = (counts: Record<string, number>, issues: object[]): RealtimeEvent =>
      realtimeEventSchema.parse({
        id: randomUUID(),
        stationId,
        at: new Date().toISOString(),
        type: 'log.generated',
        data: {
          orgId: scope.orgId,
          days: [
            {
              logDayId: day?.id,
              localDate: tomorrow,
              version: day?.version ?? 1,
              changed: true,
              issueCounts: counts,
              issues,
            },
          ],
        },
      });
    const at = new Date().toISOString();
    await regenAlerts.handle(
      event({ no_clock: 2, episode_missing: 1 }, [
        { code: 'no_clock', at },
        { code: 'no_clock', at },
        { code: 'episode_missing', at },
      ]),
    );
    const open = async () =>
      (await tdb.db.select().from(alert)).filter(
        (a) =>
          a.stationId === stationId && a.type === 'log.generation_issues' && a.resolvedAt === null,
      );
    const [raised] = await open();
    expect(raised).toMatchObject({
      severity: 'warning',
      dedupeKey: `log.generation_issues:${tomorrow}`,
      details: {
        localDate: tomorrow,
        counts: { no_clock: 2 },
        i18n: { key: 'logRegen.issues', params: { localDate: tomorrow, total: 2 } },
      },
    });
    // Only missing episodes left: those are #47's alerts, so this one resolves.
    await regenAlerts.handle(event({ episode_missing: 1 }, [{ code: 'episode_missing', at }]));
    expect(await open()).toEqual([]);
  });
});
