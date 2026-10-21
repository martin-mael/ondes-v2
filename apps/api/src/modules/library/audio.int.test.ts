import { createHash, randomBytes } from 'node:crypto';
import {
  addMembership,
  createAsset,
  createOrganization,
  createStation,
  putAssetFile,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
} from '@ondes/db';
import { createTestDatabase } from '@ondes/db/testing';
import type { Actor } from '@ondes/shared';
import { contentKey, createS3Storage, loadStorageConfig, type Storage } from '@ondes/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { createMemoryMailer } from '../../plugins/mail.ts';
import { signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../auth/testing.ts';

// `GET …/assets/:assetId/audio` on the real app, against the dev Garage: a redirect to a
// presigned GET of the playout copy that the browser can follow. Skipped without S3_ENDPOINT.

const enabled = Boolean(process.env.S3_ENDPOINT);
const system: Actor = { type: 'system', name: 'test' };

let t: TestApp;
let storage: Storage;
let scope: StationScope;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  if (!enabled) return;
  const tdb = await createTestDatabase();
  const mailer = createMemoryMailer();
  storage = createS3Storage(loadStorageConfig());
  const app = await buildApp({
    db: { client: tdb },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    storage,
    fastify: { logger: false },
  });
  await app.ready();
  t = {
    app,
    tdb,
    outbox: mailer.outbox,
    close: async () => {
      await app.close();
      await tdb.drop();
    },
  };
  const org = await createOrganization(tdb.db, system, { slug: 'audio-org', name: 'Org' });
  const orgScope = await resolveOrgScope(tdb.db, org.id);
  const st = await createStation(
    tdb.db,
    { actor: system, scope: orgScope },
    { slug: 'audio-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(tdb.db, org.id, st.id);
  for (const role of ['presenter', 'viewer'] as const) {
    const { userId, cookie } = await signUpAndLogin(t, `${role}@audio.test`);
    await addMembership(
      tdb.db,
      { actor: system, scope: orgScope },
      { level: 'station', stationId: st.id, userId, role },
    );
    cookies[role] = cookie;
  }
}, 60_000);
afterAll(() => t?.close());

const get = (assetId: string, who = 'presenter') =>
  t.app.inject({
    method: 'GET',
    url: `/api/v1/stations/${scope.stationId}/assets/${assetId}/audio`,
    cookies: { ondes_session: cookies[who] ?? '' },
  });

describe.skipIf(!enabled)('audio route (integration)', () => {
  it('redirects to a presigned URL of the playout copy', async () => {
    const ctx = { actor: system, scope };
    const created = await createAsset(t.tdb.db, ctx, { type: 'song', title: 'Waves' });
    const bytes = randomBytes(64);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const key = contentKey({ orgId: scope.orgId, sha256: sha, ext: 'flac' });
    await storage.put(key, bytes, { contentType: 'audio/flac' });
    await putAssetFile(t.tdb.db, ctx, created.id, {
      role: 'playout',
      storageKey: key,
      sha256: sha,
      sizeBytes: bytes.length,
      codec: 'flac',
      sampleRate: 44_100,
      channels: 1,
      durationSamples: 512,
      flacBlockSize: 1024,
    });

    const res = await get(created.id);
    expect(res.statusCode, res.body).toBe(302);
    expect(res.headers['cache-control']).toMatch(/^private, max-age=\d+$/);
    const location = String(res.headers.location);
    const fetched = await fetch(location);
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('404s an asset without a playout copy, or outside the station', async () => {
    const created = await createAsset(
      t.tdb.db,
      { actor: system, scope },
      { type: 'song', title: 'Raw' },
    );
    expect((await get(created.id)).statusCode).toBe(404);
    expect((await get('01a15ddf-0000-7000-8000-0000000000ff')).statusCode).toBe(404);
  });

  it('needs library:read', async () => {
    const created = await createAsset(
      t.tdb.db,
      { actor: system, scope },
      { type: 'song', title: 'X' },
    );
    expect((await get(created.id, 'viewer')).statusCode).toBe(403);
  });
});
