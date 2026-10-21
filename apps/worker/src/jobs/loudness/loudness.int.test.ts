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
  getAssetDetail,
  getLoudness,
  putAssetFile,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
  updateAsset,
  updateStation,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import type { JobPublisher } from '@ondes/queue';
import type { Actor } from '@ondes/shared';
import { contentKey, createS3Storage, loadStorageConfig, type Storage } from '@ondes/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultTools } from '../ingest/ffmpeg.ts';
import { backfillLoudness } from './backfill.ts';
import { measureLoudness } from './ebur128.ts';
import { type LoudnessDeps, measureAssetLoudness } from './loudness.ts';

// Loudness against generated tones at known levels, measured by the ffmpeg on the PATH: use
// the worker image's (apps/worker/test/bin), as CI does. The job tests also need the dev
// Postgres and Garage (skipped without S3_ENDPOINT, like the ingest tests).
//
// BS.1770 is calibrated so that a 997 Hz sine at 0 dBFS on both channels of a stereo signal
// reads 0 LUFS, and its true peak is its amplitude: a sine of amplitude 0.1 (−20 dBFS) on both
// channels is −20 LUFS and −20 dBTP.

const exec = promisify(execFile);
const enabled = Boolean(process.env.S3_ENDPOINT);
const system: Actor = { type: 'system', name: 'test' };
const tools = defaultTools();
const TOLERANCE = 0.3;

let dir: string;
const tones: Record<string, string> = {};

/**
 * A FLAC tone like a playout copy (44.1 kHz, 1024-sample blocks): `expr` on every channel at
 * full level (ffmpeg's mono-to-stereo upmix would lower each channel by 3 dB).
 */
async function tone(name: string, expr: string, seconds: number, channels: number) {
  const source = `aevalsrc=${Array(channels).fill(expr).join('|')}:s=44100:d=${seconds}`;
  const path = join(dir, `${name}.flac`);
  await exec(tools.ffmpeg, [
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    source,
    '-ar',
    '44100',
    '-c:a',
    'flac',
    '-frame_size',
    '1024',
    '-sample_fmt',
    's16',
    path,
  ]);
  tones[name] = path;
}

const sine = (amplitude: number) => `${amplitude}*sin(2*PI*997*t)`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ondes-loudness-test-'));
  await tone('minus20', sine(0.1), 10, 2);
  await tone('mono', sine(0.1), 10, 1);
  // −10 LUFS, peaks at −10 dBTP.
  await tone('loud', sine(0.316228), 10, 2);
  // 15 s at −20 LUFS then 15 s at −30 LUFS: a 10 LU loudness range.
  await tone('range', 'if(lt(t\\,15)\\,0.1\\,0.0316228)*sin(2*PI*997*t)', 30, 2);
  await tone('silence', '0', 5, 2);
  tones.corrupt = join(dir, 'corrupt.flac');
  await writeFile(tones.corrupt, Buffer.concat([Buffer.from('fLaC'), randomBytes(4096)]));
}, 60_000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('measureLoudness (ffmpeg ebur128)', () => {
  it('measures a −20 LUFS stereo sine', async () => {
    const result = await measureLoudness(tools, tones.minus20 as string, { channels: 2 });
    expect(result.integratedLufs).toBeCloseTo(-20, 0);
    expect(Math.abs(result.integratedLufs + 20)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs((result.truePeakDbtp ?? 0) + 20)).toBeLessThanOrEqual(TOLERANCE);
    expect(result.loudnessRangeLu).toBeLessThanOrEqual(1);
  });

  it('measures a loud sine and its true peak', async () => {
    const result = await measureLoudness(tools, tones.loud as string, { channels: 2 });
    expect(Math.abs(result.integratedLufs + 10)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs((result.truePeakDbtp ?? 0) + 10)).toBeLessThanOrEqual(TOLERANCE);
  });

  it('measures mono as played on a stereo stream (dual mono)', async () => {
    const result = await measureLoudness(tools, tones.mono as string, { channels: 1 });
    expect(Math.abs(result.integratedLufs + 20)).toBeLessThanOrEqual(TOLERANCE);
  });

  it('measures the loudness range', async () => {
    const result = await measureLoudness(tools, tones.range as string, { channels: 2 });
    expect(Math.abs((result.loudnessRangeLu ?? 0) - 10)).toBeLessThanOrEqual(1);
  });

  it('reads silence as the gate, with no peak', async () => {
    const result = await measureLoudness(tools, tones.silence as string, { channels: 2 });
    expect(result).toEqual({ integratedLufs: -70, loudnessRangeLu: 0, truePeakDbtp: null });
  });

  it('only reads local FLAC files', async () => {
    const wav = join(dir, 'tone.wav');
    await exec(tools.ffmpeg, ['-v', 'error', '-y', '-i', tones.minus20 as string, wav]);
    await expect(measureLoudness(tools, wav, { channels: 2 })).rejects.toThrow();
  });
});

describe.skipIf(!enabled)('loudness job (integration)', () => {
  let tdb: TestDatabase;
  let storage: Storage;
  let deps: LoudnessDeps;
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
    const org = await createOrganization(tdb.db, system, { slug: `loud-${n}`, name: 'Org' });
    const st = await createStation(
      tdb.db,
      { actor: system, scope: await resolveOrgScope(tdb.db, org.id) },
      { slug: `loud-fm-${n}`, name: 'FM', timezone: 'Europe/Paris' },
    );
    return resolveStationScope(tdb.db, org.id, st.id);
  }

  /** An ingested asset: its playout copy is the tone (salted, so keys never collide). */
  async function ingested(scope: StationScope, toneName: string, channels = 2) {
    const bytes = Buffer.concat([await readFile(tones[toneName] as string)]);
    const sha256 = createHash('sha256').update(bytes).update(randomBytes(8)).digest('hex');
    const storageKey = contentKey({ orgId: scope.orgId, sha256, ext: 'flac' });
    await storage.put(storageKey, bytes);
    const ctx = { actor: system, scope };
    const asset = await createAsset(tdb.db, ctx, { type: 'song', title: toneName });
    await putAssetFile(tdb.db, ctx, asset.id, {
      role: 'playout',
      storageKey,
      sha256,
      sizeBytes: bytes.length,
      codec: 'flac',
      mimeType: 'audio/flac',
      sampleRate: 44100,
      channels,
      bitDepth: 16,
      durationSamples: 441000,
      flacBlockSize: 1024,
    });
    const payload = {
      orgId: scope.orgId,
      stationId: scope.stationId,
      assetId: asset.id,
      playoutSha256: sha256,
    };
    return { asset, payload };
  }

  it('stores the measurement and the asset shows its playout gain', async () => {
    const scope = await tenant();
    const { asset, payload } = await ingested(scope, 'minus20');
    expect((await getAssetDetail(tdb.db, scope, asset.id)).playoutGain.source).toBe('unmeasured');

    expect(await measureAssetLoudness(deps, payload)).toBe('measured');
    const detail = await getAssetDetail(tdb.db, scope, asset.id);
    expect(detail.loudness).toMatchObject({
      analyzer: 'ffmpeg-ebur128',
      analyzerVersion: expect.stringMatching(/^1\/ffmpeg \S+/),
    });
    expect(Math.abs((detail.loudness?.integratedLufs ?? 0) + 20)).toBeLessThanOrEqual(TOLERANCE);
    // Music target −16: +4 dB, peaks at −16 dBTP, well under the −1 ceiling.
    expect(detail.playoutGain.source).toBe('measured');
    expect(Math.abs(detail.playoutGain.gainDb - 4)).toBeLessThanOrEqual(TOLERANCE);
    expect(detail.playoutGain.limitedByPeak).toBe(false);

    // Station target and asset overrides apply at once (the gain is never stored).
    const ctx = { actor: system, scope };
    await updateStation(
      tdb.db,
      { actor: system, scope },
      {
        loudnessTargetLufs: -23,
      },
    );
    expect(
      Math.abs((await getAssetDetail(tdb.db, scope, asset.id)).playoutGain.gainDb + 3),
    ).toBeLessThanOrEqual(TOLERANCE);
    await updateAsset(tdb.db, ctx, asset.id, { gainOverrideDb: -2.5 });
    expect((await getAssetDetail(tdb.db, scope, asset.id)).playoutGain).toEqual({
      gainDb: -2.5,
      source: 'override',
      limitedByPeak: false,
    });
    await updateAsset(tdb.db, ctx, asset.id, { normalizeLoudness: false });
    expect((await getAssetDetail(tdb.db, scope, asset.id)).playoutGain.gainDb).toBe(0);
  });

  it('clamps a quiet asset with high peaks to the ceiling', async () => {
    const scope = await tenant();
    // −10 LUFS / −10 dBTP against a −5 LUFS custom target: +5 wanted, 9 dB of headroom.
    const { asset, payload } = await ingested(scope, 'loud');
    await updateStation(
      tdb.db,
      { actor: system, scope },
      {
        loudnessTargetLufs: -5,
        truePeakLimitDbtp: -7,
      },
    );
    await measureAssetLoudness(deps, payload);
    const { playoutGain, loudness } = await getAssetDetail(tdb.db, scope, asset.id);
    expect(playoutGain.limitedByPeak).toBe(true);
    expect((loudness?.truePeakDbtp ?? 0) + playoutGain.gainDb).toBeLessThanOrEqual(-7);
  });

  it('measures mono playout copies as dual mono', async () => {
    const scope = await tenant();
    const { asset, payload } = await ingested(scope, 'mono', 1);
    await measureAssetLoudness(deps, payload);
    const loudness = await getLoudness(tdb.db, scope, asset.id);
    expect(Math.abs((loudness?.integratedLufs ?? 0) + 20)).toBeLessThanOrEqual(TOLERANCE);
  });

  it('does nothing for a replaced playout copy or a deleted asset', async () => {
    const scope = await tenant();
    const { asset, payload } = await ingested(scope, 'minus20');
    expect(await measureAssetLoudness(deps, { ...payload, playoutSha256: 'f'.repeat(64) })).toBe(
      'stale',
    );
    expect(
      await measureAssetLoudness(deps, {
        ...payload,
        assetId: '0199f6a0-0000-7000-8000-0000000000ff',
      }),
    ).toBe('stale');
    expect(
      await measureAssetLoudness(deps, {
        ...payload,
        stationId: '0199f6a0-0000-7000-8000-0000000000ff',
      }),
    ).toBe('stale');
    expect(await getLoudness(tdb.db, scope, asset.id)).toBeNull();
  });

  it('is idempotent: measuring again replaces the row', async () => {
    const scope = await tenant();
    const { asset, payload } = await ingested(scope, 'minus20');
    await measureAssetLoudness(deps, payload);
    const first = await getLoudness(tdb.db, scope, asset.id);
    await measureAssetLoudness(deps, payload);
    const second = await getLoudness(tdb.db, scope, asset.id);
    expect(second?.integratedLufs).toBe(first?.integratedLufs);
  });

  it('settles a file ffmpeg rejects without storing anything (no retry)', async () => {
    const scope = await tenant();
    const { asset, payload } = await ingested(scope, 'corrupt');
    const logs: unknown[] = [];
    expect(await measureAssetLoudness({ ...deps, log: (e) => logs.push(e) }, payload)).toBe(
      'unmeasurable',
    );
    expect(await getLoudness(tdb.db, scope, asset.id)).toBeNull();
    expect(logs).toHaveLength(1);
  });

  it('retries infrastructure failures: a killed ffmpeg throws', async () => {
    const scope = await tenant();
    const { payload } = await ingested(scope, 'minus20');
    const killed = join(dir, 'killed.sh');
    await writeFile(killed, '#!/bin/sh\nkill -9 $$\n', { mode: 0o755 });
    await expect(
      measureAssetLoudness({ ...deps, tools: { ...tools, ffmpeg: killed } }, payload),
    ).rejects.toThrow(/killed/);
  });

  it('backfills assets without a measurement', async () => {
    const scope = await tenant();
    const other = await tenant();
    const measured = await ingested(scope, 'minus20');
    await measureAssetLoudness(deps, measured.payload);
    const missing = await ingested(scope, 'loud');
    const elsewhere = await ingested(other, 'loud');

    const enqueued: { payload: unknown; key: string | undefined }[] = [];
    const jobs: JobPublisher = {
      async enqueue(_job, payload, options) {
        enqueued.push({ payload, key: options?.idempotencyKey });
        return {} as Awaited<ReturnType<JobPublisher['enqueue']>>;
      },
      close: async () => {},
    };
    const dry = await backfillLoudness(
      { db: tdb.db, jobs },
      { stationIds: [scope.stationId], dryRun: true },
    );
    expect(dry).toEqual({ [scope.stationId]: 1 });
    expect(enqueued).toEqual([]);

    const counts = await backfillLoudness(
      { db: tdb.db, jobs },
      { stationIds: [scope.stationId, other.stationId], batchSize: 1 },
    );
    expect(counts).toEqual({ [scope.stationId]: 1, [other.stationId]: 1 });
    expect(enqueued.map((e) => e.payload)).toEqual(
      expect.arrayContaining([missing.payload, elsewhere.payload]),
    );
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]?.key).toMatch(/^loudness:/);
  });
});
