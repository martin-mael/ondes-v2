import {
  asset,
  auditLog,
  category,
  categoryMember,
  clearRegenRequest,
  clock,
  clockGrid,
  clockSlot,
  createOrganization,
  createStation,
  getRegenRequest,
  logDay,
  logItem,
  logItemPin,
  recordRegenRequest,
  recordScheduleChanges,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
  setRegenSettings,
  stationsDueForHorizon,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import { REGEN_DEBOUNCE_MS, REGEN_FREEZE_MS } from '@ondes/scheduling';
import type { Actor, LocalDate, RealtimeEvent } from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runLogHorizon } from './horizon.ts';

// The `log-horizon` job on a real database (#101, ADR 0030): the rolling horizon (missing days,
// across the October DST change), a second pass that writes nothing, a debounced schedule
// change that regenerates around locked items and everything before the freeze point, and the
// sweep's station query.

const system: Actor = { type: 'system', name: 'test' };
const TZ = 'Europe/Paris';
const HOUR = 3_600_000;
/** 00:30 on Sunday 25 October 2026 in Paris (UTC+2 until 03:00): the 25-hour day. */
const NOW = new Date('2026-10-24T22:30:00Z');

let tdb: TestDatabase;
let scope: StationScope;
let musicId: string;
const songIds: string[] = [];
const events: RealtimeEvent[] = [];

const deps = (now: Date) => ({
  db: tdb.db,
  publish: async (event: RealtimeEvent) => {
    events.push(event);
  },
  now: () => now,
});
const base = () => ({ orgId: scope.orgId, stationId: scope.stationId });

async function station(slug: string, withGrid: boolean) {
  const org = await createOrganization(tdb.db, system, { slug, name: 'Org' });
  const orgScope = await resolveOrgScope(tdb.db, org.id);
  const st = await createStation(
    tdb.db,
    { actor: system, scope: orgScope },
    { slug: `${slug}-fm`, name: 'FM', timezone: TZ },
  );
  const s = await resolveStationScope(tdb.db, org.id, st.id);
  if (!withGrid) return s;
  scope = s;
  const songs = await tdb.db
    .insert(asset)
    .values(
      Array.from({ length: 150 }, (_, i) => ({
        ...base(),
        type: 'song' as const,
        title: `Song ${i}`,
        artists: [`Artist ${i % 50}`],
        album: `Album ${i % 30}`,
        durationMs: 180_000 + (i % 7) * 15_000,
      })),
    )
    .returning({ id: asset.id });
  songIds.push(...songs.map((x) => x.id));
  const [music] = await tdb.db
    .insert(category)
    .values({ ...base(), name: 'Music', assetType: 'song', restMinutes: 180 })
    .returning({ id: category.id });
  if (!music) throw new Error('no category');
  musicId = music.id;
  await tdb.db.insert(categoryMember).values(
    songIds.map((assetId) => ({
      ...base(),
      categoryId: musicId,
      assetId,
      mode: 'include' as const,
    })),
  );
  const [c] = await tdb.db
    .insert(clock)
    .values({ ...base(), name: 'Hour', targetDurationMs: HOUR })
    .returning({ id: clock.id });
  if (!c) throw new Error('no clock');
  await tdb.db.insert(clockSlot).values([
    {
      ...base(),
      clockId: c.id,
      position: 0,
      kind: 'marker',
      timing: 'soft',
      offsetMs: 0,
      capMs: 60_000,
    },
    ...Array.from({ length: 16 }, (_, i) => ({
      ...base(),
      clockId: c.id,
      position: i + 1,
      kind: 'category' as const,
      categoryId: musicId,
    })),
  ]);
  await tdb.db.insert(clockGrid).values({ ...base(), defaultClockId: c.id, version: 1 });
  return s;
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  await station('horizon-worker', true);
  await setRegenSettings(
    tdb.db,
    { actor: system, scope },
    { horizonDays: 3, newDayStatus: 'published' },
  );
}, 60_000);

afterAll(() => tdb?.drop());

async function days() {
  return (await tdb.db.select().from(logDay))
    .filter((d) => d.stationId === scope.stationId)
    .sort((a, b) => a.localDate.localeCompare(b.localDate));
}

async function items(localDate: LocalDate) {
  const day = (await days()).find((d) => d.localDate === localDate);
  return (await tdb.db.select().from(logItem))
    .filter((r) => r.logDayId === day?.id)
    .sort((a, b) => a.position - b.position);
}

/** An audit row as an api mutation writes it (same transaction as the change). */
async function auditRow(action: string, at: Date, station = scope) {
  await tdb.sql`insert into audit_log (org_id, station_id, actor_type, actor_id, action,
    entity_type, entity_id, at)
    values (${station.orgId}, ${station.stationId}, 'user', 'someone', ${action}, 'thing',
      ${action}, ${at.toISOString()})`;
}

const generateAudits = async () =>
  (await tdb.db.select().from(auditLog)).filter(
    (a) => a.action === 'log_day.generate' && a.stationId === scope.stationId,
  ).length;

describe('log-horizon job', () => {
  it('generates the horizon from the station-local today, the 25-hour day included', async () => {
    const report = await runLogHorizon(deps(NOW), scope);
    expect(report?.missing).toEqual(['2026-10-25', '2026-10-26', '2026-10-27']);
    const written = await days();
    expect(written.map((d) => [d.localDate, d.status, d.version])).toEqual([
      ['2026-10-25', 'published', 1],
      ['2026-10-26', 'published', 1],
      ['2026-10-27', 'published', 1],
    ]);
    const [autumn] = written;
    expect((autumn?.endsAt.getTime() ?? 0) - (autumn?.startsAt.getTime() ?? 0)).toBe(25 * HOUR);
    const rows = await items('2026-10-25');
    const last = rows.filter((r) => r.segmentId === null).at(-1);
    expect(last && last.plannedStart.getTime() < (autumn?.endsAt.getTime() ?? 0)).toBe(true);
  }, 60_000);

  it('writes nothing on a pass with nothing missing and no change', async () => {
    const before = await days();
    const audits = await generateAudits();
    const report = await runLogHorizon(deps(NOW), scope);
    expect(report).toMatchObject({ missing: [], regenerated: [], runs: [] });
    expect((await days()).map((d) => d.version)).toEqual(before.map((d) => d.version));
    expect(await generateAudits()).toBe(audits);
  }, 60_000);

  it('extends the horizon by a day once the station-local date moves on (the nightly pass)', async () => {
    // 00:30 on the 26th in Paris (UTC+1 since the change).
    const tomorrow = new Date('2026-10-25T23:30:00Z');
    const report = await runLogHorizon(deps(tomorrow), scope);
    expect(report?.missing).toEqual(['2026-10-28']);
    expect((await days()).map((d) => d.localDate)).toContain('2026-10-28');
  }, 60_000);

  it('regenerates after a debounced change, keeping locked items and what is frozen', async () => {
    // Later on the 25th: 10:00 in Paris (UTC+1 since 03:00).
    const now = new Date('2026-10-25T09:00:00Z');
    const frozenUntil = now.getTime() + REGEN_FREEZE_MS;
    const today = await items('2026-10-25');
    const frozen = today.filter(
      (r) => r.segmentId === null && r.plannedStart.getTime() < frozenUntil,
    );
    expect(frozen.length).toBeGreaterThan(0);
    const next = await items('2026-10-26');
    const locked = next.filter((r) => r.kind === 'song')[40];
    if (!locked) throw new Error('no song to lock');
    await tdb.sql`update log_item set locked = true where id = ${locked.id}`;
    // The schedule changes: half the songs leave the category.
    await tdb.sql`delete from category_member where category_id = ${musicId}
      and asset_id = any(${songIds.slice(0, 75)})`;

    // The api's mutation wrote its audit row; the api's sweep records the change from it.
    await auditRow('category.update', now);
    expect(await recordScheduleChanges(tdb.db, now)).toContainEqual(
      expect.objectContaining({ stationId: scope.stationId }),
    );
    const pending = await runLogHorizon(deps(now), scope);
    expect(pending).toMatchObject({ regenerated: [] });
    expect(await getRegenRequest(tdb.db, scope)).toMatchObject({
      areas: ['categories'],
      dueAt: new Date(now.getTime() + REGEN_DEBOUNCE_MS),
    });

    const later = new Date(now.getTime() + REGEN_DEBOUNCE_MS);
    const versions = new Map((await days()).map((d) => [d.localDate, d.version]));
    const report = await runLogHorizon(deps(later), scope);
    expect(report?.regenerated).toEqual(['2026-10-25', '2026-10-26', '2026-10-27']);
    expect(await getRegenRequest(tdb.db, scope)).toBeNull();

    const regenerated = await items('2026-10-25');
    // What starts before the freeze point stays as it was, ids included.
    expect(regenerated.slice(0, frozen.length).map((r) => r.id)).toEqual(frozen.map((r) => r.id));
    const after = regenerated.filter((r) => r.plannedStart.getTime() >= frozenUntil + 10 * 60_000);
    expect(after.length).toBeGreaterThan(0);
    // Only the songs still in the category are planned after it.
    const kept = new Set(songIds.slice(75));
    expect(after.filter((r) => r.kind === 'song').every((r) => kept.has(r.assetId as string))).toBe(
      true,
    );
    expect((await days()).find((d) => d.localDate === '2026-10-25')?.version).toBe(
      (versions.get('2026-10-25') ?? 0) + 1,
    );
    // The locked song survives with its id, and gets a pin.
    expect((await items('2026-10-26')).some((r) => r.id === locked.id)).toBe(true);
    const pins = (await tdb.db.select().from(logItemPin)).filter((p) => p.logItemId === locked.id);
    expect(pins).toHaveLength(1);
  }, 60_000);

  it('regenerating again with the same inputs is a no-op, locked item and all', async () => {
    const now = new Date('2026-10-25T09:00:30Z');
    await recordRegenRequest(tdb.db, scope, { at: now, areas: ['rules'], from: null });
    const before = await days();
    const ids = await items('2026-10-26');
    const audits = await generateAudits();
    const eventsBefore = events.length;
    const report = await runLogHorizon(deps(new Date(now.getTime() + REGEN_DEBOUNCE_MS)), scope);
    expect(report?.regenerated).toEqual(['2026-10-25', '2026-10-26', '2026-10-27']);
    expect(report?.runs.flatMap((r) => r.days.map((d) => d.changed))).toEqual([
      false,
      false,
      false,
    ]);
    expect((await days()).map((d) => d.version)).toEqual(before.map((d) => d.version));
    expect((await items('2026-10-26')).map((r) => r.id)).toEqual(ids.map((r) => r.id));
    expect(await generateAudits()).toBe(audits);
    expect(events.slice(eventsBefore).map((e) => e.type)).toEqual(['log.generated']);
  }, 60_000);

  it('generates the 23-hour spring day like any other', async () => {
    const spring = new Date('2026-03-28T23:30:00Z');
    const report = await runLogHorizon(deps(spring), scope);
    expect(report?.missing).toEqual(['2026-03-29', '2026-03-30', '2026-03-31']);
    const day = (await days()).find((d) => d.localDate === '2026-03-29');
    expect((day?.endsAt.getTime() ?? 0) - (day?.startsAt.getTime() ?? 0)).toBe(23 * HOUR);
  }, 60_000);
});

describe('stationsDueForHorizon', () => {
  it('lists stations with a clock grid and a missing day or a due change', async () => {
    const noGrid = await station('horizon-no-grid', false);
    // 00:30 on the 28th in Paris: the horizon needs the 29th and the 30th, not generated yet.
    const inTwoDays = new Date('2026-10-27T23:30:00Z');
    const due = await stationsDueForHorizon(tdb.db, inTwoDays);
    expect(due).toContainEqual({ orgId: scope.orgId, stationId: scope.stationId });
    expect(due.map((d) => d.stationId)).not.toContain(noGrid.stationId);

    const full = new Date(NOW.getTime() + 24 * HOUR);
    expect((await stationsDueForHorizon(tdb.db, full)).map((d) => d.stationId)).not.toContain(
      scope.stationId,
    );
    await recordRegenRequest(tdb.db, scope, { at: full, areas: ['grid'], from: '2026-10-27' });
    expect((await stationsDueForHorizon(tdb.db, full)).map((d) => d.stationId)).not.toContain(
      scope.stationId,
    );
    const dueAt = new Date(full.getTime() + REGEN_DEBOUNCE_MS);
    expect((await stationsDueForHorizon(tdb.db, dueAt)).map((d) => d.stationId)).toContain(
      scope.stationId,
    );
  }, 60_000);
});

describe('recordScheduleChanges', () => {
  it('turns audit rows of schedule actions into one debounced request, once', async () => {
    const other = await station('changes-worker', false);
    const at = new Date('2026-10-30T10:00:00Z');
    await auditRow('asset.tag', at, other);
    await auditRow('show_slot.update', new Date(at.getTime() + 1_000), other);
    await auditRow('log_day.generate', new Date(at.getTime() + 2_000), other);
    await auditRow('asset_analysis.set', new Date(at.getTime() + 2_000), other);
    const now = new Date(at.getTime() + 5_000);
    const mine = (list: StationScope[]) => list.filter((s) => s.stationId === other.stationId);
    expect(mine(await recordScheduleChanges(tdb.db, now))).toHaveLength(1);
    expect(await getRegenRequest(tdb.db, other)).toMatchObject({
      areas: ['library', 'shows'],
      firstRequestedAt: at,
      lastRequestedAt: new Date(at.getTime() + 1_000),
      dueAt: new Date(at.getTime() + 1_000 + REGEN_DEBOUNCE_MS),
    });
    // Seen already: nothing new, the request stays as it was.
    expect(mine(await recordScheduleChanges(tdb.db, now))).toEqual([]);

    // Handled: the cursor moves past it, and only a later change counts again.
    const request = await getRegenRequest(tdb.db, other);
    await clearRegenRequest(tdb.db, other, request?.lastRequestedAt as Date);
    expect(mine(await recordScheduleChanges(tdb.db, now))).toEqual([]);
    await auditRow('clock.update', new Date(at.getTime() + 60_000), other);
    const later = new Date(at.getTime() + 61_000);
    expect(mine(await recordScheduleChanges(tdb.db, later))).toHaveLength(1);
    expect((await getRegenRequest(tdb.db, other))?.areas).toEqual(['clocks']);
  }, 30_000);

  it('merges concurrent first changes instead of overwriting one', async () => {
    const other = await station('race-worker', false);
    const at = new Date('2026-10-30T12:00:00Z');
    await Promise.all([
      recordRegenRequest(tdb.db, other, { at, areas: ['grid'], from: '2026-11-02' }),
      recordRegenRequest(tdb.db, other, {
        at: new Date(at.getTime() - 4_000),
        areas: ['rules'],
        from: null,
      }),
    ]);
    expect(await getRegenRequest(tdb.db, other)).toMatchObject({
      areas: ['grid', 'rules'],
      fromDate: null,
      firstRequestedAt: new Date(at.getTime() - 4_000),
      lastRequestedAt: at,
    });
  }, 30_000);
});
