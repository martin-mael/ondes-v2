import { randomBytes } from 'node:crypto';
import {
  createAsset,
  createOrganization,
  createPostgresQuotaStore,
  createStation,
  putAssetFile,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import type { Actor, AssetDetail } from '@ondes/shared';
import { contentKey } from '@ondes/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LibraryDeps, libraryRoutes, type RouteRequest, runRoute } from './routes.ts';

// End to end through the route handlers, against a throwaway database. The auth layer is
// stubbed: it resolves `:stationId` within the caller's org, as #6's will after its checks.

const system: Actor = { type: 'system', name: 'test' };
const user: Actor = { type: 'user', userId: '0199f6a0-0000-7000-8000-00000000000a' };

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(() => tdb?.drop());

let n = 0;
async function tenant() {
  n++;
  const org = await createOrganization(tdb.db, system, { slug: `org-${n}`, name: 'Org' });
  const orgScope = await resolveOrgScope(tdb.db, org.id);
  const st = await createStation(
    tdb.db,
    { actor: system, scope: orgScope },
    { slug: `fm-${n}`, name: 'FM', timezone: 'Europe/Paris' },
  );
  return { orgId: org.id, scope: await resolveStationScope(tdb.db, org.id, st.id) };
}

function client(orgId: string) {
  const deleted: string[] = [];
  const deps: LibraryDeps = {
    db: tdb.db,
    storage: { delete: async (key) => void deleted.push(key) },
  };
  const call = (method: string, url: string, request: Partial<RouteRequest> = {}) => {
    const route = libraryRoutes.find((r) => r.method === method && r.url.endsWith(url));
    if (!route) throw new Error(`no route ${method} ${url}`);
    const params = (request.params ?? {}) as { stationId: string };
    return runRoute(
      route,
      deps,
      async () => ({
        actor: user,
        scope: await resolveStationScope(tdb.db, orgId, params.stationId),
      }),
      { params, query: {}, body: undefined, ...request },
    );
  };
  return { call, deleted };
}

async function seedAsset(scope: StationScope) {
  return createAsset(tdb.db, { actor: system, scope }, { type: 'song', title: 'Mistral' });
}

describe('library api', () => {
  it('reads, edits and deletes an asset of the caller station', async () => {
    const { orgId, scope } = await tenant();
    const { call, deleted } = client(orgId);
    const a = await seedAsset(scope);
    const sha256 = randomBytes(32).toString('hex');
    const key = contentKey({ orgId, sha256, ext: 'flac' });
    await putAssetFile(tdb.db, { delete: async () => {} }, { actor: system, scope }, a.id, {
      role: 'playout',
      storageKey: key,
      sha256,
      sizeBytes: 1234,
      codec: 'flac',
      sampleRate: 44_100,
      flacBlockSize: 1024,
    });
    const params = { stationId: scope.stationId, assetId: a.id };

    const list = await call('GET', '/assets', { params, query: { q: 'mist', limit: '10' } });
    expect(list.status).toBe(200);
    expect((list.body as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([a.id]);

    const patched = await call('PATCH', '/assets/:assetId', {
      params,
      body: { artists: ['Nina'], killAt: '2027-01-01T00:00:00Z' },
    });
    expect(patched.status).toBe(200);

    expect(
      (await call('PUT', '/assets/:assetId/cues', { params, body: { cueIn: { samples: 10 } } }))
        .status,
    ).toBe(409);
    const cues = await call('PUT', '/assets/:assetId/cues', {
      params,
      body: { sampleRate: 44_100, cueIn: { samples: 2048, locked: true } },
    });
    expect(cues.status).toBe(200);

    const tags = await call('PUT', '/assets/:assetId/tags', {
      params,
      body: { tags: [{ key: 'genre', value: 'Jazz' }] },
    });
    expect(tags.body).toEqual({ tags: [expect.objectContaining({ key: 'genre', value: 'Jazz' })] });
    expect((await call('GET', '/tags', { params })).body).toEqual(tags.body);

    const detail = (await call('GET', '/assets/:assetId', { params })).body as AssetDetail;
    expect(detail.artists).toEqual(['Nina']);
    expect(detail.files.map((f) => f.flacBlockSize)).toEqual([1024]);
    expect(detail.cues?.cueIn).toEqual({ samples: 2048, source: 'manual', locked: true });

    expect((await call('DELETE', '/assets/:assetId', { params })).status).toBe(204);
    expect(deleted).toEqual([key]);
    expect((await createPostgresQuotaStore(tdb.db).get(orgId)).usedBytes).toBe(0);
    expect((await call('GET', '/assets/:assetId', { params })).status).toBe(404);

    const actions = await tdb.sql<{ action: string; actor_id: string }[]>`
      select action, actor_id from audit_log where entity_id = ${a.id} order by at, id`;
    expect(actions.filter((r) => r.actor_id === user.userId).map((r) => r.action)).toEqual([
      'asset.update',
      'asset_cues.update',
      'asset.tag',
      'asset.delete',
    ]);
  });

  it("returns 404 for another tenant's asset", async () => {
    const mine = await tenant();
    const theirs = await tenant();
    const a = await seedAsset(theirs.scope);
    const { call } = client(mine.orgId);

    // Their asset id under my station.
    const params = { stationId: mine.scope.stationId, assetId: a.id };
    expect((await call('GET', '/assets/:assetId', { params })).status).toBe(404);
    expect((await call('PATCH', '/assets/:assetId', { params, body: { title: 'x' } })).status).toBe(
      404,
    );
    expect((await call('DELETE', '/assets/:assetId', { params })).status).toBe(404);
    // Their station id: the stubbed auth layer refuses it.
    const theirParams = { stationId: theirs.scope.stationId, assetId: a.id };
    expect((await call('GET', '/assets/:assetId', { params: theirParams })).status).toBe(404);
  });
});
