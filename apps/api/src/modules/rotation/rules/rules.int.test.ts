import {
  addMembership,
  asRunEntry,
  auditLog,
  createAsset,
  createOrganization,
  createStation,
  logDay,
  logItem,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
} from '@ondes/db';
import {
  type Actor,
  type CategoryDetail,
  DEFAULT_ROTATION_RULES,
  type PickResponse,
  type RotationRule,
  type RotationRulesSettings,
} from '@ondes/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, signUpAndLogin, type TestApp } from '../../auth/testing.ts';
import { pickSlots } from './repo.ts';

// The rotation rules API on the real app: rule settings (permissions, audit, validation) and
// picks against as-run history and planned log items, with tenant isolation.

const system: Actor = { type: 'system', name: 'test' };
const MINUTE = 60_000;

let t: TestApp;
let scope: StationScope;
let otherScope: StationScope;
let categoryId: string;
let otherCategoryId: string;
const cookies = { programmer: '', presenter: '', outsider: '' };
const ids: Record<string, string> = {};
const now = Date.now();

async function song(name: string, artists: string[]) {
  const created = await createAsset(
    t.tdb.db,
    { actor: system, scope },
    {
      type: 'song',
      title: name,
      artists,
      durationMs: 180_000,
    },
  );
  ids[name] = created.id;
}

function call(
  who: keyof typeof cookies,
  method: 'GET' | 'POST' | 'PUT',
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
  const org = await createOrganization(db, system, { slug: 'rules-org', name: 'Org' });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: 'rules-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(db, org.id, st.id);
  await song('Alpha', ['A']);
  await song('Bravo', ['B']);
  await song('Charlie', ['C']);

  const other = await createOrganization(db, system, { slug: 'rules-other', name: 'Other' });
  const otherOrgScope = await resolveOrgScope(db, other.id);
  const ost = await createStation(
    db,
    { actor: system, scope: otherOrgScope },
    { slug: 'rules-other-fm', name: 'Other FM', timezone: 'Europe/Paris' },
  );
  otherScope = await resolveStationScope(db, other.id, ost.id);

  for (const role of ['programmer', 'presenter'] as const) {
    const { userId, cookie } = await signUpAndLogin(t, `${role}@rules.test`);
    await addMembership(
      db,
      { actor: system, scope: orgScope },
      { level: 'station', stationId: st.id, userId, role },
    );
    cookies[role] = cookie;
  }
  const outsider = await signUpAndLogin(t, 'outsider@rules.test');
  await addMembership(
    db,
    { actor: system, scope: otherOrgScope },
    { level: 'org', userId: outsider.userId, role: 'owner' },
  );
  cookies.outsider = outsider.cookie;

  const created = await call('programmer', 'POST', '/categories', {
    name: 'All songs',
    members: ['Alpha', 'Bravo', 'Charlie'].map((n) => ({ assetId: ids[n], mode: 'include' })),
  });
  categoryId = created.json<CategoryDetail>().id;
  const otherCategory = await call(
    'outsider',
    'POST',
    '/categories',
    { name: 'Theirs' },
    otherScope.stationId,
  );
  otherCategoryId = otherCategory.json<CategoryDetail>().id;

  // Alpha aired 30 min ago; Bravo is planned 30 min from now.
  await db.insert(asRunEntry).values({
    orgId: scope.orgId,
    stationId: scope.stationId,
    eventId: crypto.randomUUID(),
    bootId: 'boot-1',
    seq: 1,
    source: 'log',
    kind: 'song',
    assetId: ids.Alpha,
    title: 'Alpha',
    artist: 'A',
    artists: ['A'],
    startedAt: new Date(now - 30 * MINUTE),
  });
  const [day] = await db
    .insert(logDay)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      localDate: '2099-01-01',
      startsAt: new Date(now - 12 * 60 * MINUTE),
      endsAt: new Date(now + 12 * 60 * MINUTE),
    })
    .returning();
  await db.insert(logItem).values({
    orgId: scope.orgId,
    stationId: scope.stationId,
    logDayId: day?.id as string,
    position: 0,
    kind: 'song',
    plannedStart: new Date(now + 30 * MINUTE),
    plannedDurationMs: 180_000,
    assetId: ids.Bravo,
    title: 'Bravo',
    originType: 'manual',
  });
}, 60_000);

afterAll(() => t?.close());

const at = (minutes: number) => new Date(now + minutes * MINUTE).toISOString();

describe('rule settings', () => {
  it('serves the defaults until the station saves its own', async () => {
    const res = await call('programmer', 'GET', '/rotation/rules');
    expect(res.statusCode).toBe(200);
    expect(res.json<RotationRulesSettings>()).toEqual({
      rules: DEFAULT_ROTATION_RULES,
      updatedAt: null,
    });
  });

  it('saves a rule set with an audit row, and validates it', async () => {
    const rules: RotationRule[] = [
      ...DEFAULT_ROTATION_RULES,
      {
        id: 'calm',
        enabled: true,
        priority: 8,
        breakable: true,
        kind: 'tag_run',
        tag: { key: 'energy', value: '1' },
        maxRun: 2,
      },
    ];
    const res = await call('programmer', 'PUT', '/rotation/rules', { rules });
    expect(res.statusCode).toBe(200);
    expect(res.json<RotationRulesSettings>().rules).toEqual(rules);
    expect((await call('programmer', 'GET', '/rotation/rules')).json().rules).toEqual(rules);

    const audit = await t.tdb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'rotation_rules.update'), eq(auditLog.entityId, scope.stationId)),
      );
    expect(audit).toHaveLength(1);

    const duplicate = await call('programmer', 'PUT', '/rotation/rules', {
      rules: [DEFAULT_ROTATION_RULES[0], DEFAULT_ROTATION_RULES[0]],
    });
    expect(duplicate.statusCode).toBe(400);
    const badKind = await call('programmer', 'PUT', '/rotation/rules', {
      rules: [{ id: 'x', enabled: true, priority: 1, breakable: true, kind: 'gender_balance' }],
    });
    expect(badKind.statusCode).toBe(400);

    await call('programmer', 'PUT', '/rotation/rules', { rules: DEFAULT_ROTATION_RULES });
  });

  it('checks permissions and tenancy', async () => {
    expect((await call('presenter', 'GET', '/rotation/rules')).statusCode).toBe(403);
    expect((await call('presenter', 'PUT', '/rotation/rules', { rules: [] })).statusCode).toBe(403);
    expect((await call('outsider', 'GET', '/rotation/rules')).statusCode).toBe(404);
    expect((await call('outsider', 'PUT', '/rotation/rules', { rules: [] })).statusCode).toBe(404);
    // The outsider's own station still has the defaults.
    const theirs = await call(
      'outsider',
      'GET',
      '/rotation/rules',
      undefined,
      otherScope.stationId,
    );
    expect(theirs.json<RotationRulesSettings>().updatedAt).toBeNull();
  });
});

describe('pick', () => {
  it('picks against what aired and what is planned, and explains every candidate', async () => {
    const res = await call('programmer', 'POST', '/rotation/pick', {
      slots: [{ categoryId, at: at(10) }],
      explain: true,
    });
    expect(res.statusCode).toBe(200);
    const [pick] = res.json<PickResponse>().picks;
    expect(pick?.asset?.id).toBe(ids.Charlie);
    expect(pick?.relaxed).toEqual([]);
    expect(pick?.unfilled).toBeNull();
    expect(pick?.candidates).toBe(3);
    const verdicts = Object.fromEntries(
      (pick?.ranked ?? []).map((r) => [r.title, r.violations.map((v) => v.kind).sort()]),
    );
    expect(verdicts).toEqual({
      Alpha: ['artist_separation', 'song_rest', 'title_separation'],
      Bravo: ['artist_separation', 'song_rest', 'title_separation'],
      Charlie: [],
    });
  });

  it('chains slots and relaxes by priority when nothing fits', async () => {
    const res = await call('programmer', 'POST', '/rotation/pick', {
      slots: [
        { categoryId, at: at(10) },
        { categoryId, at: at(14) },
      ],
    });
    const [first, second] = res.json<PickResponse>().picks;
    expect(first?.asset?.id).toBe(ids.Charlie);
    // Everyone rested too little: the ladder drops album, artist, depth, title, then rest.
    expect(second?.asset).not.toBeNull();
    expect(second?.relaxed.map((r) => r.rule)).toContain('song_rest');
    expect(second?.ranked).toBeUndefined();
  });

  it('tries draft rules and is deterministic', async () => {
    const body = { slots: [{ categoryId, at: at(10) }], rules: [], seed: 'x' };
    const a = (await call('programmer', 'POST', '/rotation/pick', body)).json<PickResponse>();
    const b = (await call('programmer', 'POST', '/rotation/pick', body)).json<PickResponse>();
    expect(a).toEqual(b);
    expect(a.picks[0]?.relaxed).toEqual([]);
    // No rules: least recently played, never-played first.
    expect([ids.Bravo, ids.Charlie]).toContain(a.picks[0]?.asset?.id);
  });

  it('counts unsaved picks passed in process (clock preview, log generator)', async () => {
    const result = await pickSlots(
      t.tdb.db,
      scope,
      { slots: [{ categoryId, at: at(10) }] },
      {
        history: [
          {
            assetId: ids.Charlie as string,
            type: 'song',
            title: 'Charlie',
            artists: ['C'],
            album: null,
            tags: [],
            at: new Date(now + 6 * MINUTE),
          },
        ],
      },
    );
    // Charlie, the only clean candidate otherwise, now rested too little: the ladder relaxes.
    expect(result.picks[0]?.relaxed.length).toBeGreaterThan(0);
  });

  it('never reaches another station', async () => {
    const theirs = await call('programmer', 'POST', '/rotation/pick', {
      slots: [{ categoryId: otherCategoryId, at: at(10) }],
    });
    expect(theirs.statusCode).toBe(404);
    const outsider = await call('outsider', 'POST', '/rotation/pick', {
      slots: [{ categoryId, at: at(10) }],
    });
    expect(outsider.statusCode).toBe(404);
    const across = await call(
      'outsider',
      'POST',
      '/rotation/pick',
      { slots: [{ categoryId, at: at(10) }] },
      otherScope.stationId,
    );
    expect(across.statusCode).toBe(404);
    expect((await call('presenter', 'POST', '/rotation/pick', { slots: [] })).statusCode).toBe(403);
  });
});
