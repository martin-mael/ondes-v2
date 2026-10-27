import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAsset,
  createOrganization,
  createStation,
  episode,
  getLiveRecording,
  liveRecording,
  liveRecordingPart,
  logDay,
  logItem,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
  show,
  updateLiveRecordingSettings,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import type { Actor } from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultTools } from '../ingest/ffmpeg.ts';
import { buildLiveRecording } from '../live-recording/build.ts';
import { cleanupLiveRecordings, ensureDir } from './cleanup.ts';

// Live recording retention (#67, ADR 0039) against a real database and a scratch cache root:
// expired audio is deleted (unless the log still plans it), local files go a day after their
// build, strays a day after their last write; and a build whose file is gone fails calmly.

const system: Actor = { type: 'system', name: 'test' };
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-27T12:00:00Z');

let tdb: TestDatabase;
let scope: StationScope;
let root: string;
let showId: string;
let n = 0;

beforeAll(async () => {
  tdb = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'ondes-live-rec-cleanup-'));
  const org = await createOrganization(tdb.db, system, { slug: 'cleanup', name: 'Org' });
  const st = await createStation(
    tdb.db,
    { actor: system, scope: await resolveOrgScope(tdb.db, org.id) },
    { slug: 'cleanup-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(tdb.db, org.id, st.id);
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

const dir = () => join(root, scope.stationId, 'recordings');

/** A built recording of an episode, ended `endedDaysAgo`, built `builtDaysAgo`, with one file. */
async function built(endedDaysAgo: number, builtDaysAgo = endedDaysAgo) {
  n++;
  const asset = await createAsset(
    tdb.db,
    { actor: system, scope },
    { type: 'episode', title: `ep ${n}` },
  );
  const [ep] = await tdb.db
    .insert(episode)
    .values({ ...scope, showId, number: n, kind: 'live', status: 'aired', assetId: asset.id })
    .returning();
  const endedAt = new Date(NOW.getTime() - endedDaysAgo * DAY);
  const [rec] = await tdb.db
    .insert(liveRecording)
    .values({
      ...scope,
      episodeId: ep?.id,
      showId,
      status: 'ready',
      version: 1,
      builtVersion: 1,
      assetId: asset.id,
      endedAt,
      builtAt: new Date(NOW.getTime() - builtDaysAgo * DAY),
    })
    .returning();
  if (!rec || !ep) throw new Error('insert failed');
  const file = `live-boot-${n}.flac`;
  await ensureDir(dir());
  await writeFile(join(dir(), file), 'flac');
  const [part] = await tdb.db
    .insert(liveRecordingPart)
    .values({
      ...scope,
      file,
      sessionId: randomUUID(),
      recordingId: rec.id,
      bootId: 'boot',
      status: 'closed',
      startedAt: new Date(endedAt.getTime() - 3_600_000),
      endedAt,
      updatedAt: new Date(NOW.getTime() - builtDaysAgo * DAY),
    })
    .returning();
  return { rec, ep, asset, file, part };
}

const deps = () => ({ db: tdb.db, cacheRoot: root, now: () => NOW });

describe('live recording cleanup', () => {
  it('deletes local files a day after their build, keeps fresher ones, and sweeps strays', async () => {
    const old = await built(3, 2);
    const fresh = await built(0.1, 0.1);
    // A file nobody announced, last written two days ago, and one from this morning.
    await writeFile(join(dir(), 'live-stray-1.flac'), 'x');
    const twoDaysAgo = new Date(NOW.getTime() - 2 * DAY);
    await utimes(join(dir(), 'live-stray-1.flac'), twoDaysAgo, twoDaysAgo);
    await writeFile(join(dir(), 'live-stray-2.flac'), 'x');
    await utimes(join(dir(), 'live-stray-2.flac'), NOW, NOW);

    const result = await cleanupLiveRecordings(deps(), scope);
    expect(result).toEqual({ expired: 0, filesDeleted: 2 });
    const left = await readdir(dir());
    expect(left.sort()).toEqual([fresh.file, 'live-stray-2.flac'].sort());
    expect(left).not.toContain(old.file);
    // The engine (another user) must be able to write there.
    expect((await stat(dir())).mode & 0o777).toBe(0o777);
  });

  it('expires audio past the retention, unless the log still plans it', async () => {
    await updateLiveRecordingSettings(tdb.db, { actor: system, scope }, { retentionDays: 30 });
    const expired = await built(40);
    const kept = await built(10);
    const planned = await built(45);
    // A rerun of the third one is planned tomorrow.
    const [day] = await tdb.db
      .insert(logDay)
      .values({
        ...scope,
        localDate: '2026-10-28',
        startsAt: new Date('2026-10-27T23:00:00Z'),
        endsAt: new Date('2026-10-28T23:00:00Z'),
      })
      .returning();
    if (!day) throw new Error('no log day');
    await tdb.db.insert(logItem).values({
      ...scope,
      logDayId: day.id,
      kind: 'episode',
      assetId: planned.asset.id,
      plannedStart: new Date(NOW.getTime() + DAY),
      plannedDurationMs: 3_600_000,
      originType: 'show',
      position: 0,
    });

    const result = await cleanupLiveRecordings(deps(), scope);
    expect(result.expired).toBe(1);
    expect(await getLiveRecording(tdb.db, scope, expired.rec.id)).toMatchObject({
      status: 'expired',
      assetId: null,
    });
    const [ep] = await tdb.sql<{ asset_id: string | null; status: string }[]>`
      select asset_id, status from episode where id = ${expired.ep.id}`;
    expect(ep).toEqual({ asset_id: null, status: 'aired' });
    expect((await getLiveRecording(tdb.db, scope, kept.rec.id)).status).toBe('ready');
    expect((await getLiveRecording(tdb.db, scope, planned.rec.id)).status).toBe('ready');
    await updateLiveRecordingSettings(tdb.db, { actor: system, scope }, { retentionDays: null });
  });

  it('fails a build calmly when a part file is gone', async () => {
    const { rec, file } = await built(0);
    await rm(join(dir(), file));
    await tdb.sql`update live_recording set status = 'pending', version = 2 where id = ${rec.id}`;
    const result = await buildLiveRecording(
      {
        db: tdb.db,
        storage: undefined as never,
        tools: defaultTools(),
        publish: async () => {},
        cacheRoot: root,
      },
      { orgId: scope.orgId, stationId: scope.stationId, recordingId: rec.id, version: 2 },
      { attempt: 1, isLastAttempt: false },
    );
    expect(result).toEqual({ status: 'failed', error: `recording file ${file} is gone` });
    expect(await getLiveRecording(tdb.db, scope, rec.id)).toMatchObject({
      status: 'failed',
      error: `recording file ${file} is gone`,
    });
  });
});
