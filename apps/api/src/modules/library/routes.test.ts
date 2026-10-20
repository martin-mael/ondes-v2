import { type Db, LibraryConflictError, NotFoundError, unsafeScope } from '@ondes/db';
import { describe, expect, it, vi } from 'vitest';
import {
  type LibraryDeps,
  type RouteRegistrar,
  type RouteReply,
  type RouteRequest,
  registerLibraryRoutes,
  toErrorResult,
} from './routes.ts';

const STATION_ID = '0199f6a0-0000-7000-8000-000000000001';
const ORG_ID = '0199f6a0-0000-7000-8000-000000000002';

type Handler = (request: RouteRequest, reply: RouteReply) => Promise<unknown>;

function mount(
  resolveContext = vi.fn(async () => ({
    actor: { type: 'system' as const, name: 'test' },
    scope: unsafeScope(ORG_ID, STATION_ID),
  })),
) {
  const routes = new Map<string, Handler>();
  const app: RouteRegistrar = {
    route: ({ method, url, handler }) => routes.set(`${method} ${url}`, handler),
  };
  // No query may reach the database in these tests.
  const db = new Proxy({} as Db, {
    get: () => {
      throw new Error('unexpected database access');
    },
  });
  const deps: LibraryDeps = { db, storage: { delete: vi.fn() } };
  registerLibraryRoutes(app, deps, resolveContext);
  const call = async (key: string, request: Partial<RouteRequest> = {}) => {
    const handler = routes.get(key);
    if (!handler) throw new Error(`no route ${key}`);
    const sent: { status?: number; body?: unknown } = {};
    const reply: RouteReply = {
      code(status) {
        sent.status = status;
        return reply;
      },
      send(body) {
        sent.body = body;
        return reply;
      },
    };
    await handler({ params: {}, query: {}, body: undefined, ...request }, reply);
    return sent;
  };
  return { routes, call, resolveContext };
}

describe('library routes', () => {
  it('mounts every route under the station prefix', () => {
    expect([...mount().routes.keys()].sort()).toEqual([
      'DELETE /api/v1/stations/:stationId/assets/:assetId',
      'GET /api/v1/stations/:stationId/assets',
      'GET /api/v1/stations/:stationId/assets/:assetId',
      'GET /api/v1/stations/:stationId/tags',
      'PATCH /api/v1/stations/:stationId/assets/:assetId',
      'PUT /api/v1/stations/:stationId/assets/:assetId/cues',
      'PUT /api/v1/stations/:stationId/assets/:assetId/tags',
    ]);
  });

  it('asks the auth layer for the right permission', async () => {
    const { call, resolveContext } = mount();
    await call('PATCH /api/v1/stations/:stationId/assets/:assetId', {
      params: { stationId: STATION_ID, assetId: 'nope' },
    });
    expect(resolveContext).toHaveBeenCalledWith(expect.anything(), {
      resource: 'library',
      action: 'write',
    });
  });

  it('rejects invalid input with 400 before touching the database', async () => {
    const { call } = mount();
    const badId = await call('GET /api/v1/stations/:stationId/assets/:assetId', {
      params: { stationId: STATION_ID, assetId: 'nope' },
    });
    expect(badId.status).toBe(400);
    const badBody = await call('PATCH /api/v1/stations/:stationId/assets/:assetId', {
      params: { stationId: STATION_ID, assetId: STATION_ID },
      body: {},
    });
    expect(badBody.status).toBe(400);
    const badCues = await call('PUT /api/v1/stations/:stationId/assets/:assetId/cues', {
      params: { stationId: STATION_ID, assetId: STATION_ID },
      body: { cueIn: { samples: 1.5 } },
    });
    expect(badCues.status).toBe(400);
  });

  it('returns 404 when the auth layer refuses the station', async () => {
    const { call } = mount(
      vi.fn(async () => {
        throw new NotFoundError('station', STATION_ID);
      }),
    );
    expect((await call('GET /api/v1/stations/:stationId/tags')).status).toBe(404);
  });

  it('maps domain errors and rethrows the rest', () => {
    expect(toErrorResult(new LibraryConflictError('x')).status).toBe(409);
    expect(toErrorResult(new NotFoundError('asset', 'a')).status).toBe(404);
    expect(() => toErrorResult(new Error('boom'))).toThrow('boom');
  });
});
