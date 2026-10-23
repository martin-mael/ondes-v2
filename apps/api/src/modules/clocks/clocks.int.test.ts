import {
  addMembership,
  auditLog,
  clockSlot,
  createApiKey,
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
import type { PickSlotsFn } from './preview.ts';
import { findPickSlots } from './preview.ts';
import { loadClock, previewDraft, updateClock } from './repo.ts';

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
/** A station API key with `clock:read` only: the read-only principal. */
let readOnlyKey: string;

async function asset(name: string, input: Partial<CreateAsset>) {
  const created = await createAsset(
    t.tdb.db,
    { actor: system, scope },
    { type: 'song', title: name, artists: [name], ...input },
  );
  ids[name] = created.id;
  return created.id;
}

function readOnly(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  return t.app.inject({
    method,
    url: `/api/v1/stations/${scope.stationId}${url}`,
    headers: { authorization: `Bearer ${readOnlyKey}` },
    ...(payload ? { payload } : {}),
  });
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
  readOnlyKey = (
    await createApiKey(
      db,
      { actor: system, scope: orgScope },
      { name: 'read only', stationId: st.id, scopes: ['clock:read'] },
    )
  ).token;

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
  let version: number;

  it('creates a clock with its slots, an estimate and an audit row', async () => {
    const res = await call('programmer', 'POST', '/clocks', {
      name: 'Daytime',
      color: '#3366ff',
      slots: hour(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<ClockDetail>();
    clockId = body.id;
    version = body.version;
    expect(body).toMatchObject({ name: 'Daytime', targetDurationMs: 60 * MIN, version: 1 });
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
    // The sponsor is an `other` asset, which the log can't place.
    expect(body.estimate.warnings).toEqual([
      { code: 'unsupported_asset_type', slotIndex: 9 },
      { code: 'gap', slotIndex: 11, ms: 50_000 },
    ]);

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
      version,
      slots: slots as object[],
      description: 'Weekday daytime',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ClockDetail>();
    expect(body.description).toBe('Weekday daytime');
    expect(body.version).toBe(version + 1);
    version = body.version;
    // 30:00 + 9 songs × 4 min = 66:00.
    expect(body.estimate.totalMs).toBe(66 * MIN);
    expect(body.estimate.warnings).toContainEqual({ code: 'over_target', ms: 6 * MIN });

    const update = (await auditRows(clockId)).at(-1);
    expect(update?.action).toBe('clock.update');
    expect(Object.keys(update?.diff ?? {}).sort()).toEqual(['description', 'slots', 'version']);
  });

  it('refuses an edit based on an older version, saving nothing', async () => {
    const res = await call('programmer', 'PATCH', `/clocks/${clockId}`, {
      version: version - 1,
      name: 'Stale',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'edit_conflict', details: { version } });
    expect((await loadClock(t.tdb.db, scope, clockId)).name).toBe('Daytime');
  });

  it('serialises two saves of the same version: one wins, the other conflicts', async () => {
    const ctx = { actor: system, scope };
    const slots = (await loadClock(t.tdb.db, scope, clockId)).slots;
    const results = await Promise.allSettled([
      updateClock(t.tdb.db, ctx, clockId, { version, slots, description: 'A' }),
      updateClock(t.tdb.db, ctx, clockId, { version, slots, description: 'B' }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
      code: 'edit_conflict',
    });
    const saved = await loadClock(t.tdb.db, scope, clockId);
    expect(saved.version).toBe(version + 1);
    expect(saved.slots).toEqual(slots);
    version = saved.version;
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
    // #38's rules engine when this build has it, random picks otherwise.
    const source = (await findPickSlots()) ? 'rules' : 'random';
    const songs = body.items.filter((i) => i.kind === 'category');
    expect(songs.every((i) => i.source === source && i.asset?.type === 'song')).toBe(true);
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

  it('picks at random without the rules engine: no repeats until the category is used up', async () => {
    const preview = await previewDraft(
      t.tdb.db,
      scope,
      { slots: hour(), seed: 'abc' },
      { pickSlots: null },
    );
    const songs = preview.items.filter((i) => i.kind === 'category');
    expect(songs.every((i) => i.source === 'random')).toBe(true);
    // Four songs in the category.
    expect(new Set(songs.slice(0, 4).map((i) => i.asset?.id)).size).toBe(4);
    expect(songs[4]?.relaxedRules).toEqual(['no_repeat_in_hour']);
    // The fill isn't a pick: it stretches to the end of the hour.
    expect(preview.items[18]).toMatchObject({ kind: 'fill', asset: null, source: null });
    const end = preview.items[18];
    expect((end?.startMs ?? 0) + (end?.durationMs ?? 0)).toBe(60 * MIN);
  });

  it('asks the rules engine for the hour, at the estimated times, with the fixed items', async () => {
    const calls: Parameters<PickSlotsFn>[] = [];
    const pickSlots: PickSlotsFn = async (...args) => {
      calls.push(args);
      return {
        picks: args[2].slots.map((s) => ({
          asset:
            s.categoryId === ids.Gold
              ? {
                  id: ids['Song B'] as string,
                  title: 'Song B',
                  artists: ['Song B'],
                  durationMs: 5 * MIN,
                }
              : null,
          relaxed: [{ rule: 'artist_separation' }],
        })),
      };
    };
    const airsAt = new Date('2026-10-25T09:00:00Z');
    const preview = await previewDraft(
      t.tdb.db,
      scope,
      {
        at: airsAt,
        seed: 's1',
        slots: [
          { kind: 'jingle', categoryId: ids.IDs },
          { kind: 'asset', assetId: ids.Sponsor },
          { kind: 'marker', offsetMs: 5 * MIN, timing: 'hard' },
          { kind: 'category', categoryId: ids.Gold },
          { kind: 'fill', categoryId: ids.Gold },
        ],
      },
      { pickSlots },
    );
    expect(calls).toHaveLength(1);
    const [, callScope, input, options] = calls[0] as Parameters<PickSlotsFn>;
    expect(callScope).toEqual(scope);
    // Air times from the clock's estimate: the ID at :00, the song after the :05 marker. The
    // fill isn't picked.
    expect(input).toEqual({
      seed: 's1',
      slots: [
        { categoryId: ids.IDs, at: airsAt.toISOString() },
        { categoryId: ids.Gold, at: new Date(airsAt.getTime() + 5 * MIN).toISOString() },
      ],
    });
    expect(options?.history).toEqual([
      expect.objectContaining({
        assetId: ids.Sponsor,
        type: 'other',
        at: new Date(airsAt.getTime() + 10_000),
      }),
    ]);
    expect(preview.items.map((i) => [i.kind, i.source, i.asset?.title ?? null])).toEqual([
      ['jingle', null, null],
      ['asset', 'fixed', 'Sponsor'],
      ['marker', null, null],
      ['category', 'rules', 'Song B'],
      ['fill', null, null],
    ]);
    expect(preview.items[0]?.problem).toBe('empty_category');
    expect(preview.items[3]).toMatchObject({
      relaxedRules: ['artist_separation'],
      startMs: 5 * MIN,
      durationMs: 5 * MIN,
    });
  });

  it('times a partial clock with markers', async () => {
    const res = await call('programmer', 'POST', '/clocks/estimate', {
      targetDurationMs: 40 * MIN,
      slots: [
        { kind: 'category', categoryId: ids.Gold },
        { kind: 'fill' },
        { kind: 'marker', offsetMs: 20 * MIN, timing: 'hard', label: 'News' },
        { kind: 'asset', assetId: ids.Sponsor },
        { kind: 'category', categoryId: ids.Gold },
        { kind: 'marker', offsetMs: 40 * MIN, timing: 'soft', capMs: MIN },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ClockEstimate>();
    expect(body.slots.map((s) => s.startMs / 1000)).toEqual([0, 240, 1200, 1200, 1230, 2400]);
    expect(body.slots[1]).toMatchObject({ durationMs: 16 * MIN, source: 'fill' });
    // 15:30 of silence before the soft marker at the end; the sponsor is of type `other`.
    expect(body.warnings).toEqual([
      { code: 'unsupported_asset_type', slotIndex: 3 },
      { code: 'gap', slotIndex: 5, ms: 930_000 },
    ]);
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
    const names = res.json<ClockList>().items.map((c) => c.name);
    // By name; the database collation decides how "(copy)" and "(copy 2)" compare.
    expect(names.slice(0, 2)).toEqual(['Before the show', 'Daytime']);
    expect(names.slice(2).sort()).toEqual(['Daytime (copy 2)', 'Daytime (copy)', 'Weekend'].sort());
    expect(names.at(-1)).toBe('Weekend');
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
      version,
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
    expect((await own(`/clocks/${clockId}`, 'PATCH', { version, name: 'Stolen' })).statusCode).toBe(
      404,
    );
    expect((await own(`/clocks/${clockId}`, 'DELETE')).statusCode).toBe(404);
    expect(
      (await call('outsider', 'POST', `/clocks/${clockId}/duplicate`, {}, otherScope.stationId))
        .statusCode,
    ).toBe(404);
  });

  it('never stores a category on a placeholder voice track, even another station one', async () => {
    const res = await call('programmer', 'PATCH', `/clocks/${clockId}`, {
      version,
      slots: [{ kind: 'vt', mode: 'placeholder', categoryId: otherCategory }],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ClockDetail>();
    version = body.version;
    expect(body.slots).toEqual([
      { kind: 'vt', mode: 'placeholder', categoryId: null, label: null, durationMs: null },
    ]);
    const rows = await t.tdb.db
      .select({ categoryId: clockSlot.categoryId })
      .from(clockSlot)
      .where(eq(clockSlot.clockId, clockId));
    expect(rows).toEqual([{ categoryId: null }]);
    // As a promo, the same category is checked and refused.
    const promo = await call('programmer', 'PATCH', `/clocks/${clockId}`, {
      version,
      slots: [{ kind: 'vt', mode: 'promo', categoryId: otherCategory }],
    });
    expect(promo.statusCode).toBe(400);
    expect(promo.json().error).toBe('unknown_category');
  });

  it('stores a promo slot’s VT pool (#60), checked against the station', async () => {
    const pool = await call('programmer', 'POST', '/vt-pools', { name: 'Clock pool' });
    expect(pool.statusCode, pool.body).toBe(201);
    const poolId = pool.json().id as string;
    const res = await call('programmer', 'PATCH', `/clocks/${clockId}`, {
      version,
      slots: [{ kind: 'vt', mode: 'promo', poolId }],
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<ClockDetail>();
    version = body.version;
    expect(body.slots).toEqual([
      { kind: 'vt', mode: 'promo', poolId, categoryId: null, label: null, durationMs: null },
    ]);
    expect(body.estimate.slots[0]).toEqual({ startMs: 0, durationMs: 0, source: 'default' });
    expect(body.estimate.warnings.some((w) => w.code === 'missing_reference')).toBe(false);
    const unknown = await call('programmer', 'PATCH', `/clocks/${clockId}`, {
      version,
      slots: [{ kind: 'vt', mode: 'promo', poolId: crypto.randomUUID() }],
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe('unknown_pool');
    // Deleting the pool leaves the slot without it, and a warning.
    expect((await call('programmer', 'DELETE', `/vt-pools/${poolId}`)).statusCode).toBe(204);
    const after = (await call('programmer', 'GET', `/clocks/${clockId}`)).json<ClockDetail>();
    expect(after.slots[0]).not.toHaveProperty('poolId');
    expect(after.estimate.warnings).toContainEqual({ code: 'missing_reference', slotIndex: 0 });
  });

  it('lets a read-only principal read and preview, never write', async () => {
    expect((await readOnly('GET', '/clocks')).statusCode).toBe(200);
    expect((await readOnly('GET', `/clocks/${clockId}`)).statusCode).toBe(200);
    expect((await readOnly('POST', '/clocks/estimate', { slots: [] })).statusCode).toBe(200);
    expect((await readOnly('POST', '/clocks/preview', { slots: [] })).statusCode).toBe(200);
    const writes = [
      await readOnly('POST', '/clocks', { name: 'RO' }),
      await readOnly('PATCH', `/clocks/${clockId}`, { version, name: 'RO' }),
      await readOnly('PATCH', `/clocks/${clockId}`, { version, slots: [] }),
      await readOnly('POST', `/clocks/${clockId}/duplicate`, {}),
      await readOnly('DELETE', `/clocks/${clockId}`),
    ];
    expect(writes.map((r) => r.statusCode)).toEqual([403, 403, 403, 403, 403]);
    expect((await loadClock(t.tdb.db, scope, clockId)).version).toBe(version);
  });

  it('deletes with an audit row', async () => {
    const res = await call('programmer', 'DELETE', `/clocks/${clockId}`);
    expect(res.statusCode).toBe(204);
    expect((await call('programmer', 'GET', `/clocks/${clockId}`)).statusCode).toBe(404);
    expect((await auditRows(clockId)).at(-1)?.action).toBe('clock.delete');
  });
});
