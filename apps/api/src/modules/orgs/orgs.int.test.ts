import { addMembership, createOrganization, createStation, unsafeScope } from '@ondes/db';
import type { Actor } from '@ondes/shared';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cookieHeader, createTestApp, signUpAndLogin, type TestApp } from '../auth/testing.ts';

const system: Actor = { type: 'system', name: 'test' };
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());

it('lists the orgs and stations the user can open, with their role', async () => {
  const db = t.tdb.db;
  const radio = await createOrganization(db, system, { slug: 'radio', name: 'Radio' });
  const ctx = { actor: system, scope: unsafeScope(radio.id) };
  const tz = 'Europe/Paris';
  const a = await createStation(db, ctx, { slug: 'st-a', name: 'A', timezone: tz });
  await createStation(db, ctx, { slug: 'st-b', name: 'B', timezone: tz });
  const other = await createOrganization(db, system, { slug: 'other', name: 'Other' });

  const owner = await signUpAndLogin(t, 'owner@orgs.test');
  await addMembership(db, ctx, { level: 'org', userId: owner.userId, role: 'owner' });
  const presenter = await signUpAndLogin(t, 'presenter@orgs.test');
  await addMembership(db, ctx, {
    level: 'station',
    userId: presenter.userId,
    stationId: a.id,
    role: 'presenter',
  });
  const nobody = await signUpAndLogin(t, 'nobody@orgs.test');

  const list = async (cookie: string) => {
    const res = await t.app.inject({ url: '/api/v1/orgs', headers: cookieHeader(cookie) });
    expect(res.statusCode).toBe(200);
    return res.json().orgs;
  };
  const ownerOrgs = await list(owner.cookie);
  expect(ownerOrgs).toEqual([
    expect.objectContaining({ id: radio.id, role: 'owner', stations: expect.any(Array) }),
  ]);
  expect(
    ownerOrgs[0].stations.map((s: { name: string; role: string }) => [s.name, s.role]),
  ).toEqual([
    ['A', 'owner'],
    ['B', 'owner'],
  ]);
  expect(await list(presenter.cookie)).toEqual([
    {
      id: radio.id,
      slug: 'radio',
      name: 'Radio',
      role: null,
      stations: [{ id: a.id, slug: 'st-a', name: 'A', timezone: tz, role: 'presenter' }],
    },
  ]);
  expect(await list(nobody.cookie)).toEqual([]);
  expect(ownerOrgs.some((o: { id: string }) => o.id === other.id)).toBe(false);
  expect((await t.app.inject({ url: '/api/v1/orgs' })).statusCode).toBe(401);
});
