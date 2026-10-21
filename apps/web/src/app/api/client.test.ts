import { meSchema } from '@ondes/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, request, reviveDates } from './client.ts';

const reply = (status: number, body?: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status })),
  );

afterEach(() => vi.unstubAllGlobals());

const me = {
  user: {
    id: '01a15ddf-0000-7000-8000-000000000001',
    email: 'dj@vandale.test',
    name: 'Dj',
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-20T08:00:00.000+02:00',
  },
  emailVerified: true,
  twoFactorEnabled: false,
  memberships: [],
};

describe('request', () => {
  it('validates responses with the contract, reviving `…At` timestamps', async () => {
    reply(200, me);
    const result = await request('/auth/me', { schema: meSchema });
    expect(result.user.createdAt).toEqual(new Date('2026-10-20T08:00:00.000Z'));
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/auth/me',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('keeps ISO strings for contracts that type `…At` fields as strings', async () => {
    const at = '2026-10-20T08:00:00.000Z';
    reply(200, { startsAt: at });
    const iso = z.object({ startsAt: z.iso.datetime({ offset: true }) });
    expect(await request('/log', { schema: iso })).toEqual({ startsAt: at });
  });

  it('turns error bodies into ApiError with the stable code', async () => {
    reply(403, { error: 'two_factor_required', message: 'enable it', details: { orgId: 'x' } });
    const error = await request('/orgs/x/thing').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 403,
      code: 'two_factor_required',
      details: { orgId: 'x' },
    });
  });

  it('reports a body that breaks the contract', async () => {
    reply(200, { ...me, emailVerified: 'yes' });
    await expect(request('/auth/me', { schema: meSchema })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('reports network failures and non-JSON errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await expect(request('/auth/me')).rejects.toMatchObject({ status: 0, code: 'network' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })),
    );
    await expect(request('/auth/me')).rejects.toMatchObject({ status: 502, code: 'http_error' });
  });

  it('sends JSON bodies as POST', async () => {
    reply(204);
    await request('/auth/verify-email', { body: { token: 't' } });
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/auth/verify-email',
      expect.objectContaining({
        method: 'POST',
        body: '{"token":"t"}',
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
      }),
    );
  });
});

describe('reviveDates', () => {
  it('only touches ISO timestamps in `…At` fields', () => {
    expect(reviveDates('createdAt', '2026-10-20T08:00:00Z')).toBeInstanceOf(Date);
    expect(reviveDates('name', '2026-10-20T08:00:00Z')).toBe('2026-10-20T08:00:00Z');
    expect(reviveDates('playedAt', 'yesterday')).toBe('yesterday');
  });
});
