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
  setAssetTags,
} from '@ondes/db';
import type {
  Actor,
  CategoryDetail,
  CategoryList,
  CategoryPreview,
  CategoryRule,
  CreateAsset,
  SetAssetTags,
} from '@ondes/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, signUpAndLogin, type TestApp } from '../auth/testing.ts';
import { resolveCategoryMembers } from './repo.ts';

// The categories API on the real app: permissions, tenant isolation, audit, and previews
// that follow tag edits.

const system: Actor = { type: 'system', name: 'test' };

let t: TestApp;
let scope: StationScope;
let otherScope: StationScope;
const cookies = { programmer: '', presenter: '', outsider: '' };
const ids: Record<string, string> = {};
let otherAsset: string;

const houseEnergetic: CategoryRule = {
  kind: 'group',
  match: 'all',
  children: [
    { kind: 'tag', key: 'style', op: 'any', values: ['house'] },
    { kind: 'tag_number', key: 'energy', op: 'gte', value: 3 },
  ],
};

async function song(name: string, input: Partial<CreateAsset>, tags: SetAssetTags['tags']) {
  const ctx = { actor: system, scope };
  const created = await createAsset(t.tdb.db, ctx, {
    type: 'song',
    title: name,
    durationMs: 180_000,
    ...input,
  });
  if (tags.length > 0) await setAssetTags(t.tdb.db, ctx, created.id, { tags });
  ids[name] = created.id;
}

beforeAll(async () => {
  t = await createTestApp();
  const db = t.tdb.db;
  const org = await createOrganization(db, system, { slug: 'rot-org', name: 'Org' });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: 'rot-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(db, org.id, st.id);

  await song('Alpha', { artists: ['A'] }, [
    { key: 'style', value: 'House' },
    { key: 'energy', value: '4' },
  ]);
  await song('Bravo', { artists: ['B'] }, [
    { key: 'style', value: 'house' },
    { key: 'energy', value: '2' },
  ]);
  await song('Charlie', { artists: ['C'] }, [{ key: 'style', value: 'techno' }]);
  await song('Delta', { artists: ['D'], startAt: new Date('2099-01-01T00:00:00Z') }, [
    { key: 'style', value: 'house' },
    { key: 'energy', value: '5' },
  ]);
  await song('Echo', { artists: ['E'], type: 'jingle' }, [{ key: 'style', value: 'house' }]);

  const other = await createOrganization(db, system, { slug: 'rot-other', name: 'Other' });
  const otherOrgScope = await resolveOrgScope(db, other.id);
  const ost = await createStation(
    db,
    { actor: system, scope: otherOrgScope },
    { slug: 'rot-other-fm', name: 'Other FM', timezone: 'Europe/Paris' },
  );
  otherScope = await resolveStationScope(db, other.id, ost.id);
  const x = await createAsset(
    db,
    { actor: system, scope: otherScope },
    { type: 'song', title: 'X' },
  );
  await setAssetTags(db, { actor: system, scope: otherScope }, x.id, {
    tags: [
      { key: 'style', value: 'house' },
      { key: 'energy', value: '5' },
    ],
  });
  otherAsset = x.id;

  for (const role of ['programmer', 'presenter'] as const) {
    const { userId, cookie } = await signUpAndLogin(t, `${role}@rot.test`);
    await addMembership(
      db,
      { actor: system, scope: orgScope },
      { level: 'station', stationId: st.id, userId, role },
    );
    cookies[role] = cookie;
  }
  const outsider = await signUpAndLogin(t, 'outsider@rot.test');
  await addMembership(
    db,
    { actor: system, scope: otherOrgScope },
    { level: 'org', userId: outsider.userId, role: 'owner' },
  );
  cookies.outsider = outsider.cookie;
}, 60_000);

afterAll(() => t?.close());

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

async function auditRows(entityId: string) {
  return t.tdb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'category'), eq(auditLog.entityId, entityId)))
    .orderBy(asc(auditLog.at));
}

describe('categories API', () => {
  let categoryId: string;

  it('creates a smart category with defaults, counts and an audit row', async () => {
    const res = await call('programmer', 'POST', '/categories', {
      name: 'House power',
      color: '#ff8800',
      rule: houseEnergetic,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<CategoryDetail>();
    categoryId = body.id;
    expect(body).toMatchObject({
      name: 'House power',
      assetType: 'song',
      rotationOrder: 'least_recently_played',
      searchDepthPercent: 100,
      restMinutes: 180,
      maxPlaysPerDay: null,
      members: [],
      // Alpha and Delta (not yet schedulable); Bravo is too calm, Echo is a jingle.
      counts: { members: 2, schedulable: 1, ruleMatches: 2, manualOnly: 0, excluded: 0 },
    });

    const audit = await auditRows(categoryId);
    expect(audit.map((a) => a.action)).toEqual(['category.create']);
    expect(audit[0]?.stationId).toBe(scope.stationId);
    expect(audit[0]?.diff).toMatchObject({ name: { from: null, to: 'House power' } });
  });

  it('refuses a duplicate name, case-insensitively', async () => {
    const res = await call('programmer', 'POST', '/categories', { name: 'HOUSE POWER' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('category_name_taken');
  });

  it('validates the rule', async () => {
    const res = await call('programmer', 'POST', '/categories', {
      name: 'Bad',
      rule: { kind: 'group', match: 'all', children: [{ kind: 'tag', key: 'nope', values: [] }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('previews members in artist order, with turnover', async () => {
    const res = await call(
      'programmer',
      'GET',
      `/categories/${categoryId}/preview?playsPerDay=2&limit=10`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json<CategoryPreview>();
    expect(body.items.map((i) => [i.title, i.source, i.schedulable])).toEqual([
      ['Alpha', 'rule', true],
      ['Delta', 'rule', false],
    ]);
    // One schedulable song, two plays a day.
    expect(body.turnoverDays).toBe(0.5);
  });

  it('follows tag edits without touching the category', async () => {
    const ctx = { actor: system, scope };
    await setAssetTags(t.tdb.db, ctx, ids.Bravo as string, {
      tags: [
        { key: 'style', value: 'house' },
        { key: 'energy', value: '3' },
      ],
    });
    const res = await call('programmer', 'GET', `/categories/${categoryId}`);
    expect(res.json<CategoryDetail>().counts.members).toBe(3);
    await setAssetTags(t.tdb.db, ctx, ids.Bravo as string, { tags: [] });
    const after = await call('programmer', 'GET', `/categories/${categoryId}`);
    expect(after.json<CategoryDetail>().counts.members).toBe(2);
  });

  it('applies manual includes and excludes, audited with the members diff', async () => {
    const members = [
      { assetId: ids.Charlie, mode: 'include' },
      { assetId: ids.Delta, mode: 'exclude' },
      { assetId: ids.Echo, mode: 'include' },
    ];
    const res = await call('programmer', 'PATCH', `/categories/${categoryId}`, {
      members,
      restMinutes: 240,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<CategoryDetail>();
    expect(body.restMinutes).toBe(240);
    expect(body.members).toEqual(members);
    expect(body.counts).toMatchObject({ members: 2, manualOnly: 1, excluded: 1, ruleMatches: 2 });

    const preview = (
      await call('programmer', 'GET', `/categories/${categoryId}/preview`)
    ).json<CategoryPreview>();
    expect(preview.items.map((i) => [i.title, i.source])).toEqual([
      ['Alpha', 'rule'],
      ['Charlie', 'manual'],
    ]);
    expect(preview.manual.map((i) => [i.title, i.mode, i.effect])).toEqual([
      ['Charlie', 'include', 'added'],
      ['Delta', 'exclude', 'excluded'],
      ['Echo', 'include', 'wrong_type'],
    ]);

    const update = (await auditRows(categoryId)).at(-1);
    expect(update?.action).toBe('category.update');
    expect(Object.keys(update?.diff ?? {}).sort()).toEqual(['members', 'restMinutes']);
  });

  it('agrees with the resolver used by schedulers', async () => {
    const membership = await resolveCategoryMembers(t.tdb.db, scope, categoryId, new Date());
    const preview = (
      await call('programmer', 'GET', `/categories/${categoryId}/preview?limit=500`)
    ).json<CategoryPreview>();
    expect(preview.items.map((i) => i.assetId)).toEqual(membership.members.map((m) => m.asset.id));
    expect(preview.counts).toEqual(membership.counts);
  });

  it('drops a deleted asset from the members', async () => {
    await deleteAsset(t.tdb.db, { actor: system, scope }, ids.Charlie as string);
    const body = (
      await call('programmer', 'GET', `/categories/${categoryId}`)
    ).json<CategoryDetail>();
    expect(body.members.map((m) => m.assetId)).not.toContain(ids.Charlie);
    expect(body.counts.members).toBe(1);
  });

  it('previews a draft without saving it', async () => {
    const res = await call('programmer', 'POST', '/categories/preview', {
      rule: { kind: 'group', match: 'any', children: [houseEnergetic.children[0]] },
      members: [{ assetId: ids.Alpha, mode: 'exclude' }],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<CategoryPreview>();
    // Bravo lost its tags above; Echo is a jingle.
    expect(body.items.map((i) => i.title)).toEqual(['Delta']);
    expect(body.counts).toMatchObject({ members: 1, excluded: 1, ruleMatches: 2 });
  });

  it('lists categories with their counts', async () => {
    await call('programmer', 'POST', '/categories', {
      name: 'Jingles',
      assetType: 'jingle',
      members: [{ assetId: ids.Echo, mode: 'include' }],
    });
    const res = await call('programmer', 'GET', '/categories');
    expect(res.statusCode).toBe(200);
    expect(res.json<CategoryList>().items.map((c) => [c.name, c.counts.members])).toEqual([
      ['House power', 1],
      ['Jingles', 1],
    ]);
  });

  it('checks permissions: presenters read nothing, outsiders see no station', async () => {
    expect((await call('presenter', 'GET', '/categories')).statusCode).toBe(403);
    expect((await call('presenter', 'POST', '/categories', { name: 'P' })).statusCode).toBe(403);
    // Another tenant's station is reported as not found, never as forbidden.
    expect((await call('outsider', 'GET', '/categories')).statusCode).toBe(404);
    expect((await call('outsider', 'GET', `/categories/${categoryId}`)).statusCode).toBe(404);
  });

  it('keeps tenants apart', async () => {
    // Another station's asset can't be a member, nor show up in a preview.
    const res = await call('programmer', 'PATCH', `/categories/${categoryId}`, {
      members: [{ assetId: otherAsset, mode: 'include' }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unknown_asset');
    const preview = (
      await call('programmer', 'POST', '/categories/preview', { rule: houseEnergetic })
    ).json<CategoryPreview>();
    expect(preview.items.map((i) => i.assetId)).not.toContain(otherAsset);

    // The other org's owner can't reach this category through their own station either.
    const owner = await call(
      'outsider',
      'GET',
      `/categories/${categoryId}`,
      undefined,
      otherScope.stationId,
    );
    expect(owner.statusCode).toBe(404);
    const patch = await call(
      'outsider',
      'PATCH',
      `/categories/${categoryId}`,
      { name: 'Stolen' },
      otherScope.stationId,
    );
    expect(patch.statusCode).toBe(404);
  });

  it('deletes with an audit row', async () => {
    const res = await call('programmer', 'DELETE', `/categories/${categoryId}`);
    expect(res.statusCode).toBe(204);
    expect((await call('programmer', 'GET', `/categories/${categoryId}`)).statusCode).toBe(404);
    expect((await auditRows(categoryId)).at(-1)?.action).toBe('category.delete');
  });
});
