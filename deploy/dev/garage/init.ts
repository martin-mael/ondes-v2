// One-shot bootstrap for the dev Garage node, run by the `garage-init` service in
// deploy/compose.dev.yml. Idempotent: safe to run on every `docker compose up`.
//
// 1. assigns the single node a layout role (Garage serves nothing until it has one);
// 2. imports the dev access key from S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY;
// 3. creates S3_BUCKET and grants the key read/write/owner on it.
//
// Talks to the Garage admin API v2 (https://garagehq.deuxfleurs.fr/api/garage-admin-v2.html).

const adminUrl = requireEnv('GARAGE_ADMIN_URL');
const adminToken = requireEnv('GARAGE_ADMIN_TOKEN');
const accessKeyId = requireEnv('S3_ACCESS_KEY_ID');
const secretAccessKey = requireEnv('S3_SECRET_ACCESS_KEY');
const bucket = requireEnv('S3_BUCKET');

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

await ensureLayout();
await ensureKey();
await ensureBucket();
console.log('garage-init: done');
