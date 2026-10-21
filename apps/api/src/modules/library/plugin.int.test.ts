import {
  addMembership,
  createAsset,
  createOrganization,
  createStation,
  resolveOrgScope,
  resolveStationScope,
} from '@ondes/db';
import type { Actor, Role } from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, signUpAndLogin, type TestApp } from '../auth/testing.ts';

// The library routes mounted on the real app (#17 on #6): auth, permission guard and tenant
// scope resolution in front of the handlers.

const system: Actor = { type: 'system', name: 'test' };
const deleted: string[] = [];

let t: TestApp;
let stationId: string;
let assetId: string;
const cookies: Partial<Record<Role | 'outsider', string>> = {};

beforeAll(async () => {
  t = await createTestApp({}, undefined, {
    storage: { delete: async (key: string) => void deleted.push(key) } as never,
  });
  const org = await createOrganization(t.tdb.db, system, { slug: 'lib-org', name: 'Org' });
  const orgScope = await resolveOrgScope(t.tdb.db, org.id);
  const st = await createStation(
    t.tdb.db,
    { actor: system, scope: orgScope },
    { slug: 'lib-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  stationId = st.id;
  const scope = await resolveStationScope(t.tdb.db, org.id, st.id);
  assetId = (
    await createAsset(t.tdb.db, { actor: system, scope }, { type: 'song', title: 'Mistral' })
  ).id;

  for (const role of ['programmer', 'presenter', 'viewer'] as const) {
    const { userId, cookie } = await signUpAndLogin(t, `${role}@lib.test`);
    await addMembership(
      t.tdb.db,
      { actor: system, scope: orgScope },
      { level: 'station', stationId, userId, role },
    );
    cookies[role] = cookie;
  }
  cookies.outsider = (await signUpAndLogin(t, 'outsider@lib.test')).cookie;
});
afterAll(() => t?.close());

function call(who: keyof typeof cookies, method: 'GET' | 'PATCH', url: string, payload?: object) {
  return t.app.inject({
    method,
    url: `/api/v1/stations/${stationId}${url}`,
    cookies: { ondes_session: cookies[who] ?? '' },
    ...(payload ? { payload } : {}),
  });
}

describe('library routes on the api', () => {
  it('lets a programmer read and edit assets', async () => {
    const list = await call('programmer', 'GET', '/assets');
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).toContain(assetId);
    const patch = await call('programmer', 'PATCH', `/assets/${assetId}`, {
      title: 'Mistral (edit)',
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ title: 'Mistral (edit)' });
  });

  it('lets a presenter read but not write', async () => {
    expect((await call('presenter', 'GET', `/assets/${assetId}`)).statusCode).toBe(200);
    expect(
      (await call('presenter', 'PATCH', `/assets/${assetId}`, { title: 'x' })).statusCode,
    ).toBe(403);
  });

  it('refuses a viewer, and hides the station from non-members', async () => {
    expect((await call('viewer', 'GET', '/assets')).statusCode).toBe(403);
    expect((await call('outsider', 'GET', '/assets')).statusCode).toBe(404);
  });

  it('requires a session', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/v1/stations/${stationId}/assets` });
    expect(res.statusCode).toBe(401);
  });
});
