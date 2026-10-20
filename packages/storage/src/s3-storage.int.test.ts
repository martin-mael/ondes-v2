import { createCipheriv, createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadStorageConfig } from './config.ts';
import { contentKey, orgPrefix } from './keys.ts';
import { createMemoryQuotaStore, reconcileOrgUsage } from './quota.ts';
import { createS3Storage } from './s3-storage.ts';
import { ObjectNotFoundError, type Storage, type UploadedPart } from './storage.ts';

// Runs against the dev Garage from deploy/compose.dev.yml (`pnpm dev:up`), with the S3_*
// variables from .env.example. Skipped when S3_ENDPOINT isn't set.
const enabled = Boolean(process.env.S3_ENDPOINT);

const MiB = 1024 * 1024;

describe.skipIf(!enabled)('S3 storage (integration)', () => {
  let storage: Storage;
  // Every run writes under its own org prefix, deleted afterwards.
  const orgId = `inttest-${randomUUID()}`;
  const key = (name: string) => `${orgPrefix(orgId)}${name}`;

  beforeAll(() => {
    storage = createS3Storage(loadStorageConfig());
  });

  afterAll(async () => {
    if (!storage) return;
    for await (const object of storage.list(orgPrefix(orgId))) await storage.delete(object.key);
  });

  it('round-trips put, head, get, list and delete', async () => {
    const body = 'hello ondes';
    const sha256 = createHash('sha256').update(body).digest('hex');
    const k = contentKey({ orgId, sha256, ext: 'txt' });

    await storage.put(k, body, { contentType: 'text/plain', metadata: { source: 'test' } });

    const info = await storage.head(k);
    expect(info).toMatchObject({ key: k, size: body.length, contentType: 'text/plain' });
    expect(info?.metadata).toEqual({ source: 'test' });

    const got = await storage.get(k);
    expect(await readText(got.body)).toBe(body);
    expect(got.etag).toBe(info?.etag);

    const ranged = await storage.get(k, { range: { start: 6, end: 10 } });
    expect(await readText(ranged.body)).toBe('ondes');
    expect(ranged.contentLength).toBe(5);

    const keys = [];
    for await (const object of storage.list(orgPrefix(orgId))) keys.push(object.key);
    expect(keys).toContain(k);

    await storage.delete(k);
    expect(await storage.head(k)).toBeNull();
    await expect(storage.get(k)).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(storage.delete(k)).resolves.toBeUndefined();
  });

  it('puts a stream body with a known length', async () => {
    const k = key('stream.bin');
    const size = 3 * MiB + 17;
    await storage.put(k, syntheticFile(size, 'stream'), { contentLength: size });
    expect((await storage.head(k))?.size).toBe(size);
  });

  it('serves presigned PUT and GET URLs', async () => {
    const k = key('presigned.txt');
    const putUrl = await storage.presignPut(k, { contentType: 'text/plain', expiresIn: 60 });

    const put = await fetch(putUrl, {
      method: 'PUT',
      body: 'via presigned url',
      headers: { 'content-type': 'text/plain' },
    });
    expect(put.status).toBe(200);

    const getUrl = await storage.presignGet(k, {
      expiresIn: 60,
      responseContentDisposition: 'attachment; filename="x.txt"',
    });
    const get = await fetch(getUrl);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-disposition')).toBe('attachment; filename="x.txt"');
    expect(await get.text()).toBe('via presigned url');

    // The signature covers the key and method: no reuse for another object or verb.
    const tampered = putUrl.replace('presigned.txt', 'other.txt');
    expect((await fetch(tampered, { method: 'PUT', body: 'x' })).ok).toBe(false);
    expect((await fetch(getUrl, { method: 'DELETE' })).ok).toBe(false);
  });

  it('aborts a multipart upload', async () => {
    const k = key('aborted.bin');
    const { uploadId } = await storage.createMultipartUpload(k);
    await uploadPart(storage, k, uploadId, 1, Buffer.alloc(5 * MiB, 1));
    expect(await storage.listParts(k, uploadId)).toHaveLength(1);

    await storage.abortMultipartUpload(k, uploadId);
    await expect(storage.listParts(k, uploadId)).rejects.toThrow();
    expect(await storage.head(k)).toBeNull();
  });

  it('resumes an interrupted 500 MB multipart upload through presigned part URLs', {
    timeout: 10 * 60_000,
  }, async () => {
    const size = 500 * MiB;
    const partSize = 16 * MiB;
    const partCount = Math.ceil(size / partSize);
    const k = key('large.flac');
    const { uploadId } = await storage.createMultipartUpload(k, { contentType: 'audio/flac' });

    // First attempt: the "client" dies after 12 parts.
    let sent = 0;
    for await (const part of partsOf(syntheticFile(size, 'large'), partSize)) {
      await uploadPart(storage, k, uploadId, sent + 1, part);
      if (++sent === 12) break;
    }

    // Second attempt starts from scratch: it only knows the key and upload id, asks the
    // server which parts landed, re-reads the source and sends the missing ones.
    const done = new Map((await storage.listParts(k, uploadId)).map((p) => [p.partNumber, p]));
    expect(done.size).toBe(12);

    const parts: UploadedPart[] = [];
    const sourceHash = createHash('sha256');
    let partNumber = 0;
    let uploaded = 0;
    for await (const part of partsOf(syntheticFile(size, 'large'), partSize)) {
      partNumber++;
      sourceHash.update(part);
      const existing = done.get(partNumber);
      if (existing && existing.etag === createHash('md5').update(part).digest('hex')) {
        parts.push(existing);
        continue;
      }
      parts.push({ partNumber, etag: await uploadPart(storage, k, uploadId, partNumber, part) });
      uploaded++;
    }
    expect(partNumber).toBe(partCount);
    expect(uploaded).toBe(partCount - 12);

    await storage.completeMultipartUpload(k, uploadId, parts);

    const info = await storage.head(k);
    expect(info?.size).toBe(size);
    expect(info?.contentType).toBe('audio/flac');

    const stored = createHash('sha256');
    for await (const chunk of (await storage.get(k)).body) stored.update(chunk as Buffer);
    expect(stored.digest('hex')).toBe(sourceHash.digest('hex'));

    const quota = createMemoryQuotaStore();
    expect(await reconcileOrgUsage(storage, quota, orgId)).toBeGreaterThanOrEqual(size);
  });
});

/** PUTs one part through a presigned URL, as a browser would, and returns its ETag. */
async function uploadPart(
  storage: Storage,
  key: string,
  uploadId: string,
  partNumber: number,
  body: Buffer,
): Promise<string> {
  const [presigned] = await storage.presignUploadParts(key, uploadId, [partNumber]);
  if (!presigned) throw new Error('no presigned URL');
  const res = await fetch(presigned.url, { method: 'PUT', body });
  if (!res.ok) throw new Error(`part ${partNumber}: ${res.status} ${await res.text()}`);
  const etag = res.headers.get('etag');
  if (!etag) throw new Error(`part ${partNumber}: no ETag header`);
  return etag.replace(/^"|"$/g, '');
}

/** Deterministic pseudo-random bytes (AES-CTR keystream), generated on the fly. */
function syntheticFile(size: number, seed: string): Readable {
  const cipher = createCipheriv(
    'aes-128-ctr',
    createHash('md5').update(seed).digest(),
    Buffer.alloc(16),
  );
  const zeros = Buffer.alloc(MiB);
  return Readable.from(
    (function* () {
      for (let offset = 0; offset < size; offset += MiB) {
        yield cipher.update(zeros.subarray(0, Math.min(MiB, size - offset)));
      }
    })(),
  );
}

/** Re-chunks a byte stream into `partSize` buffers (the last one may be shorter). */
async function* partsOf(source: Readable, partSize: number): AsyncGenerator<Buffer> {
  let chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of source as AsyncIterable<Buffer>) {
    let rest = chunk;
    while (length + rest.length >= partSize) {
      const take = partSize - length;
      chunks.push(rest.subarray(0, take));
      yield Buffer.concat(chunks);
      rest = rest.subarray(take);
      chunks = [];
      length = 0;
    }
    if (rest.length > 0) {
      chunks.push(rest);
      length += rest.length;
    }
  }
  if (length > 0) yield Buffer.concat(chunks);
}

async function readText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
