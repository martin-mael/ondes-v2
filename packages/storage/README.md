# @ondes/storage

S3-compatible object storage for the api and worker (#7).

```ts
import { contentKey, createS3Storage, loadStorageConfig } from '@ondes/storage';

const storage = createS3Storage(loadStorageConfig()); // reads S3_* from process.env
const key = contentKey({ orgId, sha256, ext: 'flac' }); // org/<orgId>/sha256/<hash>.flac
await storage.put(key, stream, { contentLength, contentType: 'audio/flac' });
```

- **`Storage`** (`src/storage.ts`): put, get (stream, optional byte range), head, delete, list, presigned GET/PUT, and multipart upload (create, presign parts, list parts, complete, abort). `head` returns `null` for a missing object, `get` throws `ObjectNotFoundError`.
- **Config** (`src/config.ts`): `S3_ENDPOINT` (omit for AWS), `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`. The dev Garage needs path-style and region `garage` (see `.env.example`).
- **Keys** (`src/keys.ts`): content-addressed media keys; everything an org owns lives under `org/<orgId>/`.
- **Quota and deletes** (`src/quota.ts`): `assertQuota` before handing out upload URLs; `chargeStoredObject(store, orgId, key, size)` when an asset starts referencing an object; `releaseStoredObject(storage, store, orgId, key)` when it stops. Content-addressed objects are shared between an org's assets, so the store keeps a **reference count per key**: the org is charged on the first reference and the object is deleted, and credited, only on the last. **Never call `storage.delete` on a content key directly.** `reconcileOrgUsage` recomputes usage from the bucket. Counters live behind the `QuotaStore` port, which the DB layer implements; `createMemoryQuotaStore` is for tests.

## Resumable uploads
The client asks the api for an upload id and presigned part URLs, then PUTs parts (5 MiB minimum, except the last) directly to S3. After an interruption it calls `listParts`, sends only the missing parts, and completes. `src/s3-storage.int.test.ts` does exactly this with a 500 MiB file.

## Tests
`pnpm test` runs the unit tests. The integration tests need the dev Garage and the `S3_*` variables, and are skipped when `S3_ENDPOINT` is unset:

```sh
pnpm dev:up
set -a; . ./.env; set +a
pnpm test:integration
```
