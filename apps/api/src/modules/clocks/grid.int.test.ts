import {
  addMembership,
  auditLog,
  createOrganization,
  createStation,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
} from '@ondes/db';
import { clockForWallHour, resolveClockAt } from '@ondes/scheduling';
import type {
  Actor,
  ClockDetail,
  ClockGridDto,
  Daypart,
  GridHours,
  GridOverride,
} from '@ondes/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, signUpAndLogin, type TestApp } from '../auth/testing.ts';
import { loadClockGrid } from './grid-repo.ts';

// The weekly clock grid API on the real app: cells and default (versioned), dayparts,
// overrides, resolved hours across a DST night, permissions, tenant isolation and audit.

const system: Actor = { type: 'system', name: 'test' };

let t: TestApp;
let scope: StationScope;
const cookies = { programmer: '', presenter: '', outsider: '' };
const clocks: Record<string, string> = {};
let otherClock: string;
let otherStation: string;

function call(
  who: keyof typeof cookies,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  stationId = scope.stationId,
) {
  return t.app.inject({
    method,
    url: `/api/v1/stations/${stationId}${url}`,
    cookies: { ondes_session: cookies[who] },
    ...(payload ? { payload } : {}),
  });
}

beforeAll(async () => {
  t = await createTestApp();
  const db = t.tdb.db;
  const org = await createOrganization(db, system, { slug: 'grid-org', name: 'Org' });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: 'grid-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(db, org.id, st.id);
  for (const role of ['programmer', 'presenter'] as const) {
    const { userId, cookie } = await signUpAndLogin(t, `${role}@grid.test`);
    await addMembership(
      db,
      { actor: system, scope: orgScope },
      { level: 'station', stationId: st.id, userId, role },
    );
    cookies[role] = cookie;
  }
  for (const name of ['Music', 'Morning', 'Night', 'Xmas']) {
    const res = await call('programmer', 'POST', '/clocks', { name });
    clocks[name] = res.json<ClockDetail>().id;
  }

  const other = await createOrganization(db, system, { slug: 'grid-other', name: 'Other' });
  const otherOrgScope = await resolveOrgScope(db, other.id);
  const ost = await createStation(
    db,
    { actor: system, scope: otherOrgScope },
    { slug: 'grid-other-fm', name: 'Other FM', timezone: 'Europe/Paris' },
  );
  otherStation = ost.id;
  const outsider = await signUpAndLogin(t, 'outsider@grid.test');
  await addMembership(
    db,
    { actor: system, scope: otherOrgScope },
    { level: 'org', userId: outsider.userId, role: 'owner' },
  );
  cookies.outsider = outsider.cookie;
  const oc = await call('outsider', 'POST', '/clocks', { name: 'Theirs' }, ost.id);
  otherClock = oc.json<ClockDetail>().id;
}, 60_000);

afterAll(() => t?.close());

async function auditActions(entityType: string) {
  const rows = await t.tdb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.stationId, scope.stationId)))
    .orderBy(asc(auditLog.at));
  return rows.map((r) => r.action);
}

describe('clock grid API', () => {
  it('starts empty at version 0, in the station timezone', async () => {
    const res = await call('programmer', 'GET', '/clock-grid');
    expect(res.statusCode).toBe(200);
    expect(res.json<ClockGridDto>()).toEqual({
      defaultClockId: null,
      cells: [],
      version: 0,
      dayparts: [],
      overrides: [],
      timezone: 'Europe/Paris',
    });
  });

  it('saves cells and the default, checking the version', async () => {
    const res = await call('programmer', 'PUT', '/clock-grid', {
      version: 0,
      defaultClockId: clocks.Music,
      cells: [
        { weekday: 7, hour: 2, clockId: clocks.Night },
        { weekday: 1, hour: 7, clockId: clocks.Morning },
      ],
    });
    expect(res.statusCode).toBe(200);
    const grid = res.json<ClockGridDto>();
    expect(grid.version).toBe(1);
    expect(grid.defaultClockId).toBe(clocks.Music);
    expect(grid.cells.map((c) => [c.weekday, c.hour])).toEqual([
      [1, 7],
      [7, 2],
    ]);

    const stale = await call('programmer', 'PUT', '/clock-grid', {
      version: 0,
      defaultClockId: clocks.Music,
      cells: [],
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('edit_conflict');
    expect(await auditActions('clock_grid')).toEqual(['clock_grid.update']);
    // The audit row lists the hours that changed, not the whole grid.
    const [row] = await t.tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'clock_grid'), eq(auditLog.stationId, scope.stationId)));
    expect(row?.diff).toEqual({
      defaultClockId: { from: null, to: clocks.Music },
      cells: {
        from: [
          { weekday: 1, hour: 7, clockId: null },
          { weekday: 7, hour: 2, clockId: null },
        ],
        to: [
          { weekday: 1, hour: 7, clockId: clocks.Morning },
          { weekday: 7, hour: 2, clockId: clocks.Night },
        ],
      },
    });
  });

  it('refuses a grid that leaves hours without a clock', async () => {
    const res = await call('programmer', 'PUT', '/clock-grid', {
      version: 1,
      defaultClockId: null,
      cells: [{ weekday: 1, hour: 7, clockId: clocks.Morning }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'incomplete_grid', details: { unassigned: 167 } });
  });

  it('refuses duplicate hours and other stations’ clocks', async () => {
    const dup = await call('programmer', 'PUT', '/clock-grid', {
      version: 1,
      defaultClockId: null,
      cells: [
        { weekday: 1, hour: 7, clockId: clocks.Music },
        { weekday: 1, hour: 7, clockId: clocks.Night },
      ],
    });
    expect(dup.statusCode).toBe(400);
    const foreign = await call('programmer', 'PUT', '/clock-grid', {
      version: 1,
      defaultClockId: otherClock,
      cells: [],
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error).toBe('unknown_clock');
    const override = await call('programmer', 'POST', '/clock-grid/overrides', {
      name: 'Theirs',
      startsOn: '2026-12-24',
      endsOn: '2026-12-24',
      clockId: otherClock,
    });
    expect(override.statusCode).toBe(400);
  });

  it('keeps dayparts, with unique names', async () => {
    const created = await call('programmer', 'POST', '/clock-grid/dayparts', {
      name: 'Night',
      weekdays: [7, 1, 2],
      startHour: 22,
      endHour: 6,
    });
    expect(created.statusCode).toBe(201);
    const part = created.json<Daypart>();
    expect(part.weekdays).toEqual([1, 2, 7]);
    const dup = await call('programmer', 'POST', '/clock-grid/dayparts', {
      name: 'night',
      weekdays: [3],
      startHour: 0,
      endHour: 6,
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('daypart_name_taken');
    const patched = await call('programmer', 'PATCH', `/clock-grid/dayparts/${part.id}`, {
      endHour: 5,
    });
    expect(patched.json<Daypart>().endHour).toBe(5);
    const removed = await call('programmer', 'DELETE', `/clock-grid/dayparts/${part.id}`);
    expect(removed.statusCode).toBe(204);
    expect(await auditActions('daypart')).toEqual([
      'daypart.create',
      'daypart.update',
      'daypart.delete',
    ]);
  });

  it('keeps overrides that win by date, and resolves real hours across DST', async () => {
    const created = await call('programmer', 'POST', '/clock-grid/overrides', {
      name: 'Christmas',
      startsOn: '2026-12-21',
      endsOn: '2026-12-27',
      clockId: clocks.Xmas,
    });
    expect(created.statusCode).toBe(201);
    const xmas = created.json<GridOverride>();
    expect([xmas.startHour, xmas.endHour]).toEqual([0, 24]);

    const backwards = await call('programmer', 'PATCH', `/clock-grid/overrides/${xmas.id}`, {
      endsOn: '2026-12-01',
    });
    expect(backwards.statusCode).toBe(400);

    const grid = await loadClockGrid(t.tdb.db, scope);
    expect(clockForWallHour(grid, { date: '2026-12-21', hour: 7 })).toMatchObject({
      clockId: clocks.Xmas,
      source: 'override',
    });
    expect(clockForWallHour(grid, { date: '2026-12-28', hour: 7 }).clockId).toBe(clocks.Morning);

    // The night the clocks go back: 25 hours, the 02 cell twice.
    const fall = await call('programmer', 'GET', '/clock-grid/hours?from=2026-10-25&days=1');
    expect(fall.statusCode).toBe(200);
    const hours = fall.json<GridHours>().items;
    expect(hours).toHaveLength(25);
    expect(hours.filter((h) => h.clockId === clocks.Night).map((h) => h.repeated)).toEqual([
      false,
      true,
    ]);
    // The night they go forward: 23 hours, the 02 cell skipped.
    const spring = await call('programmer', 'GET', '/clock-grid/hours?from=2026-03-29&days=1');
    expect(spring.json<GridHours>().items).toHaveLength(23);

    const removed = await call('programmer', 'DELETE', `/clock-grid/overrides/${xmas.id}`);
    expect(removed.statusCode).toBe(204);
    expect(await auditActions('clock_grid_override')).toEqual([
      'clock_grid_override.create',
      'clock_grid_override.delete',
    ]);
  });

  it('keeps the grid complete when clocks are deleted', async () => {
    const override = (
      await call('programmer', 'POST', '/clock-grid/overrides', {
        name: 'Night special',
        startsOn: '2026-11-01',
        endsOn: '2026-11-01',
        clockId: clocks.Night,
      })
    ).json<GridOverride>();
    // The default clock and an override's clock can't go.
    const isDefault = await call('programmer', 'DELETE', `/clocks/${clocks.Music}`);
    expect(isDefault.statusCode).toBe(409);
    expect(isDefault.json()).toMatchObject({ error: 'clock_in_use', details: { default: true } });
    const inOverride = await call('programmer', 'DELETE', `/clocks/${clocks.Night}`);
    expect(inOverride.statusCode).toBe(409);
    expect(inOverride.json().details.overrides).toEqual(['Night special']);

    // Once the override is gone, deleting it removes its painted hour (back to the default)
    // and bumps the version: an editor still on the old version gets edit_conflict.
    await call('programmer', 'DELETE', `/clock-grid/overrides/${override.id}`);
    const before = (await call('programmer', 'GET', '/clock-grid')).json<ClockGridDto>();
    expect((await call('programmer', 'DELETE', `/clocks/${clocks.Night}`)).statusCode).toBe(204);
    const grid = (await call('programmer', 'GET', '/clock-grid')).json<ClockGridDto>();
    expect(grid.cells.map((c) => c.clockId)).toEqual([clocks.Morning]);
    expect(grid.version).toBe(before.version + 1);
    const stale = await call('programmer', 'PUT', '/clock-grid', {
      version: before.version,
      defaultClockId: clocks.Music,
      cells: before.cells,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('edit_conflict');

    const loaded = await loadClockGrid(t.tdb.db, scope);
    // 2026-11-01 02:00 CET is 01:00Z.
    const at = resolveClockAt(loaded, new Date('2026-11-01T01:00:00Z'), 'Europe/Paris');
    expect([at.hour, at.source, at.clockId]).toEqual([2, 'default', clocks.Music]);
  });

  it('needs clock permissions and hides other tenants', async () => {
    // Presenters have neither clock:read nor clock:write.
    expect((await call('presenter', 'GET', '/clock-grid')).statusCode).toBe(403);
    const put = await call('presenter', 'PUT', '/clock-grid', {
      version: 1,
      defaultClockId: null,
      cells: [],
    });
    expect(put.statusCode).toBe(403);
    expect((await call('outsider', 'GET', '/clock-grid')).statusCode).toBe(404);
    const theirs = await call('outsider', 'GET', '/clock-grid', undefined, otherStation);
    expect(theirs.json<ClockGridDto>().cells).toEqual([]);
  });
});
