import {
  addMembership,
  auditLog,
  createAsset,
  createOrganization,
  createStation,
  deleteAsset,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
} from '@ondes/db';
import type {
  Actor,
  CategoryDetail,
  ClockDetail,
  ClockEstimate,
  ClockList,
  ClockPreview,
  ClockSlotInput,
  CreateAsset,
} from '@ondes/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, signUpAndLogin, type TestApp } from '../auth/testing.ts';
import { loadClock, previewDraft } from './repo.ts';

// The clocks API on the real app: CRUD, estimates from category averages, permissions,
// tenant isolation, audit, and a sample-hour preview from the real library.

const system: Actor = { type: 'system', name: 'test' };
const MIN = 60_000;

let t: TestApp;
let scope: StationScope;
let otherScope: StationScope;
const cookies = { programmer: '', presenter: '', outsider: '' };
const ids: Record<string, string> = {};
let otherCategory: string;

async function asset(name: string, input: Partial<CreateAsset>) {
  const created = await createAsset(
    t.tdb.db,
    { actor: system, scope },
    { type: 'song', title: name, artists: [name], ...input },
  );
  ids[name] = created.id;
  return created.id;
}

function call(
  who: keyof typeof cookies,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
  const org = await createOrganization(db, system, { slug: 'clk-org', name: 'Org' });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: 'clk-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(db, org.id, st.id);

  // Songs of 3 and 5 minutes (average 4), two jingles of 10 s, a sponsor message of 30 s.
  const songs = await Promise.all([
    asset('Song A', { durationMs: 3 * MIN }),
    asset('Song B', { durationMs: 5 * MIN }),
    asset('Song C', { durationMs: 3 * MIN }),
    asset('Song D', { durationMs: 5 * MIN }),
  ]);
  const jingles = await Promise.all([
    asset('ID 1', { type: 'jingle', durationMs: 10_000 }),
    asset('ID 2', { type: 'jingle', durationMs: 10_000 }),
  ]);
  await asset('Sponsor', { type: 'other', durationMs: 30_000 });

  for (const role of ['programmer', 'presenter'] as const) {
    const { userId, cookie } = await signUpAndLogin(t, `${role}@clk.test`);
    await addMembership(
      db,
      { actor: system, scope: orgScope },
      { level: 'station', stationId: st.id, userId, role },
    );
    cookies[role] = cookie;
  }

  const make = async (name: string, assetType: string, members: string[]) => {
    const res = await call('programmer', 'POST', '/categories', {
      name,
      assetType,
      members: members.map((assetId) => ({ assetId, mode: 'include' })),
    });
    ids[name] = res.json<CategoryDetail>().id;
  };
  await make('Gold', 'song', songs);
  await make('IDs', 'jingle', jingles);
  await make('Empty', 'song', []);

  const other = await createOrganization(db, system, { slug: 'clk-other', name: 'Other' });
  const otherOrgScope = await resolveOrgScope(db, other.id);
  const ost = await createStation(
    db,
    { actor: system, scope: otherOrgScope },
    { slug: 'clk-other-fm', name: 'Other FM', timezone: 'Europe/Paris' },
  );
  otherScope = await resolveStationScope(db, other.id, ost.id);
  const outsider = await signUpAndLogin(t, 'outsider@clk.test');
  await addMembership(
    db,
    { actor: system, scope: otherOrgScope },
    { level: 'org', userId: outsider.userId, role: 'owner' },
  );
  cookies.outsider = outsider.cookie;
  const oc = await call('outsider', 'POST', '/categories', { name: 'Theirs' }, ost.id);
  otherCategory = oc.json<CategoryDetail>().id;
}, 60_000);

afterAll(() => t?.close());

async function auditRows(entityId: string) {
  return t.tdb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'clock'), eq(auditLog.entityId, entityId)))
    .orderBy(asc(auditLog.at));
}

const hour = (): ClockSlotInput[] => [
  { kind: 'marker', offsetMs: 0, timing: 'hard', label: 'Top of hour' },
  { kind: 'jingle', categoryId: ids.IDs },
  ...Array.from({ length: 7 }, () => ({ kind: 'category' as const, categoryId: ids.Gold })),
  { kind: 'asset', assetId: ids.Sponsor },
  { kind: 'vt', mode: 'placeholder' },
  { kind: 'marker', offsetMs: 30 * MIN, timing: 'soft', capMs: 2 * MIN },
  ...Array.from({ length: 6 }, () => ({ kind: 'category' as const, categoryId: ids.Gold })),
  { kind: 'fill' },
];

describe('clocks API', () => {
  let clockId: string;

  it('creates a clock with its slots, an estimate and an audit row', async () => {
    const res = await call('programmer', 'POST', '/clocks', {
      name: 'Daytime',
      color: '#3366ff',
      slots: hour(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<ClockDetail>();
    clockId = body.id;
    expect(body).toMatchObject({ name: 'Daytime', targetDurationMs: 60 * MIN });
    expect(body.slots).toHaveLength(19);
    expect(body.slots[2]).toEqual({
      kind: 'category',
      categoryId: ids.Gold,
      label: null,
      durationMs: null,
    });
    // ID 10 s, 7 songs × 4 min, sponsor 30 s, VT 30 s: 29:10, then the 30:00 marker.
    expect(body.estimate.slots[11]).toEqual({ startMs: 30 * MIN, durationMs: 0, source: 'marker' });
    expect(body.estimate.slots[1]).toMatchObject({ durationMs: 10_000, source: 'average' });
    expect(body.estimate.slots[9]).toMatchObject({ durationMs: 30_000, source: 'asset' });
    // The fill takes the last 6 minutes.
    expect(body.estimate.slots[18]).toMatchObject({ durationMs: 6 * MIN, source: 'fill' });
    expect(body.estimate.totalMs).toBe(60 * MIN);
    expect(body.estimate.warnings).toEqual([{ code: 'gap', slotIndex: 11, ms: 50_000 }]);

    const audit = await auditRows(clockId);
    expect(audit.map((a) => a.action)).toEqual(['clock.create']);
    expect(audit[0]?.stationId).toBe(scope.stationId);
    expect(audit[0]?.diff).toMatchObject({ name: { from: null, to: 'Daytime' } });
  });

  it('refuses a duplicate name, case-insensitively', async () => {
    const res = await call('programmer', 'POST', '/clocks', { name: 'DAYTIME' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('clock_name_taken');
  });

  it('validates slots', async () => {
    const bad = await call('programmer', 'POST', '/clocks', {
      name: 'Bad',
      slots: [{ kind: 'marker', offsetMs: -5 }],
    });
    expect(bad.statusCode).toBe(400);
    const short = await call('programmer', 'POST', '/clocks', { name: 'Bad', targetDurationMs: 5 });
    expect(short.statusCode).toBe(400);
  });

  it('updates the slots with an audit diff, and warns about an overfilled hour', async () => {
    const slots = [...hour().slice(0, -1), ...Array.from({ length: 3 }, () => hour()[2])];
    const res = await call('programmer', 'PATCH', `/clocks/${clockId}`, {
      slots: slots as object[],
      description: 'Weekday daytime',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ClockDetail>();
    expect(body.description).toBe('Weekday daytime');
    // 30:00 + 9 songs × 4 min = 66:00.
    expect(body.estimate.totalMs).toBe(66 * MIN);
    expect(body.estimate.warnings).toContainEqual({ code: 'over_target', ms: 6 * MIN });

    const update = (await auditRows(clockId)).at(-1);
    expect(update?.action).toBe('clock.update');
    expect(Object.keys(update?.diff ?? {}).sort()).toEqual(['description', 'slots']);
  });

  it('estimates a draft without saving it', async () => {
    const res = await call('programmer', 'POST', '/clocks/estimate', {
      targetDurationMs: 20 * MIN,
      slots: Array.from({ length: 5 }, () => ({ kind: 'category', categoryId: ids.Gold })),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ClockEstimate>();
    expect(body.totalMs).toBe(20 * MIN);
    expect(body.warnings).toEqual([]);
  });

  it('previews a plausible sample hour from the real library', async () => {
    const res = await call('programmer', 'GET', `/clocks/${clockId}/preview?seed=abc`);
    expect(res.statusCode).toBe(200);
    const body = res.json<ClockPreview>();
    expect(body.seed).toBe('abc');
    expect(body.items).toHaveLength(21);
    const songs = body.items.filter((i) => i.kind === 'category');
    expect(songs.every((i) => i.source === 'random' && i.asset?.type === 'song')).toBe(true);
    // Four songs in the category: no repeat until they're all used.
    expect(new Set(songs.slice(0, 4).map((i) => i.asset?.id)).size).toBe(4);
    expect(songs[4]?.relaxedRules).toEqual(['no_repeat_in_hour']);
    expect(body.items[1]).toMatchObject({ kind: 'jingle', asset: { type: 'jingle' } });
    expect(body.items[9]).toMatchObject({ source: 'fixed', asset: { title: 'Sponsor' } });
    expect(body.items[10]).toMatchObject({ kind: 'vt', asset: null, durationMs: 30_000 });
    // Timed with the real lengths: each item starts where the previous one ends.
    for (let i = 1; i < 11; i++) {
      const prev = body.items[i - 1];
      expect(body.items[i]?.startMs).toBe((prev?.startMs ?? 0) + (prev?.durationMs ?? 0));
    }
    expect(body.items[2]?.durationMs).toBe(body.items[2]?.asset?.durationMs);

    // Same seed, same picks.
    const again = (
      await call('programmer', 'GET', `/clocks/${clockId}/preview?seed=abc`)
    ).json<ClockPreview>();
    expect(again.items.map((i) => i.asset?.id)).toEqual(body.items.map((i) => i.asset?.id));
  });

  it('previews a draft, flagging empty categories', async () => {
    const res = await call('programmer', 'POST', '/clocks/preview', {
      targetDurationMs: 10 * MIN,
      slots: [
        { kind: 'category', categoryId: ids.Empty },
        { kind: 'category', categoryId: ids.Gold },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ClockPreview>();
    expect(body.items[0]).toMatchObject({ asset: null, problem: 'empty_category' });
    expect(body.items[1]?.asset).not.toBeNull();
    expect(body.estimate.warnings).toContainEqual({ code: 'unknown_duration', slotIndex: 0 });
  });

  it('uses the rules picker when given one', async () => {
    const preview = await previewDraft(
      t.tdb.db,
      scope,
      { slots: [{ kind: 'category', categoryId: ids.Gold }] },
      {
        picker: {
          source: 'rules',
          pick: async ({ categoryId }) =>
            categoryId === ids.Gold
              ? {
                  asset: {
                    id: ids['Song B'] as string,
                    type: 'song',
                    title: 'Song B',
                    artists: ['Song B'],
                    year: null,
                    explicit: false,
                    durationMs: 5 * MIN,
                    startAt: null,
                    killAt: null,
                    addedAt: new Date(),
                    tags: [],
                  },
                  relaxedRules: ['artist_separation'],
                }
              : null,
        },
      },
    );
    expect(preview.items[0]).toMatchObject({
      source: 'rules',
      asset: { title: 'Song B' },
      relaxedRules: ['artist_separation'],
      durationMs: 5 * MIN,
    });
  });

  it('duplicates a clock under a free name', async () => {
    const first = await call('programmer', 'POST', `/clocks/${clockId}/duplicate`, {});
    expect(first.statusCode).toBe(201);
    const copy = first.json<ClockDetail>();
    expect(copy.name).toBe('Daytime (copy)');
    expect(copy.id).not.toBe(clockId);
    const original = await loadClock(t.tdb.db, scope, clockId);
    expect(copy.slots).toEqual(original.slots);
    const second = await call('programmer', 'POST', `/clocks/${clockId}/duplicate`, {});
    expect(second.json<ClockDetail>().name).toBe('Daytime (copy 2)');
    const named = await call('programmer', 'POST', `/clocks/${clockId}/duplicate`, {
      name: 'Weekend',
    });
    expect(named.json<ClockDetail>().name).toBe('Weekend');
    expect((await auditRows(copy.id)).map((a) => a.action)).toEqual(['clock.create']);
  });

  it('keeps a slot whose category or asset was deleted, with a warning', async () => {
    const partial = await call('programmer', 'POST', '/clocks', {
      name: 'Before the show',
      targetDurationMs: 40 * MIN,
      slots: [
        { kind: 'category', categoryId: ids.Empty },
        { kind: 'asset', assetId: ids.Sponsor },
      ],
    });
    expect(partial.statusCode).toBe(201);
    const id = partial.json<ClockDetail>().id;
    await call('programmer', 'DELETE', `/categories/${ids.Empty}`);
    await deleteAsset(t.tdb.db, { actor: system, scope }, ids.Sponsor as string);
    const body = (await call('programmer', 'GET', `/clocks/${id}`)).json<ClockDetail>();
    expect(body.slots.map((s) => [s.kind, 'categoryId' in s ? s.categoryId : s])).toEqual([
      ['category', null],
      ['asset', expect.objectContaining({ assetId: null })],
    ]);
    expect(body.estimate.warnings.map((w) => [w.code, w.slotIndex])).toEqual([
      ['under_target', undefined],
      ['missing_reference', 0],
      ['missing_reference', 1],
    ]);
  });

  it('lists clocks by name', async () => {
    const res = await call('programmer', 'GET', '/clocks');
    expect(res.statusCode).toBe(200);
    expect(res.json<ClockList>().items.map((c) => c.name)).toEqual([
      'Before the show',
      'Daytime',
      // The database's collation: punctuation weighs less than digits.
      'Daytime (copy 2)',
      'Daytime (copy)',
      'Weekend',
    ]);
  });

  it('checks permissions: presenters read nothing, outsiders see no station', async () => {
    expect((await call('presenter', 'GET', '/clocks')).statusCode).toBe(403);
    expect((await call('presenter', 'POST', '/clocks', { name: 'P' })).statusCode).toBe(403);
    expect((await call('outsider', 'GET', '/clocks')).statusCode).toBe(404);
    expect((await call('outsider', 'GET', `/clocks/${clockId}`)).statusCode).toBe(404);
  });

  it('keeps tenants apart', async () => {
    // Another station's category can't be used in a slot.
    const res = await call('programmer', 'PATCH', `/clocks/${clockId}`, {
      slots: [{ kind: 'category', categoryId: otherCategory }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unknown_category');
    const draft = await call('programmer', 'POST', '/clocks/preview', {
      slots: [{ kind: 'category', categoryId: otherCategory }],
    });
    expect(draft.json<ClockPreview>().items[0]?.asset).toBeNull();
    expect(draft.json<ClockPreview>().estimate.warnings).toContainEqual({
      code: 'missing_reference',
      slotIndex: 0,
    });

    // The other org's owner can't reach this clock through their own station either.
    const own = (path: string, method: 'GET' | 'PATCH' | 'DELETE' = 'GET', body?: object) =>
      call('outsider', method, path, body, otherScope.stationId);
    expect((await own(`/clocks/${clockId}`)).statusCode).toBe(404);
    expect((await own(`/clocks/${clockId}`, 'PATCH', { name: 'Stolen' })).statusCode).toBe(404);
    expect((await own(`/clocks/${clockId}`, 'DELETE')).statusCode).toBe(404);
    expect(
      (await call('outsider', 'POST', `/clocks/${clockId}/duplicate`, {}, otherScope.stationId))
        .statusCode,
    ).toBe(404);
  });

  it('deletes with an audit row', async () => {
    const res = await call('programmer', 'DELETE', `/clocks/${clockId}`);
    expect(res.statusCode).toBe(204);
    expect((await call('programmer', 'GET', `/clocks/${clockId}`)).statusCode).toBe(404);
    expect((await auditRows(clockId)).at(-1)?.action).toBe('clock.delete');
  });
});
