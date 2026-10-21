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
import {
  type Actor,
  decodePeaks,
  encodePeaks,
  PEAKS_CODEC,
  PEAKS_MIME_TYPE,
  peaksStorageKey,
} from '@ondes/shared';
import { contentKey, createS3Storage, loadStorageConfig, type Storage } from '@ondes/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { createMemoryMailer } from '../../plugins/mail.ts';
import { signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../auth/testing.ts';
import { PEAKS_IMMUTABLE, PEAKS_REVALIDATE } from './peaks-service.ts';

// `GET …/assets/:assetId/peaks` on the real app, against the dev Garage: the test stores what
// the worker's peaks job would (a peaks file and its `asset_file` row). Skipped without
// S3_ENDPOINT, like the upload tests.

const enabled = Boolean(process.env.S3_ENDPOINT);
const system: Actor = { type: 'system', name: 'test' };

let t: TestApp;
let storage: Storage;
let scope: StationScope;
let otherStation: string;
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
  const org = await createOrganization(tdb.db, system, { slug: 'peaks-org', name: 'Org' });
  const orgScope = await resolveOrgScope(tdb.db, org.id);
  const st = await createStation(
    tdb.db,
    { actor: system, scope: orgScope },
    { slug: 'peaks-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  otherStation = (
    await createStation(
      tdb.db,
      { actor: system, scope: orgScope },
      { slug: 'peaks-other', name: 'Other', timezone: 'Europe/Paris' },
    )
  ).id;
  scope = await resolveStationScope(tdb.db, org.id, st.id);
  for (const role of ['presenter', 'viewer'] as const) {
    const { userId, cookie } = await signUpAndLogin(t, `${role}@peaks.test`);
    await addMembership(
      tdb.db,
      { actor: system, scope: orgScope },
      { level: 'station', stationId: st.id, userId, role },
    );
    cookies[role] = cookie;
    if (role === 'presenter') {
      await addMembership(
        tdb.db,
        { actor: system, scope: orgScope },
        { level: 'station', stationId: otherStation, userId, role },
      );
    }
  }
}, 60_000);
afterAll(() => t?.close());

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** An asset with a playout copy (not stored: the route never reads it) and, if asked, peaks. */
async function asset(withPeaks: boolean) {
  const ctx = { actor: system, scope };
  const created = await createAsset(t.tdb.db, ctx, { type: 'song', title: 'Waves' });
  const playoutSha = sha(randomBytes(32));
  await putAssetFile(t.tdb.db, ctx, created.id, {
    role: 'playout',
    storageKey: contentKey({ orgId: scope.orgId, sha256: playoutSha, ext: 'flac' }),
    sha256: playoutSha,
    sizeBytes: 1000,
    codec: 'flac',
    sampleRate: 44_100,
    channels: 1,
    durationSamples: 512,
    flacBlockSize: 1024,
  });
  if (!withPeaks) return { id: created.id, playoutSha };
  const bytes = encodePeaks({
    sampleRate: 44_100,
    channels: 1,
    lengthSamples: 512,
    levels: [{ samplesPerPoint: 256, points: 2, values: Int8Array.from([-3, 4, -1, 2]) }],
  });
  const key = peaksStorageKey(scope.orgId, playoutSha);
  await storage.put(key, bytes, { contentType: PEAKS_MIME_TYPE });
  await putAssetFile(t.tdb.db, ctx, created.id, {
    role: 'peaks',
    storageKey: key,
    sha256: sha(bytes),
    sizeBytes: bytes.length,
    codec: PEAKS_CODEC,
    mimeType: PEAKS_MIME_TYPE,
  });
  return { id: created.id, playoutSha, peaksSha: sha(bytes), bytes };
}

function get(url: string, who = 'presenter', headers: Record<string, string> = {}) {
  return t.app.inject({
    method: 'GET',
    url,
    cookies: { ondes_session: cookies[who] ?? '' },
    headers,
  });
}
const peaksUrl = (assetId: string, stationId = scope.stationId) =>
  `/api/v1/stations/${stationId}/assets/${assetId}/peaks`;

describe.skipIf(!enabled)('peaks route (integration)', () => {
  it('serves the peaks file with its ETag, revalidated', async () => {
    const a = await asset(true);
    const res = await get(peaksUrl(a.id));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers).toMatchObject({
      'content-type': PEAKS_MIME_TYPE,
      etag: `"${a.peaksSha}"`,
      'cache-control': PEAKS_REVALIDATE,
      'content-length': String(a.bytes?.length),
    });
    const decoded = decodePeaks(res.rawPayload);
    expect(Array.from(decoded.levels[0]?.values ?? [])).toEqual([-3, 4, -1, 2]);

    const again = await get(peaksUrl(a.id), 'presenter', { 'if-none-match': `"${a.peaksSha}"` });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);
  });

  it('serves a versioned URL as immutable, and 404s an old version', async () => {
    const a = await asset(true);
    const res = await get(`${peaksUrl(a.id)}?v=${a.peaksSha}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe(PEAKS_IMMUTABLE);
    expect((await get(`${peaksUrl(a.id)}?v=${'0'.repeat(64)}`)).statusCode).toBe(404);
    expect((await get(`${peaksUrl(a.id)}?v=nope`)).statusCode).toBe(400);
  });

  it('404s an asset without peaks, or with peaks of a replaced playout copy', async () => {
    const none = await asset(false);
    expect((await get(peaksUrl(none.id))).json()).toMatchObject({ error: 'not_found' });

    const a = await asset(true);
    const newSha = sha(randomBytes(32));
    await putAssetFile(t.tdb.db, { actor: system, scope }, a.id, {
      role: 'playout',
      storageKey: contentKey({ orgId: scope.orgId, sha256: newSha, ext: 'flac' }),
      sha256: newSha,
      sizeBytes: 1000,
      codec: 'flac',
      sampleRate: 44_100,
      flacBlockSize: 1024,
    });
    expect((await get(peaksUrl(a.id))).statusCode).toBe(404);
  });

  it('is station-scoped and needs library read', async () => {
    const a = await asset(true);
    // The presenter reads both stations, but the asset is only in the first one.
    expect((await get(peaksUrl(a.id, otherStation))).statusCode).toBe(404);
    expect((await get(peaksUrl(a.id), 'viewer')).statusCode).toBe(403);
    const anonymous = await t.app.inject({ method: 'GET', url: peaksUrl(a.id) });
    expect(anonymous.statusCode).toBe(401);
  });
});
