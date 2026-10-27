import {
  asset,
  auditLog,
  category,
  categoryMember,
  clock,
  clockGrid,
  clockSlot,
  createOrganization,
  createStation,
  logDay,
  logItem,
  promo,
  promoPlacement,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
  segue,
  vtPool,
  vtPoolMember,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import { type Actor, type LocalDate, localDayBounds, zonedInstant } from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runLogGenerate } from './generate.ts';

// Promo slots in the `log-generate` job (#60, ADR 0032), on a real database: the job writes
// each day's placements between two songs, never one for an expired promo, and regenerating a
// day replaces the placements (a promo's untouched default segue doesn't pin its songs; one a
// person edited does).

const system: Actor = { type: 'system', name: 'test' };
const TZ = 'Europe/Paris';
const DATE: LocalDate = '2026-11-04';
const HOUR = 3_600_000;

let tdb: TestDatabase;
let scope: StationScope;
let poolId: string;
const promoIds: string[] = [];
const promoAssets: string[] = [];

const deps = () => ({ db: tdb.db, now: () => new Date('2026-11-01T00:00:00Z') });
const base = () => ({ orgId: scope.orgId, stationId: scope.stationId });

beforeAll(async () => {
  tdb = await createTestDatabase();
  const org = await createOrganization(tdb.db, system, { slug: 'gen-promos', name: 'Org' });
  const orgScope = await resolveOrgScope(tdb.db, org.id);
  const st = await createStation(
    tdb.db,
    { actor: system, scope: orgScope },
    { slug: 'gen-promos-fm', name: 'FM', timezone: TZ },
  );
  scope = await resolveStationScope(tdb.db, org.id, st.id);

  const songs = await tdb.db
    .insert(asset)
    .values(
      Array.from({ length: 150 }, (_, i) => ({
        ...base(),
        type: 'song' as const,
        title: `Song ${i}`,
        artists: [`Artist ${i % 50}`],
        durationMs: 180_000 + (i % 5) * 20_000,
      })),
    )
    .returning({ id: asset.id });
  const [music] = await tdb.db
    .insert(category)
    .values({ ...base(), name: 'Music', assetType: 'song', restMinutes: 120 })
    .returning({ id: category.id });
  if (!music) throw new Error('no category');
  await tdb.db.insert(categoryMember).values(
    songs.map((s) => ({
      ...base(),
      categoryId: music.id,
      assetId: s.id,
      mode: 'include' as const,
    })),
  );

  const [pool] = await tdb.db
    .insert(vtPool)
    .values({ ...base(), name: 'Events' })
    .returning({ id: vtPool.id });
  if (!pool) throw new Error('no pool');
  poolId = pool.id;
  // Three promos: one valid all along, one killed at 12:00 on the day, one not started yet.
  const voices = await tdb.db
    .insert(asset)
    .values([
      { ...base(), type: 'vt' as const, title: 'Promo always', durationMs: 20_000 },
      {
        ...base(),
        type: 'vt' as const,
        title: 'Promo until noon',
        durationMs: 20_000,
        killAt: zonedInstant(DATE, '12:00', TZ),
      },
      {
        ...base(),
        type: 'vt' as const,
        title: 'Promo next week',
        durationMs: 20_000,
        startAt: zonedInstant('2026-11-10', '00:00', TZ),
      },
    ])
    .returning({ id: asset.id });
  promoAssets.push(...voices.map((v) => v.id));
  const promos = await tdb.db
    .insert(promo)
    .values(voices.map((v) => ({ ...base(), assetId: v.id, weight: 1 })))
    .returning({ id: promo.id });
  promoIds.push(...promos.map((p) => p.id));
  await tdb.db
    .insert(vtPoolMember)
    .values(promos.map((p) => ({ ...base(), poolId, promoId: p.id })));

  // An hour: marker, then songs with a promo slot after every second song.
  const [c] = await tdb.db
    .insert(clock)
    .values({ ...base(), name: 'Hour', targetDurationMs: HOUR })
    .returning({ id: clock.id });
  if (!c) throw new Error('no clock');
  const slots: (typeof clockSlot.$inferInsert)[] = [
    {
      ...base(),
      clockId: c.id,
      position: 0,
      kind: 'marker',
      timing: 'soft',
      offsetMs: 0,
      capMs: 60_000,
    },
  ];
  for (let i = 0; i < 16; i++) {
    slots.push({
      ...base(),
      clockId: c.id,
      position: slots.length,
      kind: 'category',
      categoryId: music.id,
    });
    if (i % 2 === 1 && i < 12) {
      slots.push({
        ...base(),
        clockId: c.id,
        position: slots.length,
        kind: 'vt',
        vtMode: 'promo',
        poolId,
      });
    }
  }
  await tdb.db.insert(clockSlot).values(slots);
  await tdb.db.insert(clockGrid).values({ ...base(), defaultClockId: c.id, version: 1 });
}, 60_000);

afterAll(() => tdb?.drop());

async function dayOf(localDate: LocalDate) {
  const day = (await tdb.db.select().from(logDay)).find(
    (d) => d.stationId === scope.stationId && d.localDate === localDate,
  );
  if (!day) throw new Error(`no day ${localDate}`);
  const rows = (await tdb.db.select().from(logItem))
    .filter((r) => r.logDayId === day.id)
    .sort((a, b) => a.position - b.position);
  const placements = (await tdb.db.select().from(promoPlacement)).filter(
    (p) => p.logDayId === day.id,
  );
  return { day, rows, placements };
}

describe('promo slots in log-generate', () => {
  it('writes pending placements between two consecutive songs, audited', {
    timeout: 60_000,
  }, async () => {
    const report = await runLogGenerate(deps(), scope, { localDates: [DATE], status: 'draft' });
    expect(report?.issues[0]?.issues.filter((i) => i.code === 'vt_placeholder')).toEqual([]);
    const { day, rows, placements } = await dayOf(DATE);
    const pending = placements.filter((p) => p.status === 'pending');
    // Six promo slots an hour, each after a song.
    expect(pending.length).toBeGreaterThan(24 * 5);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const p of pending) {
      const a = byId.get(p.fromItemId as string);
      const b = byId.get(p.toItemId as string);
      expect(a?.kind).toBe('song');
      expect(b?.kind).toBe('song');
      expect(b?.position).toBe((a?.position ?? -2) + 1);
      expect(p.plannedAt.getTime()).toBe(
        (a?.plannedStart.getTime() ?? 0) + (a?.plannedDurationMs ?? 0),
      );
      expect(p.localDate).toBe(DATE);
      expect(p.poolId).toBe(poolId);
    }
    expect(new Set(pending.map((p) => p.fromItemId)).size).toBe(pending.length);
    const audits = (await tdb.db.select().from(auditLog)).filter(
      (a) => a.action === 'log_day.promos' && a.entityId === day.id,
    );
    expect(audits).toHaveLength(1);
  });

  it('never places an expired promo, nor one not started yet', { timeout: 60_000 }, async () => {
    const { placements } = await dayOf(DATE);
    const [always, untilNoon, nextWeek] = promoIds;
    const noon = zonedInstant(DATE, '12:00', TZ).getTime();
    expect(placements.some((p) => p.promoId === nextWeek)).toBe(false);
    const killed = placements.filter((p) => p.promoId === untilNoon);
    expect(killed.length).toBeGreaterThan(0);
    // Its whole air window (up to 30 s after the transition, plus its 20 s) is before the kill.
    for (const p of killed) expect(p.plannedAt.getTime() + 30_000 + 20_000).toBeLessThan(noon);
    // After noon, only the one that is still valid.
    expect(
      placements.filter((p) => p.plannedAt.getTime() >= noon).every((p) => p.promoId === always),
    ).toBe(true);
    // Before noon the two valid ones share the slots.
    const morning = placements.filter((p) => p.plannedAt.getTime() < noon);
    const share = morning.filter((p) => p.promoId === always).length / morning.length;
    expect(share).toBeGreaterThan(0.4);
    expect(share).toBeLessThan(0.6);
  });

  it('regenerating replaces the placements, and only an edited segue pins its songs', {
    timeout: 60_000,
  }, async () => {
    const { placements } = await dayOf(DATE);
    const [auto, edited] = placements.filter((p) => p.status === 'pending') as [
      (typeof placements)[number],
      (typeof placements)[number],
    ];
    // What the api does for a placement: a default segue (`auto`). One of them, a person saved.
    for (const [p, origin] of [
      [auto, 'auto'],
      [edited, 'manual'],
    ] as const) {
      const [s] = await tdb.db
        .insert(segue)
        .values({
          ...base(),
          fromItemId: p.fromItemId,
          toItemId: p.toItemId,
          outLane: { envelope: [] },
          inLane: { start: 0, envelope: [] },
          voices: [{ assetId: p.assetId, start: -44_100, gainDb: 0, envelope: [] }],
          origin,
        })
        .returning({ id: segue.id });
      await tdb.sql`update promo_placement set status = 'placed', segue_id = ${s?.id as string}
        where id = ${p.id}`;
    }

    await runLogGenerate(deps(), scope, { localDates: [DATE], status: 'draft', seed: 'another' });
    const after = await dayOf(DATE);
    const ids = new Set(after.rows.map((r) => r.id));
    // The edited segue's songs are kept; the generated one's aren't.
    expect(ids.has(edited.fromItemId as string)).toBe(true);
    expect(ids.has(edited.toItemId as string)).toBe(true);
    expect(ids.has(auto.fromItemId as string)).toBe(false);
    const rows = new Map(after.placements.map((p) => [p.id, p]));
    expect(rows.get(edited.id)?.status).toBe('placed');
    expect(rows.get(auto.id)).toMatchObject({ status: 'dropped', fromItemId: null });
    // Every earlier pending placement went with its songs; the new ones point at new items.
    const fresh = after.placements.filter((p) => p.status === 'pending');
    expect(fresh.length).toBeGreaterThan(24 * 5);
    expect(fresh.every((p) => ids.has(p.fromItemId as string))).toBe(true);
    // The kept transition doesn't get a second promo.
    expect(fresh.some((p) => p.fromItemId === edited.fromItemId)).toBe(false);
    // The day itself is still the whole day.
    expect(after.rows[0]?.plannedStart).toEqual(localDayBounds(DATE, TZ).startsAt);
  });
});
