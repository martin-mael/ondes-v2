import type { Me, MyOrg } from '@ondes/shared';
import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { App } from '../app.tsx';
import { createQueryClient } from '../errors.ts';

// Renders the whole app at a URL with a fake api: `routes` maps `METHOD /path` (below /api/v1)
// to a status and JSON body. Unmatched requests answer 404 so tests fail loudly.

export type ApiReply = [status: number, body?: unknown];
export type ApiRoute = ApiReply | ((body: unknown) => ApiReply);

export interface ApiCall {
  method: string;
  path: string;
  body: unknown;
}

export function renderApp(url: string, routes: Record<string, ApiRoute> = {}) {
  const calls: ApiCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(href, 'http://app.test').pathname.replace(/^\/api\/v1/, '');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const route = routes[`${method} ${path}`];
    const [status, json] = typeof route === 'function' ? route(body) : (route ?? [404]);
    return new Response(json === undefined ? null : JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  const queryClient = createQueryClient();
  const history = createMemoryHistory({ initialEntries: [url] });
  const user = userEvent.setup();
  render(<App queryClient={queryClient} history={history} locale="en" />);
  return { user, calls, history, queryClient, screen };
}

export const signedOut: Record<string, ApiRoute> = {
  'GET /auth/me': [401, { error: 'unauthenticated', message: 'sign in first' }],
};

const at = '2026-10-20T08:00:00.000Z';

export const me: Me = {
  user: {
    id: '01a15ddf-0000-7000-8000-000000000001',
    email: 'dj@vandale.test',
    name: 'Camille Dj',
    createdAt: new Date(at),
    updatedAt: new Date(at),
  },
  emailVerified: true,
  twoFactorEnabled: false,
  memberships: [],
};

export const orgs: MyOrg[] = [
  {
    id: '01a15ddf-0000-7000-8000-0000000000a1',
    slug: 'vandale',
    name: 'Vandale Radio',
    role: null,
    stations: [
      {
        id: '01a15ddf-0000-7000-8000-0000000000b1',
        slug: 'vandale-main',
        name: 'Vandale',
        timezone: 'Europe/Paris',
        role: 'presenter',
      },
      {
        id: '01a15ddf-0000-7000-8000-0000000000b2',
        slug: 'vandale-nuit',
        name: 'Vandale Nuit',
        timezone: 'America/Montreal',
        role: 'viewer',
      },
    ],
  },
];

export const stationId = orgs[0]?.stations[0]?.id ?? '';

export const signedIn = (overrides: Partial<Me> = {}): Record<string, ApiRoute> => ({
  'GET /auth/me': [200, { ...me, ...overrides }],
  'GET /orgs': [200, { orgs }],
});
