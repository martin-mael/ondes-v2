import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  createAsset,
  createOrganization,
  createStation,
  listAssetFiles,
  listAssetsNeedingPeaks,
  putAssetFile,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import type { JobPublisher } from '@ondes/queue';
import {
  type Actor,
  decodePeaks,
  PEAKS_LEVELS,
  type PeaksJobPayload,
  peaksPointOfSample,
  peaksStorageKey,
} from '@ondes/shared';
import { contentKey, createS3Storage, loadStorageConfig, type Storage } from '@ondes/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultTools, ToolError } from '../ingest/ffmpeg.ts';
import { backfillPeaks } from './backfill.ts';
import { finishPeaks, PeaksAccumulator } from './compute.ts';
import { decodePcm16 } from './decode.ts';
import { generateAssetPeaks, type PeaksDeps } from './peaks.ts';

// Peaks of generated audio, decoded by the ffmpeg on the PATH: use the worker image's
// (apps/worker/test/bin), as CI does. The job tests also need the dev Postgres and Garage
// (skipped without S3_ENDPOINT, like the loudness tests).

const exec = promisify(execFile);
const enabled = Boolean(process.env.S3_ENDPOINT);
if (!enabled) {
  // CI always provides Garage: missing there is a broken setup, not a reason to skip.
  if (process.env.CI) throw new Error('peaks job tests need S3_ENDPOINT (Garage) in CI');
  console.warn('peaks job tests skipped: S3_ENDPOINT is not set (pnpm dev:up, .env.example)');
}
const system: Actor = { type: 'system', name: 'test' };
const tools = defaultTools();

let dir: string;
const files: Record<string, string> = {};

/** A FLAC like a playout copy (44.1 kHz, 1024-sample blocks), one `aevalsrc` expression per channel. */
async function flac(name: string, exprs: string[], seconds: number, sampleFmt = 's16') {
  const path = join(dir, `${name}.flac`);
  await exec(tools.ffmpeg, [
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=${exprs.join('|')}:s=44100:d=${seconds}`,
    '-c:a',
    'flac',
    '-frame_size',
    '1024',
    '-sample_fmt',
    sampleFmt,
    ...(sampleFmt === 's32' ? ['-bits_per_raw_sample', '24'] : []),
    path,
  ]);
  files[name] = path;
}

async function peaksOf(path: string, channels: number) {
  const accumulator = new PeaksAccumulator(channels, PEAKS_LEVELS[0]);
  await decodePcm16(tools, path, { channels, onSamples: (s) => accumulator.push(s) });
  return finishPeaks(accumulator, 44_100);
}

/** [min, max] of every point of a level's channel. */
function pairs(values: Int8Array, channels: number, ch: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = ch * 2; i < values.length; i += channels * 2) {
    out.push([values[i] as number, values[i + 1] as number]);
  }
  return out;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ondes-peaks-test-'));
  // Left at −6 dBFS, right at −12 dBFS: channels must stay apart.
  await flac('stereo', ['0.5*sin(2*PI*997*t)', '0.25*sin(2*PI*997*t)'], 3);
  // Silence with a full-scale burst on samples [44100, 45100): sample-accurate placement.
  await flac('burst', ['if(between(n\\,44100\\,45099)\\,0.9\\,0)'], 2);
  // 24-bit mono, like a playout copy of a lossless source.
  await flac('deep', ['0.5*sin(2*PI*441*t)'], 1, 's32');
  files.corrupt = join(dir, 'corrupt.flac');
  await writeFile(files.corrupt, Buffer.concat([Buffer.from('fLaC'), randomBytes(4096)]));
}, 60_000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('peaks of decoded audio (ffmpeg)', () => {
  it('traces each channel of a stereo sine at every level', async () => {
    const peaks = await peaksOf(files.stereo as string, 2);
    expect(peaks).toMatchObject({ sampleRate: 44_100, channels: 2, lengthSamples: 3 * 44_100 });
    expect(peaks.levels.map((l) => [l.samplesPerPoint, l.points])).toEqual([
      [256, Math.ceil((3 * 44_100) / 256)],
      [4096, Math.ceil((3 * 44_100) / 4096)],
    ]);
    for (const level of peaks.levels) {
      // ffmpeg scales floats by 32768: 0.5 is ±16384, ±64 at 8 bits; 0.25 is ±8192, ±32.
      // A 997 Hz sine doesn't hit its crest on every point: one step of slack.
      for (const [lo, hi] of pairs(level.values, 2, 0)) {
        expect(lo).toBeGreaterThanOrEqual(-64);
        expect(lo).toBeLessThanOrEqual(-63);
        expect(hi).toBeGreaterThanOrEqual(63);
        expect(hi).toBeLessThanOrEqual(64);
      }
      for (const [lo, hi] of pairs(level.values, 2, 1)) {
        expect(lo).toBeGreaterThanOrEqual(-32);
        expect(lo).toBeLessThanOrEqual(-31);
        expect(hi).toBeGreaterThanOrEqual(31);
        expect(hi).toBeLessThanOrEqual(32);
      }
    }
  });

  it('places a burst on the points holding its samples', async () => {
    const peaks = await peaksOf(files.burst as string, 1);
    for (const level of peaks.levels) {
      const spp = level.samplesPerPoint;
      const loud = pairs(level.values, 1, 0).flatMap(([, hi], p) => (hi > 0 ? [p] : []));
      const first = peaksPointOfSample(44_100, spp);
      const last = peaksPointOfSample(45_099, spp);
      expect(loud).toEqual(Array.from({ length: last - first + 1 }, (_, i) => first + i));
    }
  });

  it('reads 24-bit mono', async () => {
    const peaks = await peaksOf(files.deep as string, 1);
    expect(peaks).toMatchObject({ channels: 1, lengthSamples: 44_100 });
    const [lo, hi] = pairs(peaks.levels[1]?.values ?? new Int8Array(), 1, 0)[0] ?? [];
    expect([lo, hi]).toEqual([-64, 64]);
  });

  it('rejects a broken file as a file error', async () => {
    await expect(peaksOf(files.corrupt as string, 2)).rejects.toBeInstanceOf(ToolError);
  });
});

describe.skipIf(!enabled)('peaks job (integration)', () => {
  let tdb: TestDatabase;
  let storage: Storage;
  let deps: PeaksDeps;
  let n = 0;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    storage = createS3Storage(loadStorageConfig());
    deps = { db: tdb.db, storage, tools };
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  async function tenant() {
    n++;
    const org = await createOrganization(tdb.db, system, { slug: `peaks-${n}`, name: 'Org' });
    const st = await createStation(
      tdb.db,
      { actor: system, scope: await resolveOrgScope(tdb.db, org.id) },
      { slug: `peaks-fm-${n}`, name: 'FM', timezone: 'Europe/Paris' },
    );
    return resolveStationScope(tdb.db, org.id, st.id);
  }

  /**
   * An ingested asset whose playout copy is `name` (its hash salted, so keys never collide
   * across runs), or the given copy shared with another asset.
   */
  async function ingested(
    scope: StationScope,
    name: string,
    shared?: { sha256: string; storageKey: string; sizeBytes: number },
  ) {
    let file = shared;
    if (!file) {
      const bytes = await readFile(files[name] as string);
      const sha256 = createHash('sha256').update(bytes).update(randomBytes(8)).digest('hex');
      const storageKey = contentKey({ orgId: scope.orgId, sha256, ext: 'flac' });
      await storage.put(storageKey, bytes);
      file = { sha256, storageKey, sizeBytes: bytes.length };
    }
    const ctx = { actor: system, scope };
    const asset = await createAsset(tdb.db, ctx, { type: 'song', title: name });
    await putAssetFile(tdb.db, ctx, asset.id, {
      role: 'playout',
      ...file,
      codec: 'flac',
      mimeType: 'audio/flac',
      sampleRate: 44_100,
      channels: 2,
      bitDepth: 16,
      durationSamples: 3 * 44_100,
      flacBlockSize: 1024,
    });
    const payload: PeaksJobPayload = {
      orgId: scope.orgId,
      stationId: scope.stationId,
      assetId: asset.id,
      playoutSha256: file.sha256,
    };
    return { asset, payload, file };
  }

  const storageObjects = async (orgId: string) =>
    (await tdb.sql<{ key: string }[]>`select key from storage_object where org_id = ${orgId}`).map(
      (row) => row.key,
    );

  const peaksFile = async (scope: StationScope, assetId: string) =>
    (await listAssetFiles(tdb.db, scope, assetId)).find((f) => f.role === 'peaks');

  it('stores the peaks file content-addressed and records it on the asset', async () => {
    const scope = await tenant();
    const { asset, payload } = await ingested(scope, 'stereo');
    expect(await generateAssetPeaks(deps, payload)).toBe('stored');

    const file = await peaksFile(scope, asset.id);
    const key = peaksStorageKey(scope.orgId, payload.playoutSha256);
    expect(file).toMatchObject({
      storageKey: key,
      codec: 'ondes-peaks',
      mimeType: 'application/vnd.ondes.peaks',
      sampleRate: 44_100,
      channels: 2,
      durationSamples: 3 * 44_100,
    });
    const { body } = await storage.get(key);
    const bytes = Buffer.concat(await body.toArray());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file?.sha256);
    expect(bytes.length).toBe(file?.sizeBytes);
    const peaks = decodePeaks(bytes);
    expect(peaks).toMatchObject({ channels: 2, lengthSamples: 3 * 44_100 });
    expect(peaks.levels.map((l) => l.samplesPerPoint)).toEqual([...PEAKS_LEVELS]);

    // Again: nothing to do.
    expect(await generateAssetPeaks(deps, payload)).toBe('current');
  });

  it('reuses the stored object for another asset with the same playout copy', async () => {
    const scope = await tenant();
    const first = await ingested(scope, 'stereo');
    expect(await generateAssetPeaks(deps, first.payload)).toBe('stored');
    const second = await ingested(scope, 'stereo', first.file);
    // No ffmpeg: the object is found, not recomputed.
    const offline = { ...deps, tools: { ffmpeg: '/nonexistent', ffprobe: '/nonexistent' } };
    expect(await generateAssetPeaks(offline, second.payload)).toBe('stored');
    expect((await peaksFile(scope, second.asset.id))?.sha256).toBe(
      (await peaksFile(scope, first.asset.id))?.sha256,
    );
  });

  it('records nothing for a replaced playout copy or a deleted asset', async () => {
    const scope = await tenant();
    const { asset, payload } = await ingested(scope, 'stereo');
    expect(await generateAssetPeaks(deps, { ...payload, playoutSha256: 'f'.repeat(64) })).toBe(
      'stale',
    );
    expect(await peaksFile(scope, asset.id)).toBeUndefined();
    const gone = { ...payload, assetId: '0199f6a0-0000-7000-8000-00000000dead' };
    expect(await generateAssetPeaks(deps, gone)).toBe('stale');
  });

  it('logs an undecodable playout copy and records nothing', async () => {
    const scope = await tenant();
    const { asset, payload } = await ingested(scope, 'corrupt');
    const logs: Record<string, unknown>[] = [];
    expect(await generateAssetPeaks({ ...deps, log: (e) => logs.push(e) }, payload)).toBe(
      'unreadable',
    );
    expect(logs).toMatchObject([{ level: 'warn', msg: 'peaks: playout copy not decodable' }]);
    expect(await peaksFile(scope, asset.id)).toBeUndefined();
  });

  it('records and writes nothing when the playout copy is replaced mid-job', async () => {
    const scope = await tenant();
    const { asset, payload } = await ingested(scope, 'stereo');
    const ctx = { actor: system, scope };
    const racing: PeaksDeps = {
      ...deps,
      // A re-ingest lands after the peaks were computed, before they are recorded.
      beforeRecord: async () => {
        await putAssetFile(tdb.db, ctx, asset.id, {
          role: 'playout',
          storageKey: contentKey({ orgId: scope.orgId, sha256: 'e'.repeat(64), ext: 'flac' }),
          sha256: 'e'.repeat(64),
          sizeBytes: 1,
          codec: 'flac',
          sampleRate: 44_100,
          flacBlockSize: 1024,
        });
      },
    };
    expect(await generateAssetPeaks(racing, payload)).toBe('stale');
    expect(await peaksFile(scope, asset.id)).toBeUndefined();
    // Not written either: nothing in the bucket that no one references.
    expect(await storage.head(peaksStorageKey(scope.orgId, payload.playoutSha256))).toBeNull();
    expect(await storageObjects(scope.orgId)).not.toContain(
      peaksStorageKey(scope.orgId, payload.playoutSha256),
    );
  });

  it('rewrites an object swept between finding it and charging it', async () => {
    const scope = await tenant();
    const first = await ingested(scope, 'stereo');
    expect(await generateAssetPeaks(deps, first.payload)).toBe('stored');
    const key = peaksStorageKey(scope.orgId, first.payload.playoutSha256);
    const second = await ingested(scope, 'stereo', first.file);
    const sweeping: PeaksDeps = {
      ...deps,
      // What a sweep could do if the first asset had just been deleted.
      beforeRecord: async () => storage.delete(key),
    };
    expect(await generateAssetPeaks(sweeping, second.payload)).toBe('stored');
    const head = await storage.head(key);
    expect(head?.metadata.sha256).toBe((await peaksFile(scope, second.asset.id))?.sha256);
    // Two decodes through the worker image's ffmpeg (`docker run` each).
  }, 60_000);

  it('restores a recorded peaks file missing from the bucket', async () => {
    const scope = await tenant();
    const { asset, payload } = await ingested(scope, 'stereo');
    expect(await generateAssetPeaks(deps, payload)).toBe('stored');
    const recorded = await peaksFile(scope, asset.id);
    const key = peaksStorageKey(scope.orgId, payload.playoutSha256);
    await storage.delete(key);
    expect(await generateAssetPeaks(deps, payload)).toBe('stored');
    expect((await storage.head(key))?.metadata.sha256).toBe(recorded?.sha256);
    // Same bytes, so the record is untouched.
    expect(await peaksFile(scope, asset.id)).toEqual(recorded);
    expect(await generateAssetPeaks(deps, payload)).toBe('current');
    // Two decodes through the worker image's ffmpeg (`docker run` each).
  }, 60_000);

  it('retries a short download instead of giving up on the file', async () => {
    const scope = await tenant();
    const { payload, file } = await ingested(scope, 'stereo');
    // The bucket holds fewer bytes than the asset recorded.
    const bytes = await readFile(files.stereo as string);
    await storage.put(file.storageKey, bytes.subarray(0, 100));
    await expect(generateAssetPeaks(deps, payload)).rejects.toThrow(/downloaded 100 of/);
  });

  it('backfills the assets without current peaks', async () => {
    const scope = await tenant();
    const done = await ingested(scope, 'stereo');
    await generateAssetPeaks(deps, done.payload);
    const missing = await ingested(scope, 'burst');
    expect(await listAssetsNeedingPeaks(tdb.db, scope)).toEqual([
      { assetId: missing.asset.id, playoutSha256: missing.payload.playoutSha256 },
    ]);

    const enqueued: unknown[] = [];
    const jobs: JobPublisher = {
      async enqueue(job, payload, options) {
        enqueued.push({ name: job.name, payload, key: options?.idempotencyKey });
        return {} as Awaited<ReturnType<JobPublisher['enqueue']>>;
      },
      close: async () => {},
    };
    const counts = await backfillPeaks(
      { db: tdb.db, jobs },
      { stationIds: [scope.stationId], batchSize: 1 },
    );
    expect(counts).toEqual({ [scope.stationId]: 1 });
    expect(enqueued).toEqual([
      {
        name: 'peaks',
        payload: missing.payload,
        key: `peaks:${missing.asset.id}:${missing.payload.playoutSha256}:v1`,
      },
    ]);
  });
});
