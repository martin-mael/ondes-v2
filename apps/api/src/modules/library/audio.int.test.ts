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
let otherScope: StationScope;
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
  // Same org, another station the members don't belong to.
  const other = await createStation(
    tdb.db,
    { actor: system, scope: orgScope },
    { slug: 'audio-other', name: 'Other', timezone: 'Europe/Paris' },
  );
  otherScope = await resolveStationScope(tdb.db, org.id, other.id);
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

const get = (assetId: string, who = 'presenter', query = '') =>
  t.app.inject({
    method: 'GET',
    url: `/api/v1/stations/${scope.stationId}/assets/${assetId}/audio${query}`,
    cookies: { ondes_session: cookies[who] ?? '' },
  });

/** An asset of `owner` with a stored playout copy of `bytes`. */
async function playable(bytes: Buffer, owner: StationScope = scope) {
  const ctx = { actor: system, scope: owner };
  const created = await createAsset(t.tdb.db, ctx, { type: 'song', title: 'Waves' });
  const sha = createHash('sha256').update(bytes).digest('hex');
  const key = contentKey({ orgId: owner.orgId, sha256: sha, ext: 'flac' });
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
  return { id: created.id, sha, key };
}

describe.skipIf(!enabled)('audio route (integration)', () => {
  it('redirects to a presigned URL of the playout copy, which serves ranges', async () => {
    const bytes = randomBytes(64);
    const a = await playable(bytes);

    const res = await get(a.id);
    expect(res.statusCode, res.body).toBe(302);
    // Unversioned: not cached, a replaced file shows up at once.
    expect(res.headers['cache-control']).toBe('no-store');
    const location = String(res.headers.location);
    const fetched = await fetch(location);
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(bytes)).toBe(true);

    // <audio> seeks with range requests: storage answers them on the presigned URL.
    const part = await fetch(location, { headers: { range: 'bytes=10-19' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 10-19/64');
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(10, 20))).toBe(true);
  });

  it('caches a versioned URL, and 404s it once the playout copy is replaced', async () => {
    const a = await playable(randomBytes(32));
    const versioned = await get(a.id, 'presenter', `?v=${a.sha}`);
    expect(versioned.statusCode).toBe(302);
    expect(versioned.headers['cache-control']).toMatch(/^private, max-age=\d+$/);

    const next = randomBytes(32);
    const nextSha = createHash('sha256').update(next).digest('hex');
    await putAssetFile(t.tdb.db, { actor: system, scope }, a.id, {
      role: 'playout',
      storageKey: contentKey({ orgId: scope.orgId, sha256: nextSha, ext: 'flac' }),
      sha256: nextSha,
      sizeBytes: next.length,
      codec: 'flac',
      sampleRate: 44_100,
      channels: 1,
      durationSamples: 512,
      flacBlockSize: 1024,
    });
    expect((await get(a.id, 'presenter', `?v=${a.sha}`)).statusCode).toBe(404);
    expect((await get(a.id, 'presenter', `?v=${nextSha}`)).statusCode).toBe(302);
    expect((await get(a.id, 'presenter', '?v=nope')).statusCode).toBe(400);
  });

  it('404s an asset without a playout copy, or of another station', async () => {
    const raw = await createAsset(
      t.tdb.db,
      { actor: system, scope },
      { type: 'song', title: 'Raw' },
    );
    expect((await get(raw.id)).statusCode).toBe(404);
    // A real asset with a stored file, owned by another station of the same org.
    const foreign = await playable(randomBytes(16), otherScope);
    const res = await get(foreign.id);
    expect(res.statusCode).toBe(404);
    expect(res.headers.location).toBeUndefined();
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
