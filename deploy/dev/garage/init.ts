// One-shot bootstrap for the dev Garage node, run by the `garage-init` service in
// deploy/compose.dev.yml. Idempotent: safe to run on every `docker compose up`.
//
// 1. assigns the single node a layout role (Garage serves nothing until it has one);
// 2. imports the dev access key from S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY;
// 3. creates S3_BUCKET and grants the key read/write/owner on it;
// 4. sets the bucket's CORS rule, so browsers can PUT upload parts to presigned URLs (any
//    origin: this is the dev bucket; see deploy/README.md "Bucket CORS" for production).
//
// Talks to the Garage admin API v2 (https://garagehq.deuxfleurs.fr/api/garage-admin-v2.html),
// and to the S3 API for CORS, which the admin API doesn't cover (SigV4-signed by hand: the
// init container has no packages).

import { createHash, createHmac } from 'node:crypto';

const adminUrl = requireEnv('GARAGE_ADMIN_URL');
const adminToken = requireEnv('GARAGE_ADMIN_TOKEN');
const accessKeyId = requireEnv('S3_ACCESS_KEY_ID');
const secretAccessKey = requireEnv('S3_SECRET_ACCESS_KEY');
const bucket = requireEnv('S3_BUCKET');
const s3Url = process.env.GARAGE_S3_URL ?? 'http://garage:3900';
const s3Region = process.env.S3_REGION ?? 'garage';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function admin<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${adminUrl}/v2/${path}`, {
    method,
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function tryAdmin<T>(path: string): Promise<T | undefined> {
  const res = await fetch(`${adminUrl}/v2/${path}`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (res.status === 404 || res.status === 400) return undefined;
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

type ClusterStatus = { layoutVersion: number; nodes: { id: string; role: unknown }[] };

async function waitForNode(): Promise<ClusterStatus> {
  for (let attempt = 1; ; attempt++) {
    try {
      const status = await admin<ClusterStatus>('GET', 'GetClusterStatus');
      if (status.nodes.length > 0) return status;
    } catch (error) {
      if (attempt >= 30) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function ensureLayout(): Promise<void> {
  const status = await waitForNode();
  const node = status.nodes[0];
  if (!node) throw new Error('Garage reports no node');
  if (node.role) {
    console.log(`layout: node ${node.id.slice(0, 16)} already has a role`);
    return;
  }
  await admin('POST', 'UpdateClusterLayout', {
    roles: [{ id: node.id, zone: 'dev', capacity: 1_000_000_000, tags: ['dev'] }],
  });
  const layout = await admin<{ version: number }>('GET', 'GetClusterLayout');
  await admin('POST', 'ApplyClusterLayout', { version: layout.version + 1 });
  console.log(`layout: assigned node ${node.id.slice(0, 16)}, applied v${layout.version + 1}`);
}

async function ensureKey(): Promise<void> {
  const existing = await tryAdmin(`GetKeyInfo?id=${encodeURIComponent(accessKeyId)}`);
  if (existing) {
    console.log(`key: ${accessKeyId} already exists`);
    return;
  }
  await admin('POST', 'ImportKey', { accessKeyId, secretAccessKey, name: 'ondes-dev' });
  console.log(`key: imported ${accessKeyId}`);
}

async function ensureBucket(): Promise<void> {
  let info = await tryAdmin<{ id: string }>(
    `GetBucketInfo?globalAlias=${encodeURIComponent(bucket)}`,
  );
  if (!info) {
    info = await admin<{ id: string }>('POST', 'CreateBucket', { globalAlias: bucket });
    console.log(`bucket: created ${bucket}`);
  } else {
    console.log(`bucket: ${bucket} already exists`);
  }
  await admin('POST', 'AllowBucketKey', {
    bucketId: info.id,
    accessKeyId,
    permissions: { read: true, write: true, owner: true },
  });
  console.log(`bucket: granted ${accessKeyId} read/write/owner on ${bucket}`);
}

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** One path-style S3 request, signed with AWS SigV4. */
async function s3(method: 'PUT' | 'GET', path: string, query: string, body = ''): Promise<string> {
  const url = new URL(`${s3Url}${path}?${query}`);
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': sha256(body),
    'x-amz-date': amzDate,
  };
  if (body) headers['content-md5'] = createHash('md5').update(body).digest('base64');
  const names = Object.keys(headers).sort();
  const canonical = [
    method,
    url.pathname,
    query,
    ...names.map((n) => `${n}:${headers[n]}`),
    '',
    names.join(';'),
    headers['x-amz-content-sha256'],
  ].join('\n');
  const scope = `${day}/${s3Region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  let key = hmac(`AWS4${secretAccessKey}`, day);
  for (const part of [s3Region, 's3', 'aws4_request']) key = hmac(key, part);
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  const res = await fetch(url, {
    method,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    },
    body: body || undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`S3 ${method} ${path}?${query}: ${res.status} ${text}`);
  return text;
}

/** Browser uploads: PUT parts from any dev origin, read back the `ETag` (replaced each run). */
async function ensureCors(): Promise<void> {
  const rule = [
    '<CORSConfiguration>',
    '<CORSRule>',
    '<AllowedOrigin>*</AllowedOrigin>',
    ...['GET', 'HEAD', 'PUT'].map((m) => `<AllowedMethod>${m}</AllowedMethod>`),
    '<AllowedHeader>*</AllowedHeader>',
    '<ExposeHeader>ETag</ExposeHeader>',
    '<MaxAgeSeconds>3600</MaxAgeSeconds>',
    '</CORSRule>',
    '</CORSConfiguration>',
  ].join('');
  await s3('PUT', `/${bucket}`, 'cors=', rule);
  console.log(`bucket: CORS set on ${bucket} (PUT from any origin, ETag exposed)`);
}

await ensureLayout();
await ensureKey();
await ensureBucket();
await ensureCors();
console.log('garage-init: done');
