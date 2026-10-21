import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAsset,
  createOrganization,
  createStation,
  getFallbackSelection,
  getStationCache,
  logDay,
  logItem,
  putAssetFile,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
  setEmergencyAsset,
  setSafetyAssets,
  setStationCacheSettings,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import type { Actor } from '@ondes/shared';
import { contentKey, createS3Storage, loadStorageConfig, type Storage } from '@ondes/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evict } from './layout.ts';
import { HOUR } from './planner.ts';
import { type CacheSyncDeps, createLimiter, stationCacheDir, syncStation } from './sync.ts';

// Safety playlist and emergency file in the cache (#34), against the dev Postgres and Garage
// (`pnpm dev:up`). Skipped without S3_ENDPOINT. Each run uses its own database, org (so its
// own S3 keys) and cache directory.

const enabled = Boolean(process.env.S3_ENDPOINT);
const system: Actor = { type: 'system', name: 'test' };

let tdb: TestDatabase;
let storage: Storage;
let cacheRoot: string;
let deps: CacheSyncDeps;

beforeAll(async () => {
  if (!enabled) return;
  tdb = await createTestDatabase();
  storage = createS3Storage(loadStorageConfig());
  cacheRoot = await mkdtemp(join(tmpdir(), 'ondes-fallback-it-'));
  deps = {
    db: tdb.db,
    storage,
    cacheRoot,
    slots: createLimiter(4),
    diskReserve: () => 0,
  };
}, 60_000);

afterAll(async () => {
  await tdb?.drop();
  if (cacheRoot) await rm(cacheRoot, { recursive: true, force: true });
});

let n = 0;
async function tenant(): Promise<StationScope> {
  n++;
  const org = await createOrganization(tdb.db, system, {
    slug: `fb-${randomUUID().slice(0, 8)}`,
    name: 'Org',
  });
  const st = await createStation(
    tdb.db,
    { actor: system, scope: await resolveOrgScope(tdb.db, org.id) },
    { slug: `fb-fm-${n}`, name: 'FM', timezone: 'Europe/Paris' },
  );
  return resolveStationScope(tdb.db, org.id, st.id);
}

type Track = { assetId: string; sha256: string; bytes: Buffer };

/** An asset; with a playout file unless `file` is false. `stored: null` leaves S3 empty. */
async function track(
  scope: StationScope,
  options: { file?: boolean; stored?: Buffer | null } = {},
): Promise<Track> {
  const bytes = randomBytes(4096);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ctx = { actor: system, scope };
  const asset = await createAsset(tdb.db, ctx, { type: 'song', title: `t-${sha256.slice(0, 6)}` });
  if (options.file !== false) {
    const key = contentKey({ orgId: scope.orgId, sha256, ext: 'flac' });
    if (options.stored !== null) await storage.put(key, options.stored ?? bytes);
    await putAssetFile(tdb.db, ctx, asset.id, {
      role: 'playout',
      storageKey: key,
      sha256,
      sizeBytes: bytes.length,
      codec: 'flac',
      sampleRate: 44_100,
      flacBlockSize: 1024,
    });
  }
  return { assetId: asset.id, sha256, bytes };
}

const ls = async (dir: string) => (await readdir(dir).catch(() => [])).sort();

/** A log day with one item `at` minutes from now playing `t`. */
async function log(scope: StationScope, t: Track, at = 5) {
  const now = Date.now();
  const [day] = await tdb.db
    .insert(logDay)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      localDate: '2026-06-10',
      startsAt: new Date(now - 24 * HOUR),
      endsAt: new Date(now + 72 * HOUR),
    })
    .returning();
  if (!day) throw new Error('no day');
  await tdb.db.insert(logItem).values({
    orgId: scope.orgId,
    stationId: scope.stationId,
    logDayId: day.id,
    position: 0,
    kind: 'song',
    plannedStart: new Date(now + at * 60_000),
    plannedDurationMs: 180_000,
    assetId: t.assetId,
    originType: 'manual',
  });
}

/** `deps` whose storage runs `hook` before serving `key`, once. */
function hooked(key: string, hook: () => Promise<void> | void): CacheSyncDeps {
  let done = false;
  return {
    ...deps,
    storage: {
      ...storage,
      async get(k, options) {
        if (k === key && !done) {
          done = true;
          await hook();
        }
        return storage.get(k, options);
      },
    },
  };
}

describe.skipIf(!enabled)('fallback files in the playout cache', () => {
  it('creates safety/ even with nothing selected', async () => {
    const scope = await tenant();
    const report = await syncStation(deps, scope);
    const root = stationCacheDir(cacheRoot, scope.stationId);
    expect((await stat(join(root, 'safety'))).isDirectory()).toBe(true);
    expect(await ls(join(root, 'safety'))).toEqual([]);
    expect(report.fallbacks).toMatchObject({ linked: 0, removed: 0, failed: [] });
    expect((await getFallbackSelection(tdb.db, scope)).syncedAt).toBeInstanceOf(Date);
  });

  it('pins the safety playlist and the emergency file, and follows the selection', async () => {
    const scope = await tenant();
    const root = stationCacheDir(cacheRoot, scope.stationId);
    const [a, b, c] = [await track(scope), await track(scope), await track(scope)];
    await setSafetyAssets(tdb.db, scope, [a.assetId, b.assetId]);
    await setEmergencyAsset(tdb.db, scope, c.assetId);

    const first = await syncStation(deps, scope);
    expect(first.fallbacks?.linked).toBe(3);
    expect(await ls(join(root, 'safety'))).toEqual([`${a.sha256}.flac`, `${b.sha256}.flac`].sort());
    expect(await readFile(join(root, 'safety', `${a.sha256}.flac`))).toEqual(a.bytes);
    expect(await readFile(join(root, 'emergency.flac'))).toEqual(c.bytes);
    // Nothing left behind in the engine-visible tree.
    expect((await ls(root)).filter((f) => !f.startsWith('.'))).toEqual([
      'emergency.flac',
      'media',
      'safety',
    ]);
    const selection = await getFallbackSelection(tdb.db, scope);
    expect(selection.safety.map((s) => s.cache.state)).toEqual(['ready', 'ready']);
    expect(selection.emergency?.cache.state).toBe('ready');

    // Idempotent: nothing to do the second time.
    expect((await syncStation(deps, scope)).fallbacks).toMatchObject({ linked: 0, removed: 0 });

    // Evicting the media/ copy doesn't touch the pinned links.
    await evict(root, { sha256: a.sha256, ext: 'flac' });
    expect(await readFile(join(root, 'safety', `${a.sha256}.flac`))).toEqual(a.bytes);

    // Deselect b, swap the emergency file for a: replaced in place.
    await setSafetyAssets(tdb.db, scope, [a.assetId]);
    await setEmergencyAsset(tdb.db, scope, a.assetId);
    const third = await syncStation(deps, scope);
    expect(third.fallbacks).toMatchObject({ linked: 1, removed: 1 });
    expect(await ls(join(root, 'safety'))).toEqual([`${a.sha256}.flac`]);
    expect(await readFile(join(root, 'emergency.flac'))).toEqual(a.bytes);

    // Cleared on purpose: the file goes.
    await setEmergencyAsset(tdb.db, scope, null);
    await syncStation(deps, scope);
    expect(await ls(root)).not.toContain('emergency.flac');
  });

  it('syncs the fallbacks before the horizon, also when the pass is aborted', async () => {
    const scope = await tenant();
    const root = stationCacheDir(cacheRoot, scope.stationId);
    const [song, safe, loop] = [await track(scope), await track(scope), await track(scope)];
    await log(scope, song);
    await setSafetyAssets(tdb.db, scope, [safe.assetId]);
    await setEmergencyAsset(tdb.db, scope, loop.assetId);
    const abort = new AbortController();
    const key = contentKey({ orgId: scope.orgId, sha256: song.sha256, ext: 'flac' });
    await syncStation(
      hooked(key, () => abort.abort()),
      scope,
      abort.signal,
    );
    expect(await readFile(join(root, 'emergency.flac'))).toEqual(loop.bytes);
    expect(await ls(join(root, 'safety'))).toEqual([`${safe.sha256}.flac`]);
  });

  it('runs again when the selection changes during a pass', async () => {
    const scope = await tenant();
    const root = stationCacheDir(cacheRoot, scope.stationId);
    const [song, safe] = [await track(scope), await track(scope)];
    await log(scope, song);
    const key = contentKey({ orgId: scope.orgId, sha256: song.sha256, ext: 'flac' });
    // The change lands while the horizon downloads: its enqueue would be collapsed.
    const report = await syncStation(
      hooked(key, async () => {
        await setSafetyAssets(tdb.db, scope, [safe.assetId]);
      }),
      scope,
    );
    expect(report.passes).toBe(2);
    expect(await ls(join(root, 'safety'))).toEqual([`${safe.sha256}.flac`]);
  });

  it('counts pinned fallback bytes against the budget', async () => {
    const scope = await tenant();
    const root = stationCacheDir(cacheRoot, scope.stationId);
    const [safe, song] = [await track(scope), await track(scope)];
    await setSafetyAssets(tdb.db, scope, [safe.assetId]);
    await syncStation(deps, scope);
    // The media/ copy goes; the pinned link keeps the bytes on disk.
    await evict(root, { sha256: safe.sha256, ext: 'flac' });
    await setStationCacheSettings(tdb.db, scope, { budgetBytes: 6000 });
    await log(scope, song);
    const report = await syncStation(deps, scope);
    expect(report.plan.deferred.map((d) => d.sha256)).toEqual([song.sha256]);
    expect((await getStationCache(tdb.db, scope)).usedBytes).toBe(4096);

    // A linked media/ copy is never evicted to make room: it would free nothing.
    await setStationCacheSettings(tdb.db, scope, { budgetBytes: 9000 });
    const other = await track(scope);
    await setSafetyAssets(tdb.db, scope, [safe.assetId, other.assetId]);
    await syncStation(deps, scope);
    expect((await getStationCache(tdb.db, scope)).usedBytes).toBe(8192);
  });

  it('keeps the previous emergency file while the new one has no playout file', async () => {
    const scope = await tenant();
    const root = stationCacheDir(cacheRoot, scope.stationId);
    const old = await track(scope);
    await setEmergencyAsset(tdb.db, scope, old.assetId);
    await syncStation(deps, scope);
    const fresh = await track(scope, { file: false });
    await setEmergencyAsset(tdb.db, scope, fresh.assetId);
    await syncStation(deps, scope);
    expect(await readFile(join(root, 'emergency.flac'))).toEqual(old.bytes);
    const selection = await getFallbackSelection(tdb.db, scope);
    expect(selection.emergency?.cache.state).toBe('no_file');
    // Recorded, so the api can say the previous file is still in use.
    expect(selection.onDisk.emergencySha256).toBe(old.sha256);
  });

  it('records failures and removes stray files', async () => {
    const scope = await tenant();
    const root = stationCacheDir(cacheRoot, scope.stationId);
    const missing = await track(scope, { stored: null });
    const corrupt = await track(scope, { stored: randomBytes(4096) });
    await setSafetyAssets(tdb.db, scope, [missing.assetId, corrupt.assetId]);
    await mkdir(join(root, 'safety'), { recursive: true });
    await writeFile(join(root, 'safety', 'stray.mp3'), 'x');

    const report = await syncStation(deps, scope);
    expect(report.fallbacks?.removed).toBe(1);
    expect(report.fallbacks?.failed.map((f) => f.error).sort()).toEqual([
      'checksum_mismatch',
      'source_missing',
    ]);
    expect(await ls(join(root, 'safety'))).toEqual([]);
    const states = (await getFallbackSelection(tdb.db, scope)).safety.map((s) => s.cache);
    expect(states.map((s) => s.state)).toEqual(['failed', 'failed']);
  });
});
