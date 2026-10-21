import { randomUUID } from 'node:crypto';
import { addMembership, createOrganization, createStation, resolveOrgScope } from '@ondes/db';
import type { Actor } from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, signUpAndLogin, type TestApp } from '../modules/auth/testing.ts';

// Auth guards run before validation (the `onRoute` hook in plugins/auth.ts): an anonymous or
// unauthorised caller gets 401/403/404, never a 400 describing the route's schema.

const system: Actor = { type: 'system', name: 'test' };
let t: TestApp;
let stationId: string;
let member: string;

beforeAll(async () => {
  t = await createTestApp();
  const org = await createOrganization(t.tdb.db, system, { slug: 'guard-org', name: 'Org' });
  const scope = await resolveOrgScope(t.tdb.db, org.id);
  stationId = (
    await createStation(
      t.tdb.db,
      { actor: system, scope },
      { slug: 'guard-fm', name: 'FM', timezone: 'Europe/Paris' },
    )
  ).id;
  const { userId, cookie } = await signUpAndLogin(t, 'guard@member.test');
  await addMembership(
    t.tdb.db,
    { actor: system, scope },
    { level: 'station', stationId, userId, role: 'programmer' },
  );
  member = cookie;
});
afterAll(() => t?.close());

describe('guard order', () => {
  it('answers 401 to an anonymous request with an invalid query', async () => {
    // GET /log needs `from` and `to`: without a session, that must not be the answer.
    const res = await t.app.inject({ method: 'GET', url: `/api/v1/stations/${stationId}/log` });
    expect(res.statusCode).toBe(401);
  });

  it('answers 401 to an anonymous request with an invalid body', async () => {
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/stations/${stationId}/assets/${randomUUID()}`,
      payload: { title: 42 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('answers 404 to a non-member before validating anything', async () => {
    const outsider = await signUpAndLogin(t, 'guard@outsider.test');
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/stations/${stationId}/log`,
      cookies: { ondes_session: outsider.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('still validates input for an authorised caller', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/stations/${stationId}/log`,
      cookies: { ondes_session: member },
    });
    expect(res.statusCode).toBe(400);
  });
});
