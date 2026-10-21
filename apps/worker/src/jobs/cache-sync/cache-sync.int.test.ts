import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cacheReadiness,
  createAsset,
  createOrganization,
  createStation,
  getStationCache,
  isPlayoutCached,
  listCacheFiles,
  logDay,
  logItem,
  putAssetFile,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
  setStationCacheSettings,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import {
  connectQueue,
  createEventPublisher,
  deleteEventQueue,
  type JobPublisher,
  type QueueConnection,
} from '@ondes/queue';
import { type Actor, playoutRelPath, realtimeEventSchema } from '@ondes/shared';
import { contentKey, createS3Storage, loadStorageConfig, type Storage } from '@ondes/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanCache, touch } from './layout.ts';
import { HOUR } from './planner.ts';
import { type CacheSyncDeps, createLimiter, stationCacheDir, syncStation } from './sync.ts';
import { startCacheTriggers } from './trigger.ts';
import { urgentFetch } from './urgent.ts';

// Cache sync against the dev Postgres, Garage and RabbitMQ (`pnpm dev:up`). Skipped without
// S3_ENDPOINT, like @ondes/storage's tests. Each run uses its own database, org (so its own
// S3 keys), cache directory and queue prefix.

const enabled = Boolean(process.env.S3_ENDPOINT);
const system: Actor = { type: 'system', name: 'test' };
const KB = 1024;

let tdb: TestDatabase;
let storage: Storage;
let cacheRoot: string;
let deps: CacheSyncDeps;
const now = Date.now();

beforeAll(async () => {
  if (!enabled) return;
  tdb = await createTestDatabase();
  storage = createS3Storage(loadStorageConfig());
  cacheRoot = await mkdtemp(join(tmpdir(), 'ondes-cache-it-'));
  deps = {
    db: tdb.db,
    storage,
    cacheRoot,
    slots: createLimiter(8),
    concurrency: 4,
    // The test machine's disk may be fuller than the production reserve allows.
    diskReserve: () => 0,
    now: () => now,
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
    slug: `cache-${randomUUID().slice(0, 8)}`,
    name: 'Org',
  });
  const orgScope = await resolveOrgScope(tdb.db, org.id);
  const st = await createStation(
    tdb.db,
    { actor: system, scope: orgScope },
    { slug: `cache-fm-${n}`, name: 'FM', timezone: 'Europe/Paris' },
  );
  return resolveStationScope(tdb.db, org.id, st.id);
}

type Track = { assetId: string; assetFileId: string; sha256: string; bytes: Buffer; key: string };

/**
 * An asset with a playout file. `stored`: what goes to S3 (default: the bytes themselves;
 * other bytes make a corrupt object, null none at all).
 */
async function track(scope: StationScope, size: number, stored?: Buffer | null): Promise<Track> {
  const bytes = randomBytes(size);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const key = contentKey({ orgId: scope.orgId, sha256, ext: 'flac' });
  if (stored !== null) await storage.put(key, stored ?? bytes);
  const ctx = { actor: system, scope };
  const asset = await createAsset(tdb.db, ctx, { type: 'song', title: `t-${sha256.slice(0, 6)}` });
  const { file } = await putAssetFile(tdb.db, ctx, asset.id, {
    role: 'playout',
    storageKey: key,
    sha256,
    sizeBytes: size,
    codec: 'flac',
    sampleRate: 44_100,
    flacBlockSize: 1024,
  });
  return { assetId: asset.id, assetFileId: file.id, sha256, bytes, key };
}

/** One log day around `now` with these items (minutes from now, minutes long). */
async function log(scope: StationScope, items: Array<{ track: Track; at: number; min?: number }>) {
  const [day] = await tdb.db
    .insert(logDay)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      localDate: '2026-06-10',
      startsAt: new Date(now - 24 * HOUR),
      endsAt: new Date(now + 72 * HOUR),
    })
    .onConflictDoUpdate({
      target: [logDay.stationId, logDay.localDate],
      set: { version: 2 },
    })
    .returning();
  if (!day) throw new Error('no day');
  await deleteDayItems(day.id);
  if (!items.length) return day;
  await tdb.db.insert(logItem).values(
    items.map((it, position) => ({
      orgId: scope.orgId,
      stationId: scope.stationId,
      logDayId: day.id,
      position,
      kind: 'song' as const,
      plannedStart: new Date(now + it.at * 60_000),
      plannedDurationMs: (it.min ?? 3) * 60_000,
      assetId: it.track.assetId,
      originType: 'manual' as const,
    })),
  );
  return day;
}

async function deleteDayItems(logDayId: string) {
  await tdb.sql`delete from log_item where log_day_id = ${logDayId}`;
}

const pathOf = (scope: StationScope, t: Track) =>
  join(
    stationCacheDir(cacheRoot, scope.stationId),
    playoutRelPath({ sha256: t.sha256, ext: 'flac' }),
  );

describe.skipIf(!enabled)('cache sync', () => {
  it('fills a cold cache with the horizon, verified, and is idempotent', async () => {
    const scope = await tenant();
    const a = await track(scope, 300 * KB);
    const b = await track(scope, 200 * KB);
    const later = await track(scope, 100 * KB);
    const past = await track(scope, 100 * KB);
    await log(scope, [
      { track: past, at: -180 },
      { track: a, at: 5 },
      { track: b, at: 10 },
      { track: a, at: 40 * 60 },
      { track: later, at: 49 * 60 }, // beyond 48 h
    ]);

    const before = await cacheReadiness(tdb.db, scope, {
      from: new Date(now),
      to: new Date(now + 48 * HOUR),
    });
    expect(before).toMatchObject({ items: 3, readyItems: 0 });
    expect(before.missing.map((m) => m.reason)).toEqual(['pending', 'pending', 'pending']);

    const report = await syncStation(deps, scope);
    expect(report.fetched.map((f) => f.sha256).sort()).toEqual([a.sha256, b.sha256].sort());
    expect(report.failed).toEqual([]);
    expect(await readFile(pathOf(scope, a))).toEqual(a.bytes);
    expect(await readFile(pathOf(scope, b))).toEqual(b.bytes);
    await expect(stat(pathOf(scope, later))).rejects.toThrow();
    // The LRU stamp is the last planned air time.
    expect((await stat(pathOf(scope, a))).mtimeMs).toBe(now + 40 * HOUR);

    const after = await cacheReadiness(tdb.db, scope, {
      from: new Date(now),
      to: new Date(now + 48 * HOUR),
    });
    expect(after).toMatchObject({ items: 3, readyItems: 3, pctAirTime: 100, firstMissingAt: null });
    expect(await isPlayoutCached(tdb.db, scope, a.assetFileId)).toBe(true);
    expect(await isPlayoutCached(tdb.db, scope, later.assetFileId)).toBe(false);
    const state = await getStationCache(tdb.db, scope);
    expect(state).toMatchObject({ usedBytes: 500 * KB, horizonBytes: 500 * KB, deferred: [] });
    expect(state.lastPassAt).not.toBeNull();

    const again = await syncStation(deps, scope);
    expect(again.fetched).toEqual([]);
    expect(again.plan.evict).toEqual([]);
  });

  it('records a corrupt object, then fetches it once storage is fixed', async () => {
    const scope = await tenant();
    const t = await track(scope, 50 * KB, randomBytes(50 * KB));
    await log(scope, [{ track: t, at: 20 }]);

    const first = await syncStation(deps, scope);
    expect(first.failed.map((f) => f.error)).toEqual(['checksum_mismatch']);
    await expect(stat(pathOf(scope, t))).rejects.toThrow();
    // Nothing half-written left around.
    expect(await scanCache(stationCacheDir(cacheRoot, scope.stationId))).toEqual([]);
    const [row] = await listCacheFiles(tdb.db, scope);
    expect(row).toMatchObject({ state: 'failed', error: 'checksum_mismatch', attempts: 1 });
    const r = await cacheReadiness(tdb.db, scope, {
      from: new Date(now),
      to: new Date(now + HOUR),
    });
    expect(r.missing.map((m) => m.reason)).toEqual(['checksum_mismatch']);

    await syncStation(deps, scope);
    expect((await listCacheFiles(tdb.db, scope))[0]).toMatchObject({ attempts: 2 });

    await storage.put(t.key, t.bytes);
    const fixed = await syncStation(deps, scope);
    expect(fixed.fetched.map((f) => f.sha256)).toEqual([t.sha256]);
    expect(await readFile(pathOf(scope, t))).toEqual(t.bytes);
    expect(await listCacheFiles(tdb.db, scope)).toMatchObject([
      { sha256: t.sha256, state: 'ready', error: null, attempts: 0 },
    ]);
  });

  it('records a missing object and forgets it once the log no longer needs it', async () => {
    const scope = await tenant();
    const gone = await track(scope, 10 * KB, null);
    await log(scope, [{ track: gone, at: 30 }]);
    const report = await syncStation(deps, scope);
    expect(report.failed.map((f) => f.error)).toEqual(['source_missing']);
    expect(await listCacheFiles(tdb.db, scope)).toMatchObject([{ error: 'source_missing' }]);

    await log(scope, []);
    await syncStation(deps, scope);
    expect(await listCacheFiles(tdb.db, scope)).toEqual([]);
  });

  it('evicts least recently needed files outside the horizon to stay under budget', async () => {
    const scope = await tenant();
    const old1 = await track(scope, 100 * KB);
    const old2 = await track(scope, 100 * KB);
    const pinned = await track(scope, 100 * KB);
    const next = await track(scope, 100 * KB);
    const big = await track(scope, 200 * KB);
    const root = stationCacheDir(cacheRoot, scope.stationId);

    // Warm the cache with three files, then age two of them out of the horizon.
    await log(scope, [
      { track: old1, at: 10 },
      { track: old2, at: 20 },
      { track: pinned, at: 30 },
    ]);
    await syncStation(deps, scope);
    await touch(root, { sha256: old1.sha256, ext: 'flac' }, now - 72 * HOUR);
    await touch(root, { sha256: old2.sha256, ext: 'flac' }, now - 48 * HOUR);

    // Budget 350 KB: 300 KB cached, `next` needs 100 KB → evict old1 only (oldest).
    await setStationCacheSettings(tdb.db, scope, { budgetBytes: 350 * KB });
    await log(scope, [
      { track: pinned, at: -30 }, // aired 27 min ago: pinned
      { track: next, at: 60 },
      { track: big, at: 120 }, // doesn't fit even after evicting old2: deferred
    ]);
    const report = await syncStation(deps, scope);
    expect(report.plan.evict.map((e) => e.sha256)).toEqual([old1.sha256]);
    expect(report.fetched.map((f) => f.sha256)).toEqual([next.sha256]);
    expect(report.plan.deferred.map((d) => d.sha256)).toEqual([big.sha256]);
    const onDisk = (await scanCache(root)).map((f) => f.sha256).sort();
    expect(onDisk).toEqual([old2.sha256, pinned.sha256, next.sha256].sort());
    expect((await listCacheFiles(tdb.db, scope)).map((f) => f.sha256).sort()).toEqual(onDisk);

    const state = await getStationCache(tdb.db, scope);
    expect(state.deferred).toEqual([big.sha256]);
    const r = await cacheReadiness(tdb.db, scope, {
      from: new Date(now),
      to: new Date(now + 48 * HOUR),
    });
    expect(r.missing).toMatchObject([{ sha256: big.sha256, reason: 'deferred' }]);

    // A bigger budget lets the deferred file in on the next pass.
    await setStationCacheSettings(tdb.db, scope, { budgetBytes: 10_000 * KB });
    const later = await syncStation(deps, scope);
    expect(later.fetched.map((f) => f.sha256)).toEqual([big.sha256]);
    expect((await getStationCache(tdb.db, scope)).deferred).toEqual([]);
  });

  it('reconciles the table when a file disappears from disk', async () => {
    const scope = await tenant();
    const t = await track(scope, 20 * KB);
    await log(scope, [{ track: t, at: 15 }]);
    await syncStation(deps, scope);
    await rm(pathOf(scope, t), { force: true });
    const report = await syncStation(deps, scope);
    expect(report.fetched.map((f) => f.sha256)).toEqual([t.sha256]);
    expect(await readFile(pathOf(scope, t))).toEqual(t.bytes);
  });

  it('fetches one file urgently, outside any pass', async () => {
    const scope = await tenant();
    const t = await track(scope, 30 * KB);
    expect(await urgentFetch(deps, scope, t.assetFileId)).toEqual({ kind: 'fetched' });
    expect(await isPlayoutCached(tdb.db, scope, t.assetFileId)).toBe(true);
    expect(await urgentFetch(deps, scope, t.assetFileId)).toEqual({ kind: 'present' });
    const other = await tenant();
    expect(await urgentFetch(deps, other, t.assetFileId)).toEqual({ kind: 'unknown_file' });
  });
});

describe.skipIf(!enabled)('cache sync triggers', () => {
  let queue: QueueConnection;
  const eventQueue = `cache-sync-it-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    queue = await connectQueue(process.env.RABBITMQ_URL ?? 'amqp://ondes:ondes@127.0.0.1:5672', {
      prefix: `test-${randomUUID().slice(0, 8)}`,
    });
  });
  afterAll(async () => {
    await deleteEventQueue(queue.rabbit, queue.topology, eventQueue).catch(() => {});
    await queue?.close();
  });

  it('enqueues a pass on log changes in the horizon and on the sweep', async () => {
    const scope = await tenant();
    const enqueued: unknown[] = [];
    const jobs: JobPublisher = {
      async enqueue(job, payload) {
        enqueued.push({ job: job.name, payload });
        return {} as never;
      },
      close: async () => {},
    };
    const triggers = startCacheTriggers({
      queue,
      jobs,
      db: tdb.db,
      sweepIntervalMs: 0,
      eventQueue,
    });
    await triggers.ready;
    const events = createEventPublisher(queue.rabbit, queue.topology, realtimeEventSchema);
    const base = { stationId: scope.stationId, at: new Date().toISOString() } as const;
    await events.publish({
      ...base,
      id: randomUUID(),
      type: 'log.updated',
      data: {
        from: new Date(Date.now() - 400 * HOUR).toISOString(),
        to: new Date(Date.now() - 300 * HOUR).toISOString(),
        days: [],
        cause: 'edit',
      },
    });
    await events.publish({
      ...base,
      id: randomUUID(),
      type: 'log.updated',
      data: {
        from: new Date(Date.now() + HOUR).toISOString(),
        to: new Date(Date.now() + 2 * HOUR).toISOString(),
        days: [],
        cause: 'edit',
      },
    });
    const deadline = Date.now() + 10_000;
    while (enqueued.length < 1 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));
    expect(enqueued).toEqual([
      { job: 'cache-sync', payload: { orgId: scope.orgId, stationId: scope.stationId } },
    ]);

    enqueued.length = 0;
    const count = await triggers.sweep();
    expect(count).toBeGreaterThan(0);
    expect(enqueued).toContainEqual({
      job: 'cache-sync',
      payload: { orgId: scope.orgId, stationId: scope.stationId },
    });
    await events.close();
    await triggers.close();
  });
});
