import { randomBytes } from 'node:crypto';
import type { Actor, CreateAssetFile } from '@ondes/shared';
import { contentKey } from '@ondes/storage';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withAudit } from './audit.ts';
import { NotFoundError } from './errors.ts';
import {
  createAsset,
  deleteAsset,
  getAsset,
  getAssetDetail,
  LibraryConflictError,
  listAssets,
  listTags,
  putAssetFile,
  setAnalysis,
  setAssetTags,
  setAutoCues,
  setLoudness,
  updateAsset,
  updateCues,
} from './repos/library.ts';
import {
  createPostgresQuotaStore,
  setOrgStorageLimit,
  sweepStorageDeletions,
} from './repos/storage.ts';
import { createOrganization, createStation } from './repos/tenancy.ts';
import { assetFile } from './schema/library.ts';
import { storageDeletion, storageObject } from './schema/storage.ts';
import { auditLog } from './schema/tenancy.ts';
import { resolveOrgScope, resolveStationScope } from './tenant.ts';
import { createTestDatabase, type TestDatabase } from './testing.ts';

const system: Actor = { type: 'system', name: 'test' };

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(() => tdb?.drop());

let n = 0;
async function makeStation(label: string, orgId?: string) {
  n++;
  const org = orgId
    ? { id: orgId }
    : await createOrganization(tdb.db, system, { slug: `${label}-${n}`, name: label });
  const orgScope = await resolveOrgScope(tdb.db, org.id);
  const st = await createStation(
    tdb.db,
    { actor: system, scope: orgScope },
    { slug: `${label}-fm-${n}`, name: `${label} FM`, timezone: 'Europe/Paris' },
  );
  const scope = await resolveStationScope(tdb.db, org.id, st.id);
  return { orgId: org.id, scope, ctx: { actor: system, scope } };
}

/** Records bucket deletes instead of talking to S3. */
function fakeStorage(failing: string[] = []) {
  const deleted: string[] = [];
  return {
    deleted,
    delete: async (key: string) => {
      if (failing.includes(key)) throw new Error(`S3 down for ${key}`);
      deleted.push(key);
    },
  };
}

async function pendingDeletions(orgId: string): Promise<string[]> {
  const rows = await tdb.db
    .select({ key: storageDeletion.key })
    .from(storageDeletion)
    .where(eq(storageDeletion.orgId, orgId));
  return rows.map((r) => r.key);
}

function playoutFile(orgId: string, sizeBytes = 1000): CreateAssetFile {
  const sha256 = randomBytes(32).toString('hex');
  return {
    role: 'playout',
    storageKey: contentKey({ orgId, sha256, ext: 'flac' }),
    sha256,
    sizeBytes,
    codec: 'flac',
    sampleRate: 44_100,
    channels: 2,
    bitDepth: 16,
    durationSamples: 44_100 * 180,
    flacBlockSize: 1024,
  };
}

async function auditActions(entityId: string) {
  const rows = await tdb.db
    .select({ action: auditLog.action, stationId: auditLog.stationId })
    .from(auditLog)
    .where(eq(auditLog.entityId, entityId))
    .orderBy(auditLog.at, auditLog.id);
  return rows;
}

async function refCount(orgId: string, key: string) {
  const [row] = await tdb.db
    .select({ refCount: storageObject.refCount })
    .from(storageObject)
    .where(and(eq(storageObject.orgId, orgId), eq(storageObject.key, key)));
  return row?.refCount ?? 0;
}

describe('assets', () => {
  it('creates, reads and updates an asset with audit rows', async () => {
    const { scope, ctx } = await makeStation('alpha');
    const a = await createAsset(tdb.db, ctx, {
      type: 'song',
      title: 'Mistral',
      artists: ['Nina', 'Paul'],
      isrc: 'fr-z03-14-00123',
    });
    expect(a.isrc).toBe('FRZ031400123');
    expect(a.explicit).toBe(false);
    expect(a.metadata).toEqual({});

    const updated = await updateAsset(tdb.db, ctx, a.id, {
      album: 'Vents',
      startAt: '2026-11-01T00:00:00+01:00',
    });
    expect(updated.album).toBe('Vents');
    expect(updated.startAt?.toISOString()).toBe('2026-10-31T23:00:00.000Z');
    await expect(
      updateAsset(tdb.db, ctx, a.id, { killAt: new Date('2026-10-01T00:00:00Z') }),
    ).rejects.toThrow(LibraryConflictError);

    expect((await getAsset(tdb.db, scope, a.id)).title).toBe('Mistral');
    expect(await auditActions(a.id)).toEqual([
      { action: 'asset.create', stationId: scope.stationId },
      { action: 'asset.update', stationId: scope.stationId },
    ]);
  });

  it('isolates tenants', async () => {
    const a = await makeStation('alpha');
    const b = await makeStation('bravo');
    // Same org, other station: still isolated.
    const a2 = await makeStation('alpha-two', a.orgId);
    const mine = await createAsset(tdb.db, a.ctx, { type: 'jingle', title: 'ID' });

    for (const other of [b, a2]) {
      await expect(getAsset(tdb.db, other.scope, mine.id)).rejects.toThrow(NotFoundError);
      await expect(getAssetDetail(tdb.db, other.scope, mine.id)).rejects.toThrow(NotFoundError);
      await expect(updateAsset(tdb.db, other.ctx, mine.id, { title: 'x' })).rejects.toThrow(
        NotFoundError,
      );
      await expect(
        updateCues(tdb.db, other.ctx, mine.id, { sampleRate: 44_100, cueIn: { samples: 0 } }),
      ).rejects.toThrow(NotFoundError);
      await expect(
        setAssetTags(tdb.db, other.ctx, mine.id, { tags: [{ key: 'genre', value: 'x' }] }),
      ).rejects.toThrow(NotFoundError);
      await expect(
        putAssetFile(tdb.db, other.ctx, mine.id, playoutFile(other.orgId)),
      ).rejects.toThrow(NotFoundError);
      await expect(deleteAsset(tdb.db, other.ctx, mine.id)).rejects.toThrow(NotFoundError);
      expect((await listAssets(tdb.db, other.scope)).items).toEqual([]);
    }
    expect((await getAsset(tdb.db, a.scope, mine.id)).title).toBe('ID');
  });

  it('refuses rows that point at another tenant in the database', async () => {
    const a = await makeStation('alpha');
    const b = await makeStation('bravo');
    const mine = await createAsset(tdb.db, a.ctx, { type: 'song', title: 'x' });
    const file = playoutFile(b.orgId);
    await expect(
      tdb.db.insert(assetFile).values({
        ...file,
        assetId: mine.id,
        orgId: b.orgId,
        stationId: b.scope.stationId,
      }),
    ).rejects.toThrow();
    // A storage key under another org's prefix is refused before touching the database.
    await expect(putAssetFile(tdb.db, a.ctx, mine.id, playoutFile(b.orgId))).rejects.toThrow(
      LibraryConflictError,
    );
  });

  it('lists with filters and keyset pagination', async () => {
    const { scope, ctx } = await makeStation('alpha');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const created = await createAsset(tdb.db, ctx, {
        type: i % 2 === 0 ? 'song' : 'jingle',
        title: `Track ${i}`,
        artists: [i === 3 ? 'Zoé 100%' : 'Someone'],
      });
      ids.push(created.id);
    }
    await setAssetTags(tdb.db, ctx, ids[0] as string, {
      tags: [{ key: 'genre', value: 'Jazz' }],
    });

    const first = await listAssets(tdb.db, scope, { limit: 2 });
    expect(first.items.map((a) => a.id)).toEqual([ids[4], ids[3]]);
    const second = await listAssets(tdb.db, scope, { limit: 2, cursor: first.nextCursor ?? '' });
    expect(second.items.map((a) => a.id)).toEqual([ids[2], ids[1]]);
    const last = await listAssets(tdb.db, scope, { limit: 2, cursor: second.nextCursor ?? '' });
    expect(last.items.map((a) => a.id)).toEqual([ids[0]]);
    expect(last.nextCursor).toBeNull();

    expect((await listAssets(tdb.db, scope, { type: 'jingle' })).items).toHaveLength(2);
    expect((await listAssets(tdb.db, scope, { q: '100%' })).items.map((a) => a.id)).toEqual([
      ids[3],
    ]);
    expect((await listAssets(tdb.db, scope, { q: 'track 2' })).items.map((a) => a.id)).toEqual([
      ids[2],
    ]);
    expect((await listAssets(tdb.db, scope, { tag: 'genre:jazz' })).items.map((a) => a.id)).toEqual(
      [ids[0]],
    );
  });
});

describe('cues', () => {
  it('stores sample positions, keeps manual and locked points from autocue', async () => {
    const { scope, ctx } = await makeStation('alpha');
    const a = await createAsset(tdb.db, ctx, { type: 'song', title: 'x' });

    await expect(updateCues(tdb.db, ctx, a.id, { cueIn: { samples: 10 } })).rejects.toThrow(
      LibraryConflictError,
    );

    const auto = await setAutoCues(tdb.db, ctx, a.id, {
      sampleRate: 44_100,
      analyzerVersion: 'autocue-1',
      points: { cueIn: 2048, cueOut: 7_938_000, fadeOut: 88_200, outroStart: 7_000_000 },
    });
    expect(auto.cueIn).toEqual({ samples: 2048, source: 'auto', locked: false });
    expect(auto.analyzerVersion).toBe('autocue-1');

    const edited = await updateCues(tdb.db, ctx, a.id, {
      cueIn: { samples: 4096 },
      outroStart: { locked: true },
    });
    expect(edited.cueIn).toEqual({ samples: 4096, source: 'manual', locked: false });
    expect(edited.outroStart).toEqual({ samples: 7_000_000, source: 'auto', locked: true });

    const rerun = await setAutoCues(tdb.db, ctx, a.id, {
      sampleRate: 44_100,
      analyzerVersion: 'autocue-2',
      points: { cueIn: 1024, outroStart: 6_000_000, cueOut: 7_900_000 },
    });
    expect(rerun.cueIn.samples).toBe(4096);
    expect(rerun.outroStart.samples).toBe(7_000_000);
    expect(rerun.cueOut).toEqual({ samples: 7_900_000, source: 'auto', locked: false });

    await expect(
      setAutoCues(tdb.db, ctx, a.id, { sampleRate: 48_000, analyzerVersion: 'x', points: {} }),
    ).rejects.toThrow(LibraryConflictError);
    await expect(updateCues(tdb.db, ctx, a.id, { cueOut: { samples: 100 } })).rejects.toThrow(
      LibraryConflictError,
    );

    const detail = await getAssetDetail(tdb.db, scope, a.id);
    expect(detail.cues?.sampleRate).toBe(44_100);
    expect((await auditActions(a.id)).map((r) => r.action)).toEqual([
      'asset.create',
      'asset_cues.autocue',
      'asset_cues.update',
      'asset_cues.autocue',
    ]);
  });
});

describe('loudness, analysis and tags', () => {
  it('upserts measurements and replaces tag sets', async () => {
    const { scope, ctx } = await makeStation('alpha');
    const a = await createAsset(tdb.db, ctx, { type: 'song', title: 'x' });
    const b = await createAsset(tdb.db, ctx, { type: 'song', title: 'y' });

    await setLoudness(tdb.db, ctx, a.id, {
      integratedLufs: -9.5,
      loudnessRangeLu: 6,
      truePeakDbtp: 0.3,
      analyzer: 'ffmpeg-ebur128',
      analyzerVersion: '8.0',
    });
    const loud = await setLoudness(tdb.db, ctx, a.id, {
      integratedLufs: -9.8,
      analyzer: 'ffmpeg-ebur128',
      analyzerVersion: '8.1',
      confidence: 1,
    });
    expect(loud).toMatchObject({ integratedLufs: -9.8, analyzerVersion: '8.1', confidence: 1 });

    await setAnalysis(tdb.db, ctx, a.id, {
      bpm: 122,
      musicalKey: 'F#m',
      energy: 0.7,
      confidence: 0.8,
      analyzer: 'aubio',
      analyzerVersion: '0.4.9',
    });

    await setAssetTags(tdb.db, ctx, a.id, {
      tags: [
        { key: 'genre', value: 'Jazz' },
        { key: 'genre', value: 'jazz' },
        { key: 'genre', value: 'Soul' },
        { key: 'mood', value: 'Warm' },
      ],
    });
    await setAssetTags(tdb.db, ctx, b.id, { tags: [{ key: 'genre', value: 'JAZZ' }] });
    const after = await setAssetTags(tdb.db, ctx, a.id, {
      tags: [
        { key: 'genre', value: 'jazz' },
        { key: 'era', value: '1970s' },
      ],
    });
    expect(after.map((t) => `${t.key}:${t.value}`)).toEqual(['era:1970s', 'genre:Jazz']);
    expect((await listTags(tdb.db, scope)).map((t) => `${t.key}:${t.value}`)).toEqual([
      'era:1970s',
      'genre:Jazz',
      'genre:Soul',
      'mood:Warm',
    ]);

    const detail = await getAssetDetail(tdb.db, scope, a.id);
    expect(detail.loudness?.integratedLufs).toBeCloseTo(-9.8);
    expect(detail.analysis).toMatchObject({ bpm: 122, musicalKey: 'F#m' });
    expect(detail.tags).toHaveLength(2);
    expect((await auditActions(a.id)).map((r) => r.action)).toEqual([
      'asset.create',
      'asset_loudness.set',
      'asset_loudness.set',
      'asset_analysis.set',
      'asset.tag',
      'asset.tag',
    ]);
  });
});

describe('stored objects', () => {
  it('charges one content key once, however many assets reference it concurrently', async () => {
    const { orgId, ctx } = await makeStation('alpha');
    const file = playoutFile(orgId, 5_000);
    const assets = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createAsset(tdb.db, ctx, { type: 'song', title: `${i}` }),
      ),
    );
    await Promise.all(assets.map((a) => putAssetFile(tdb.db, ctx, a.id, file)));

    expect(await refCount(orgId, file.storageKey)).toBe(8);
    expect((await createPostgresQuotaStore(tdb.db).get(orgId)).usedBytes).toBe(5_000);
    for (const a of assets) {
      expect((await auditActions(a.id)).map((r) => r.action)).toContain('asset_file.put');
    }
  });

  it('counts references atomically under concurrency', async () => {
    const { orgId } = await makeStation('alpha');
    const store = createPostgresQuotaStore(tdb.db);
    const key = playoutFile(orgId).storageKey;
    const added = await Promise.all(
      Array.from({ length: 20 }, () => store.addReference(orgId, key, 700)),
    );
    expect(added.filter((r) => r.firstReference)).toHaveLength(1);
    expect((await store.get(orgId)).usedBytes).toBe(700);

    const removed = await Promise.all(
      Array.from({ length: 21 }, () => store.removeReference(orgId, key)),
    );
    expect(removed.filter((r) => r.lastReference)).toHaveLength(1);
    expect(await store.get(orgId)).toEqual({ usedBytes: 0, limitBytes: null });
    expect(await refCount(orgId, key)).toBe(0);

    await setOrgStorageLimit(tdb.db, orgId, 1_000_000);
    await store.set(orgId, 42);
    expect(await store.get(orgId)).toEqual({ usedBytes: 42, limitBytes: 1_000_000 });
  });

  it('deletes an object only with its last reference', async () => {
    const { orgId, scope, ctx } = await makeStation('alpha');
    const shared = playoutFile(orgId, 3_000);
    const a = await createAsset(tdb.db, ctx, { type: 'song', title: 'a' });
    const b = await createAsset(tdb.db, ctx, { type: 'song', title: 'b' });
    const sha = randomBytes(32).toString('hex');
    const master: CreateAssetFile = {
      role: 'master',
      storageKey: contentKey({ orgId, sha256: sha, ext: 'wav' }),
      sha256: sha,
      sizeBytes: 10_000,
      codec: 'pcm_s24le',
      sampleRate: 48_000,
    };
    await putAssetFile(tdb.db, ctx, a.id, shared);
    await putAssetFile(tdb.db, ctx, a.id, master);
    await putAssetFile(tdb.db, ctx, b.id, shared);
    await setAutoCues(tdb.db, ctx, a.id, {
      sampleRate: 44_100,
      analyzerVersion: 'x',
      points: { cueIn: 0 },
    });
    await setAssetTags(tdb.db, ctx, a.id, { tags: [{ key: 'mood', value: 'calm' }] });
    const store = createPostgresQuotaStore(tdb.db);
    expect((await store.get(orgId)).usedBytes).toBe(13_000);

    expect(await deleteAsset(tdb.db, ctx, a.id)).toEqual({ scheduled: [master.storageKey] });
    expect(await refCount(orgId, shared.storageKey)).toBe(1);
    expect((await store.get(orgId)).usedBytes).toBe(3_000);
    await expect(getAsset(tdb.db, scope, a.id)).rejects.toThrow(NotFoundError);

    // The shared object goes with its last reference: queued, never deleted inline.
    expect(await deleteAsset(tdb.db, ctx, b.id)).toEqual({ scheduled: [shared.storageKey] });
    expect(await refCount(orgId, shared.storageKey)).toBe(0);
    expect((await store.get(orgId)).usedBytes).toBe(0);
    expect((await pendingDeletions(orgId)).sort()).toEqual(
      [master.storageKey, shared.storageKey].sort(),
    );
    const left = await tdb.db.execute(
      sql`select count(*)::int as n from asset where station_id = ${scope.stationId}`,
    );
    expect(left[0]).toEqual({ n: 0 });
    expect((await auditActions(a.id)).map((r) => r.action).at(-1)).toBe('asset.delete');
  });

  it('releases the replaced file of a role, and rolls back the charge on failure', async () => {
    const { orgId, ctx } = await makeStation('alpha');
    const a = await createAsset(tdb.db, ctx, { type: 'song', title: 'a' });
    const v1 = playoutFile(orgId, 100);
    const v2 = playoutFile(orgId, 200);
    await putAssetFile(tdb.db, ctx, a.id, v1);
    const { released } = await putAssetFile(tdb.db, ctx, a.id, v2);
    expect(released.scheduled).toEqual([v1.storageKey]);
    expect(await refCount(orgId, v1.storageKey)).toBe(0);
    expect((await createPostgresQuotaStore(tdb.db).get(orgId)).usedBytes).toBe(200);

    // A charge made inside a failed mutation rolls back with it.
    const extra = playoutFile(orgId, 999).storageKey;
    await expect(
      withAudit(tdb.db, ctx, async (tx) => {
        await createPostgresQuotaStore(tx).addReference(orgId, extra, 999);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await refCount(orgId, extra)).toBe(0);
    expect((await createPostgresQuotaStore(tdb.db).get(orgId)).usedBytes).toBe(200);
  });

  it('refuses non-FLAC playout copies in the database too', async () => {
    const { orgId, ctx } = await makeStation('alpha');
    const a = await createAsset(tdb.db, ctx, { type: 'song', title: 'a' });
    const file = playoutFile(orgId);
    await expect(
      tdb.db.insert(assetFile).values({
        ...file,
        codec: 'mp3',
        assetId: a.id,
        orgId,
        stationId: ctx.scope.stationId,
      }),
    ).rejects.toThrow();
    await expect(putAssetFile(tdb.db, ctx, a.id, { ...file, codec: 'aac' })).rejects.toThrow(
      /FLAC/,
    );
  });
});

describe('storage sweep', () => {
  it('deletes released objects after the grace period, keeps revived ones, retries failures', async () => {
    const { orgId, ctx } = await makeStation('sweep');
    const store = createPostgresQuotaStore(tdb.db);
    const [gone, revived, flaky] = [1, 2, 3].map((n) => playoutFile(orgId, n * 100));
    for (const file of [gone, revived, flaky] as CreateAssetFile[]) {
      const a = await createAsset(tdb.db, ctx, { type: 'song', title: 'x' });
      await putAssetFile(tdb.db, ctx, a.id, file);
      await deleteAsset(tdb.db, ctx, a.id);
    }
    expect((await pendingDeletions(orgId)).length).toBe(3);

    // Within the grace period nothing is touched.
    const early = fakeStorage();
    expect(await sweepStorageDeletions(tdb.db, early)).toEqual({
      deleted: [],
      revived: [],
      failed: [],
    });

    // Re-uploaded after release: a new reference cancels the pending delete.
    const again = await createAsset(tdb.db, ctx, { type: 'song', title: 'again' });
    await putAssetFile(tdb.db, ctx, again.id, revived as CreateAssetFile);
    expect(await pendingDeletions(orgId)).not.toContain(revived?.storageKey);

    const s3 = fakeStorage([flaky?.storageKey as string]);
    const result = await sweepStorageDeletions(tdb.db, s3, { graceMs: 0, limit: 1000 });
    // The sweep is global (other tests' releases are swept too): check this org's keys.
    expect(result.deleted).toContain(gone?.storageKey);
    expect(result.deleted).not.toContain(revived?.storageKey);
    expect(result.deleted).not.toContain(flaky?.storageKey);
    expect(result.failed).toEqual([flaky?.storageKey]);
    expect(s3.deleted).toContain(gone?.storageKey);
    // The failed one stays queued, with its error, for the next sweep.
    const [kept] = await tdb.db
      .select()
      .from(storageDeletion)
      .where(eq(storageDeletion.orgId, orgId));
    expect(kept).toMatchObject({ key: flaky?.storageKey, attempts: 1 });
    expect(kept?.lastError).toContain('S3 down');
    expect((await store.get(orgId)).usedBytes).toBe(200);
  });
});
