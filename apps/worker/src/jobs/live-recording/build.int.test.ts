import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  claimLiveRecordingBuild,
  createAsset,
  createOrganization,
  createStation,
  episode,
  getLiveRecording,
  listAssetFiles,
  liveRecording,
  liveRecordingPart,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
  show,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import type { Actor } from '@ondes/shared';
import { createS3Storage, loadStorageConfig, type Storage } from '@ondes/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultTools } from '../ingest/ffmpeg.ts';
import { ensureDir } from '../live-recording-cleanup/cleanup.ts';
import { buildLiveRecording, type LiveRecordingDeps, recordingsDir } from './build.ts';

// The `live-recording` build's edge cases (#67 review), on the dev Postgres and Garage with
// the worker image's ffmpeg: another build holding the recording, an interrupted part with
// nothing in it, a rebuild after the sweep took the files, and other audio on the episode.

const exec = promisify(execFile);
const enabled = Boolean(process.env.S3_ENDPOINT);
if (!enabled) {
  if (process.env.CI) throw new Error('live recording build test needs S3_ENDPOINT in CI');
  console.warn('live recording build test skipped: S3_ENDPOINT is not set (.env.example)');
}

const system: Actor = { type: 'system', name: 'test' };
const tools = defaultTools();
const T0 = new Date('2026-10-27T20:00:00Z');

describe.skipIf(!enabled)('live recording build', () => {
  let tdb: TestDatabase;
  let storage: Storage;
  let scope: StationScope;
  let root: string;
  let showId: string;
  let n = 0;
  const run = { attempt: 1, isLastAttempt: true };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    storage = createS3Storage(loadStorageConfig());
    root = await mkdtemp(join(tmpdir(), 'ondes-live-rec-build-'));
    const org = await createOrganization(tdb.db, system, { slug: 'rec-build', name: 'Org' });
    const st = await createStation(
      tdb.db,
      { actor: system, scope: await resolveOrgScope(tdb.db, org.id) },
      { slug: 'rec-build-fm', name: 'FM', timezone: 'Europe/Paris' },
    );
    scope = await resolveStationScope(tdb.db, org.id, st.id);
    await ensureDir(recordingsDir(root, scope.stationId));
    const [s] = await tdb.db
      .insert(show)
      .values({ ...scope, name: 'Matinale' })
      .returning();
    if (!s) throw new Error('no show');
    showId = s.id;
  }, 60_000);

  afterAll(async () => {
    await tdb?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const deps = (): LiveRecordingDeps => ({
    db: tdb.db,
    storage,
    tools,
    publish: async () => {},
    cacheRoot: root,
    tmpDir: root,
  });
  const payload = (recordingId: string, version: number) => ({
    orgId: scope.orgId,
    stationId: scope.stationId,
    recordingId,
    version,
  });

  /** A FLAC tone of `seconds` in the recordings directory, as the engine writes them. */
  async function engineFile(file: string, seconds: number, freq: number) {
    await exec(tools.ffmpeg, [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${freq}:sample_rate=44100:duration=${seconds}`,
      '-ac',
      '2',
      '-c:a',
      'flac',
      '-sample_fmt',
      's16',
      join(recordingsDir(root, scope.stationId), file),
    ]);
  }

  async function recording(episodeAssetId: string | null = null) {
    n++;
    const [ep] = await tdb.db
      .insert(episode)
      .values({
        ...scope,
        showId,
        number: n,
        kind: 'live',
        status: 'aired',
        assetId: episodeAssetId,
      })
      .returning();
    if (!ep) throw new Error('no episode');
    const [rec] = await tdb.db
      .insert(liveRecording)
      .values({
        ...scope,
        episodeId: ep.id,
        showId,
        title: 'Matinale',
        status: 'pending',
        version: 1,
        endedAt: T0,
      })
      .returning();
    if (!rec) throw new Error('no recording');
    return { ep, rec };
  }

  async function part(
    recordingId: string,
    file: string,
    startOffsetS: number,
    seconds: number,
    status: 'closed' | 'interrupted' = 'closed',
  ) {
    const startedAt = new Date(T0.getTime() + startOffsetS * 1000);
    await tdb.db.insert(liveRecordingPart).values({
      ...scope,
      file,
      sessionId: randomUUID(),
      recordingId,
      bootId: 'b',
      status,
      startedAt,
      endedAt: new Date(startedAt.getTime() + seconds * 1000),
    });
  }

  const episodeAudio = async (id: string) =>
    (await tdb.sql<{ asset_id: string | null }[]>`select asset_id from episode where id = ${id}`)[0]
      ?.asset_id;

  it('waits while another build holds the recording', async () => {
    const { rec } = await recording();
    await engineFile(`live-b-${n}-1.flac`, 1, 220);
    await part(rec.id, `live-b-${n}-1.flac`, 0, 1);
    expect((await claimLiveRecordingBuild(tdb.db, scope, rec.id, 1)).status).toBe('claimed');
    await expect(buildLiveRecording(deps(), payload(rec.id, 1), run)).rejects.toThrow(
      /another build/,
    );
    expect((await getLiveRecording(tdb.db, scope, rec.id)).status).toBe('processing');
  });

  it('builds past an interrupted part that holds nothing, then from the last build once swept', async () => {
    const { ep, rec } = await recording();
    const first = `live-b-${n}-1.flac`;
    await engineFile(first, 3, 220);
    await part(rec.id, first, 0, 3);
    // The engine never got audio into this one (it failed to open it, then restarted).
    await part(rec.id, `live-b-${n}-2.flac`, 3, 0, 'interrupted');
    const v1 = await buildLiveRecording(deps(), payload(rec.id, 1), run);
    expect(v1).toMatchObject({ status: 'ready' });
    if (v1.status !== 'ready') throw new Error(JSON.stringify(v1));
    expect(Math.abs(v1.durationMs - 3000)).toBeLessThan(100);
    expect(await episodeAudio(ep.id)).toBe(v1.assetId);

    // The sweep took the files a day later; then a late part comes (a reconnect).
    await rm(join(recordingsDir(root, scope.stationId), first));
    await tdb.sql`update live_recording_part set status = 'deleted' where recording_id = ${rec.id}`;
    const late = `live-b-${n}-3.flac`;
    await engineFile(late, 2, 330);
    await part(rec.id, late, 3600, 2);
    await tdb.sql`update live_recording set status = 'pending', version = 2 where id = ${rec.id}`;
    const v2 = await buildLiveRecording(deps(), payload(rec.id, 2), run);
    expect(v2).toMatchObject({ status: 'ready' });
    if (v2.status !== 'ready') throw new Error(JSON.stringify(v2));
    // The first build's audio, then the late part.
    expect(Math.abs(v2.durationMs - 5000)).toBeLessThan(150);
    expect(await episodeAudio(ep.id)).toBe(v2.assetId);
    // The first build's asset went: nothing uses it any more.
    expect(await listAssetFiles(tdb.db, scope, v1.assetId)).toEqual([]);
  });

  it('refuses a late part that belongs before audio already swept', async () => {
    const { rec } = await recording();
    await part(rec.id, `live-b-${n}-2.flac`, 60, 2);
    await tdb.sql`update live_recording_part set status = 'deleted' where recording_id = ${rec.id}`;
    const early = `live-b-${n}-1.flac`;
    await engineFile(early, 1, 220);
    await part(rec.id, early, 0, 1);
    const result = await buildLiveRecording(deps(), payload(rec.id, 1), run);
    expect(result).toEqual({
      status: 'failed',
      error: 'a late part belongs before audio whose files were already swept',
    });
  });

  it('leaves other audio on the episode alone', async () => {
    const manual = await createAsset(
      tdb.db,
      { actor: system, scope },
      { type: 'episode', title: 'manual upload' },
    );
    const { ep, rec } = await recording(manual.id);
    await engineFile(`live-b-${n}-1.flac`, 1, 220);
    await part(rec.id, `live-b-${n}-1.flac`, 0, 1);
    const result = await buildLiveRecording(deps(), payload(rec.id, 1), run);
    expect(result).toMatchObject({ status: 'ready' });
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(await episodeAudio(ep.id)).toBe(manual.id);
    expect(await getLiveRecording(tdb.db, scope, rec.id)).toMatchObject({
      status: 'ready',
      assetId: result.assetId,
    });
  });
});
