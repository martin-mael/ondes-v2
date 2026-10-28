import { randomUUID } from 'node:crypto';
import { type Actor, LIVE_RECORDING_BUILD_LEASE_MS } from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimLiveRecordingBuild,
  createAsset,
  createOrganization,
  createStation,
  episode,
  failLiveRecordingBuild,
  finishLiveRecordingBuild,
  getLiveRecording,
  liveRecording,
  liveRecordingPart,
  liveSession,
  recordPartClosed,
  releaseLiveRecordingBuild,
  resetStaleLiveRecordingBuilds,
  resolveOrgScope,
  resolveStationScope,
  type StationContext,
  type StationScope,
  show,
} from './index.ts';
import { createTestDatabase, type TestDatabase } from './testing.ts';

// Live recording builds (#67, ADR 0039, review): one build per recording at a time, a stale
// build never overwrites a newer one, and a build never overwrites other episode audio.

const system: Actor = { type: 'system', name: 'test' };
const T0 = new Date('2026-10-27T20:00:00Z');
const MIN = 60_000;

let tdb: TestDatabase;
let scope: StationScope;
let ctx: StationContext;
let showId: string;
let n = 0;

beforeAll(async () => {
  tdb = await createTestDatabase();
  const org = await createOrganization(tdb.db, system, { slug: 'rec-builds', name: 'Org' });
  const st = await createStation(
    tdb.db,
    { actor: system, scope: await resolveOrgScope(tdb.db, org.id) },
    { slug: 'rec-builds-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(tdb.db, org.id, st.id);
  ctx = { actor: system, scope };
  const [s] = await tdb.db
    .insert(show)
    .values({ ...scope, name: 'Matinale' })
    .returning();
  if (!s) throw new Error('no show');
  showId = s.id;
}, 60_000);

afterAll(() => tdb?.drop());

/** A live episode and its recording, `pending` at version 1 with one closed part. */
async function pendingRecording(episodeAssetId: string | null = null) {
  n++;
  const [ep] = await tdb.db
    .insert(episode)
    .values({ ...scope, showId, number: n, kind: 'live', status: 'aired', assetId: episodeAssetId })
    .returning();
  if (!ep) throw new Error('no episode');
  const [rec] = await tdb.db
    .insert(liveRecording)
    .values({ ...scope, episodeId: ep.id, showId, status: 'pending', version: 1, endedAt: T0 })
    .returning();
  if (!rec) throw new Error('no recording');
  await tdb.db.insert(liveRecordingPart).values({
    ...scope,
    file: `live-b-${n}-1.flac`,
    sessionId: randomUUID(),
    recordingId: rec.id,
    bootId: 'b',
    status: 'closed',
    startedAt: new Date(T0.getTime() - 60 * MIN),
    endedAt: T0,
  });
  return { ep, rec };
}

const asset = (title: string) => createAsset(tdb.db, ctx, { type: 'episode', title });
const result = (assetId: string) => ({
  assetId,
  uploadId: randomUUID(),
  durationMs: 3_600_000,
  buildMs: 1000,
});
const episodeAudio = async (id: string) =>
  (await tdb.sql<{ asset_id: string | null }[]>`select asset_id from episode where id = ${id}`)[0]
    ?.asset_id;

describe('live recording builds', () => {
  it('lets one build hold a recording; a crashed one is taken over after the lease', async () => {
    const { rec } = await pendingRecording();
    const first = await claimLiveRecordingBuild(tdb.db, scope, rec.id, 1, T0);
    expect(first.status).toBe('claimed');
    // A redelivered job for the same version while the first runs: wait.
    expect((await claimLiveRecordingBuild(tdb.db, scope, rec.id, 1, T0)).status).toBe('busy');
    // Past the lease, the first worker is taken for dead.
    const later = new Date(T0.getTime() + LIVE_RECORDING_BUILD_LEASE_MS + MIN);
    const second = await claimLiveRecordingBuild(tdb.db, scope, rec.id, 1, later);
    expect(second.status).toBe('claimed');
    if (first.status !== 'claimed' || second.status !== 'claimed') throw new Error('no claims');
    expect(second.claim).not.toBe(first.claim);
    // The first one waking up can't record anything any more.
    const a = await asset('first');
    expect(
      (await finishLiveRecordingBuild(tdb.db, ctx, rec.id, 1, first.claim, result(a.id))).status,
    ).toBe('lost');
    expect(await failLiveRecordingBuild(tdb.db, scope, rec.id, 1, first.claim, 'x')).toBeNull();
    expect(await getLiveRecording(tdb.db, scope, rec.id)).toMatchObject({
      status: 'processing',
      buildClaim: second.claim,
    });
  });

  it('never lets an older build overwrite a newer one', async () => {
    const { ep, rec } = await pendingRecording();
    // v1's build starts.
    const v1 = await claimLiveRecordingBuild(tdb.db, scope, rec.id, 1, T0);
    if (v1.status !== 'claimed') throw new Error('v1 not claimed');
    // A late part (a reconnect in the slot) closes meanwhile: version 2, waiting for v1.
    const sessionId = randomUUID();
    await tdb.db.insert(liveSession).values({
      ...scope,
      id: sessionId,
      input: 1,
      trigger: 'slot',
      showId,
      episodeId: ep.id,
    });
    await recordPartClosed(tdb.db, scope, {
      file: `live-b-${n}-2.flac`,
      sessionId,
      bootId: 'b',
      startedAt: T0,
      endedAt: new Date(T0.getTime() + 10 * MIN),
      status: 'closed',
    });
    expect((await getLiveRecording(tdb.db, scope, rec.id)).version).toBe(2);
    expect((await claimLiveRecordingBuild(tdb.db, scope, rec.id, 2, T0)).status).toBe('busy');
    // v1 finishes: its audio is attached (better than none), the row stays pending for v2.
    const old = await asset('v1');
    const done1 = await finishLiveRecordingBuild(tdb.db, ctx, rec.id, 1, v1.claim, result(old.id));
    expect(done1).toMatchObject({ status: 'finished', attached: true, replacedAssetId: null });
    expect(await getLiveRecording(tdb.db, scope, rec.id)).toMatchObject({
      status: 'pending',
      builtVersion: 1,
      buildClaim: null,
    });
    // v2 now builds and replaces it.
    const v2 = await claimLiveRecordingBuild(tdb.db, scope, rec.id, 2, T0);
    if (v2.status !== 'claimed') throw new Error('v2 not claimed');
    const fresh = await asset('v2');
    const done2 = await finishLiveRecordingBuild(
      tdb.db,
      ctx,
      rec.id,
      2,
      v2.claim,
      result(fresh.id),
    );
    expect(done2).toMatchObject({ status: 'finished', replacedAssetId: old.id });
    expect(await episodeAudio(ep.id)).toBe(fresh.id);
    expect(await getLiveRecording(tdb.db, scope, rec.id)).toMatchObject({
      status: 'ready',
      builtVersion: 2,
      assetId: fresh.id,
    });
    // A stale v1 job redelivered now does nothing.
    expect((await claimLiveRecordingBuild(tdb.db, scope, rec.id, 1, T0)).status).toBe('skip');
  });

  it('lets go of the recording for a retry', async () => {
    const { rec } = await pendingRecording();
    const c = await claimLiveRecordingBuild(tdb.db, scope, rec.id, 1, T0);
    if (c.status !== 'claimed') throw new Error('not claimed');
    await releaseLiveRecordingBuild(tdb.db, scope, rec.id, c.claim);
    expect(await getLiveRecording(tdb.db, scope, rec.id)).toMatchObject({
      status: 'pending',
      buildClaim: null,
    });
    expect((await claimLiveRecordingBuild(tdb.db, scope, rec.id, 1, T0)).status).toBe('claimed');
  });

  it('never overwrites other audio on the episode', async () => {
    const manual = await asset('manual upload');
    const { ep, rec } = await pendingRecording(manual.id);
    const c = await claimLiveRecordingBuild(tdb.db, scope, rec.id, 1, T0);
    if (c.status !== 'claimed') throw new Error('not claimed');
    const built = await asset('live');
    const done = await finishLiveRecordingBuild(tdb.db, ctx, rec.id, 1, c.claim, result(built.id));
    expect(done).toMatchObject({ status: 'finished', attached: false });
    expect(await episodeAudio(ep.id)).toBe(manual.id);
    expect(await getLiveRecording(tdb.db, scope, rec.id)).toMatchObject({
      status: 'ready',
      assetId: built.id,
    });
  });

  it('puts builds nothing runs back to pending', async () => {
    const { rec } = await pendingRecording();
    const c = await claimLiveRecordingBuild(tdb.db, scope, rec.id, 1, T0);
    if (c.status !== 'claimed') throw new Error('not claimed');
    // Within the lease, and freshly updated: left alone.
    expect(
      (await resetStaleLiveRecordingBuilds(tdb.db, scope, new Date())).map((r) => r.id),
    ).not.toContain(rec.id);
    const later = new Date(Date.now() + LIVE_RECORDING_BUILD_LEASE_MS + MIN);
    const reset = await resetStaleLiveRecordingBuilds(tdb.db, scope, later);
    expect(reset.find((r) => r.id === rec.id)).toMatchObject({
      status: 'pending',
      buildClaim: null,
    });
  });
});
