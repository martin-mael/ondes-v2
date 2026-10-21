import { randomBytes } from 'node:crypto';
import {
  addMembership,
  createOrganization,
  createStation,
  getUpload,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
  setOrgStorageLimit,
} from '@ondes/db';
import { createTestDatabase } from '@ondes/db/testing';
import type { Actor, IngestJobPayload, Upload } from '@ondes/shared';
import { createS3Storage, loadStorageConfig, type Storage } from '@ondes/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { createMemoryMailer } from '../../plugins/mail.ts';
import { signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../auth/testing.ts';

// The upload API on the real app, against the dev Garage: the test plays the browser, PUTting
// parts to the presigned URLs. Ingest jobs are recorded instead of enqueued. Skipped without
// S3_ENDPOINT, like @ondes/storage's tests.

const enabled = Boolean(process.env.S3_ENDPOINT);
const system: Actor = { type: 'system', name: 'test' };
const MiB = 1024 ** 2;

let t: TestApp;
let storage: Storage;
let scope: StationScope;
let programmer: string;
let presenter: string;
const enqueued: IngestJobPayload[] = [];

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
    uploads: {
      enqueueIngest: async (payload) => {
        enqueued.push(payload);
      },
    },
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

  const org = await createOrganization(tdb.db, system, { slug: 'up-org', name: 'Org' });
  const orgScope = await resolveOrgScope(tdb.db, org.id);
  const st = await createStation(
    tdb.db,
    { actor: system, scope: orgScope },
    { slug: 'up-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(tdb.db, org.id, st.id);
  const cookies: Record<string, string> = {};
  for (const role of ['programmer', 'presenter'] as const) {
    const { userId, cookie } = await signUpAndLogin(t, `${role}@up.test`);
    await addMembership(
      tdb.db,
      { actor: system, scope: orgScope },
      { level: 'station', stationId: st.id, userId, role },
    );
    cookies[role] = cookie;
  }
  programmer = cookies.programmer as string;
  presenter = cookies.presenter as string;
}, 60_000);
afterAll(() => t?.close());

function api(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: object,
  cookie = programmer,
) {
  return t.app.inject({
    method,
    url: `/api/v1/stations/${scope.stationId}${url}`,
    cookies: { ondes_session: cookie },
    ...(payload ? { payload } : {}),
  });
}

async function create(sizeBytes: number, filename = 'song.wav'): Promise<Upload> {
  const res = await api('POST', '/uploads', { filename, sizeBytes, contentType: 'audio/wav' });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

/** What the browser does: presign, then PUT each part, keeping nothing but the ETag. */
async function sendParts(upload: Upload, bytes: Buffer, partNumbers: number[]) {
  const res = await api('POST', `/uploads/${upload.id}/parts`, { partNumbers });
  expect(res.statusCode, res.body).toBe(200);
  for (const { partNumber, url } of res.json().parts as { partNumber: number; url: string }[]) {
    const start = (partNumber - 1) * upload.partSize;
    const put = await fetch(url, {
      method: 'PUT',
      body: bytes.subarray(start, start + upload.partSize),
    });
    expect(put.status).toBe(200);
  }
}

describe.skipIf(!enabled)('upload api (integration)', () => {
  it('uploads in parts straight to S3, completes and enqueues ingest', async () => {
    const bytes = randomBytes(20 * MiB);
    const upload = await create(bytes.length);
    expect(upload).toMatchObject({ status: 'uploading', partCount: 2, partSize: 16 * MiB });

    await sendParts(upload, bytes, [1, 2]);
    const done = await api('POST', `/uploads/${upload.id}/complete`);
    expect(done.statusCode, done.body).toBe(202);
    expect(done.json()).toMatchObject({ id: upload.id, status: 'queued' });
    expect(enqueued).toContainEqual({
      uploadId: upload.id,
      orgId: scope.orgId,
      stationId: scope.stationId,
    });

    const row = await getUpload(t.tdb.db, scope, upload.id);
    expect((await storage.head(row.stagingKey))?.size).toBe(bytes.length);
    // Completing again is harmless: same state, the job is enqueued again (its key runs once).
    const again = await api('POST', `/uploads/${upload.id}/complete`);
    expect(again.json()).toMatchObject({ status: 'queued' });
    expect((await api('GET', `/uploads/${upload.id}`)).json()).toMatchObject({ status: 'queued' });
  });

  it('resumes an interrupted upload from the parts S3 already has', async () => {
    const bytes = randomBytes(40 * MiB);
    const upload = await create(bytes.length);
    expect(upload.partCount).toBe(3);
    // The connection drops after part 2.
    await sendParts(upload, bytes, [1, 2]);
    expect((await api('POST', `/uploads/${upload.id}/complete`)).statusCode).toBe(409);

    // Back online: ask what's there, send the rest.
    const listed = await api('GET', `/uploads/${upload.id}/parts`);
    expect(listed.statusCode).toBe(200);
    const have = (listed.json().parts as { partNumber: number }[]).map((p) => p.partNumber);
    expect(have).toEqual([1, 2]);
    const missing = [1, 2, 3].filter((p) => !have.includes(p));
    await sendParts(upload, bytes, missing);
    const done = await api('POST', `/uploads/${upload.id}/complete`);
    expect(done.statusCode, done.body).toBe(202);

    const row = await getUpload(t.tdb.db, scope, upload.id);
    const { body } = await storage.get(row.stagingKey);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  });

  it('refuses an upload over the org quota before handing out any URL', async () => {
    await setOrgStorageLimit(t.tdb.db, scope.orgId, 10 * MiB);
    try {
      const res = await api('POST', '/uploads', { filename: 'big.wav', sizeBytes: 11 * MiB });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toMatchObject({
        error: 'quota_exceeded',
        details: { limitBytes: 10 * MiB },
      });

      // Allowed when created, refused once the quota shrank: no more part URLs.
      const upload = await create(6 * MiB);
      await setOrgStorageLimit(t.tdb.db, scope.orgId, 1 * MiB);
      const parts = await api('POST', `/uploads/${upload.id}/parts`, { partNumbers: [1] });
      expect(parts.statusCode).toBe(413);
    } finally {
      await setOrgStorageLimit(t.tdb.db, scope.orgId, null);
    }
  });

  it('refuses a completed object whose size differs from the declared one', async () => {
    const upload = await create(1000);
    await sendParts(upload, randomBytes(999), [1]);
    const res = await api('POST', `/uploads/${upload.id}/complete`);
    expect(res.statusCode).toBe(409);
    expect((await api('GET', `/uploads/${upload.id}`)).json()).toMatchObject({
      status: 'aborted',
      errorCode: 'size_mismatch',
    });
  });

  it('aborts and deletes uploads', async () => {
    const bytes = randomBytes(1000);
    const upload = await create(bytes.length);
    await sendParts(upload, bytes, [1]);
    const aborted = await api('POST', `/uploads/${upload.id}/abort`);
    expect(aborted.json()).toMatchObject({ status: 'aborted' });
    expect((await api('POST', `/uploads/${upload.id}/complete`)).statusCode).toBe(409);
    expect((await api('DELETE', `/uploads/${upload.id}`)).statusCode).toBe(204);
    expect((await api('GET', `/uploads/${upload.id}`)).statusCode).toBe(404);

    // A queued upload belongs to ingest: it can't be deleted.
    const queued = await create(bytes.length);
    await sendParts(queued, bytes, [1]);
    await api('POST', `/uploads/${queued.id}/complete`);
    expect((await api('DELETE', `/uploads/${queued.id}`)).statusCode).toBe(409);
  });

  it('lists uploads with their status, and needs library:write to upload', async () => {
    const list = await api('GET', '/uploads?status=queued');
    expect(list.statusCode).toBe(200);
    const items = list.json().items as Upload[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((u) => u.status === 'queued')).toBe(true);
    expect(JSON.stringify(list.json())).not.toContain('stagingKey');

    expect((await api('GET', '/uploads', undefined, presenter)).statusCode).toBe(200);
    const res = await api('POST', '/uploads', { filename: 'a.wav', sizeBytes: 10 }, presenter);
    expect(res.statusCode).toBe(403);
  });
});
