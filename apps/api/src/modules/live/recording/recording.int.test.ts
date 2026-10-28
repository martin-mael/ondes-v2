import { randomUUID } from 'node:crypto';
import {
  addMembership,
  auditLog,
  createAsset,
  createOrganization,
  createStation,
  episode,
  liveRecording,
  liveRecordingPart,
  liveSession,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
  show,
} from '@ondes/db';
import { createTestDatabase } from '@ondes/db/testing';
import type { Actor, LiveRecording, LiveRecordingSettings, RealtimeEvent } from '@ondes/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../app.ts';
import { createMemoryMailer } from '../../../plugins/mail.ts';
import { signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../../auth/testing.ts';
import { silentLogger } from '../../engine/adapter/logger.ts';
import { createLiveRecordingRecorder } from './recorder.ts';

// Live recording in the api (#67, ADR 0039): the recorder's rules on a real database (parts,
// recordings per episode / event / session, versions, redeliveries, an engine restart,
// recording off) and the settings, episode and rebuild routes (permissions, audit).

const system: Actor = { type: 'system', name: 'test' };

let t: TestApp;
let scope: StationScope;
const cookies = { manager: '', presenter: '' };
let showId: string;
let episodeId: string;
const published: RealtimeEvent[] = [];
let recorder: ReturnType<typeof createLiveRecordingRecorder>;
let seq = 0;
const BOOT = 'boot-1';

beforeAll(async () => {
  const tdb = await createTestDatabase();
  const mailer = createMemoryMailer();
  const app = await buildApp({
    db: { client: tdb },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    live: { sweepIntervalMs: 0, switchIntervalMs: 0 },
    fastify: { logger: false },
  });
  await app.ready();
  t = {
    app,
    tdb,
    outbox: mailer.outbox,
    close: async () => {
      await app.close();
      await tdb.drop();
    },
  };
  const db = tdb.db;
  const org = await createOrganization(db, system, { slug: 'rec-org', name: 'Org' });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: 'rec-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(db, org.id, st.id);
  for (const role of ['manager', 'presenter'] as const) {
    const { userId, cookie } = await signUpAndLogin(t, `${role}@rec.test`);
    await addMembership(
      db,
      { actor: system, scope: orgScope },
      {
        level: 'station',
        stationId: st.id,
        userId,
        role: role === 'manager' ? 'station_manager' : role,
      },
    );
    cookies[role] = cookie;
  }
  const [s] = await db
    .insert(show)
    .values({ ...scope, name: 'Matinale' })
    .returning();
  if (!s) throw new Error('no show');
  showId = s.id;
  recorder = createLiveRecordingRecorder({
    db,
    publish: async (e) => {
      published.push(e);
    },
    logger: silentLogger,
  });
}, 60_000);

afterAll(() => t?.close());

beforeEach(async () => {
  published.length = 0;
  const [ep] = await t.tdb.db
    .insert(episode)
    .values({ ...scope, showId, number: ++seq, kind: 'live', status: 'aired' })
    .returning();
  if (!ep) throw new Error('no episode');
  episodeId = ep.id;
});

async function session(binding: { episodeId?: string; eventId?: string } = {}) {
  const id = randomUUID();
  await t.tdb.db.insert(liveSession).values({
    ...scope,
    id,
    input: 1,
    trigger: binding.episodeId ? 'slot' : binding.eventId ? 'event' : 'ad_hoc',
    showId: binding.episodeId ? showId : null,
    episodeId: binding.episodeId ?? null,
    episodeNumber: binding.episodeId ? seq : null,
    eventId: binding.eventId ?? null,
    title: binding.eventId ? 'Fête' : 'Matinale',
    endedAt: new Date(),
    endReason: 'returned',
  });
  return id;
}

let n = 0;
const at = (s: number) => new Date(Date.UTC(2026, 9, 27, 18, 0, s)).toISOString();

function engineEvent(
  type: 'engine.live.recording.started' | 'engine.live.recording.closed' | 'engine.booted',
  data: Record<string, unknown>,
  bootId = BOOT,
): RealtimeEvent {
  n++;
  const base = { id: randomUUID(), stationId: scope.stationId, at: at(n) };
  return { ...base, type, data: { bootId, seq: n, ...data } } as RealtimeEvent;
}

async function recordFile(file: string, sessionId: string, from: number, to: number) {
  await recorder.handle(
    engineEvent('engine.live.recording.started', { file, sessionId, startedAt: at(from) }),
  );
  const closed = engineEvent('engine.live.recording.closed', {
    file,
    sessionId,
    startedAt: at(from),
    endedAt: at(to),
  });
  await recorder.handle(closed);
  return closed;
}

const updates = () =>
  published.flatMap((e) => (e.type === 'live.recording.updated' ? [e.data] : []));

async function recordingOf(where: { episodeId?: string; sessionId?: string; eventId?: string }) {
  const rows = await t.tdb.db
    .select()
    .from(liveRecording)
    .where(eq(liveRecording.stationId, scope.stationId));
  return rows.filter(
    (r) =>
      (where.episodeId === undefined || r.episodeId === where.episodeId) &&
      (where.sessionId === undefined || r.sessionId === where.sessionId) &&
      (where.eventId === undefined || r.eventId === where.eventId),
  );
}

describe('live recording recorder', () => {
  it('joins a handover and a reconnect into one recording of the episode', async () => {
    const [s1, s2, s3] = [
      await session({ episodeId }),
      await session({ episodeId }),
      await session({ episodeId }),
    ];
    // A handover: the next file starts before the previous one is reported closed.
    await recorder.handle(
      engineEvent('engine.live.recording.started', {
        file: `live-${seq}-a-1.flac`,
        sessionId: s1,
        startedAt: at(0),
      }),
    );
    await recorder.handle(
      engineEvent('engine.live.recording.started', {
        file: `live-${seq}-a-2.flac`,
        sessionId: s2,
        startedAt: at(60),
      }),
    );
    await recorder.handle(
      engineEvent('engine.live.recording.closed', {
        file: `live-${seq}-a-1.flac`,
        sessionId: s1,
        startedAt: at(0),
        endedAt: at(60),
      }),
    );
    // S2 is still recording: nothing to build yet.
    expect(updates().at(-1)).toMatchObject({ status: 'recording', version: 1 });
    await recorder.handle(
      engineEvent('engine.live.recording.closed', {
        file: `live-${seq}-a-2.flac`,
        sessionId: s2,
        startedAt: at(60),
        endedAt: at(120),
      }),
    );
    expect(updates().at(-1)).toMatchObject({ episodeId, showId, status: 'pending', version: 2 });
    // The DJ reconnects: a third part, a new version.
    const closed = await recordFile(`live-${seq}-a-3.flac`, s3, 200, 300);
    expect(updates().at(-1)).toMatchObject({ status: 'pending', version: 3 });
    const [row] = await recordingOf({ episodeId });
    expect(row).toMatchObject({ version: 3, status: 'pending', title: `Matinale #${seq}` });
    expect(row?.endedAt?.toISOString()).toBe(at(300));

    // A redelivered close changes nothing (same version, same event id).
    const before = updates().at(-1);
    const lastId = published.at(-1)?.id;
    await recorder.handle(closed);
    expect((await recordingOf({ episodeId }))[0]?.version).toBe(3);
    expect(updates().at(-1)).toEqual(before);
    expect(published.at(-1)?.id).toBe(lastId);
  });

  it('gives an event its own recording, shared by its sessions, and an ad-hoc session its own', async () => {
    const eventId = randomUUID();
    const [e1, e2, adHoc] = [
      await session({ eventId }),
      await session({ eventId }),
      await session(),
    ];
    await recordFile(`live-${seq}-b-1.flac`, e1, 0, 10);
    await recordFile(`live-${seq}-b-2.flac`, e2, 10, 20);
    await recordFile(`live-${seq}-b-3.flac`, adHoc, 30, 40);
    expect((await recordingOf({ eventId })).map((r) => [r.version, r.title])).toEqual([
      [2, 'Fête'],
    ]);
    expect(
      (await recordingOf({ sessionId: adHoc })).map((r) => [r.version, r.episodeId, r.eventId]),
    ).toEqual([[1, null, null]]);
  });

  it('interrupts a file of an earlier boot when the engine restarts', async () => {
    const s1 = await session({ episodeId });
    await recorder.handle(
      engineEvent('engine.live.recording.started', {
        file: `live-${seq}-c-1.flac`,
        sessionId: s1,
        startedAt: at(0),
      }),
    );
    await recorder.handle(engineEvent('engine.booted', { version: '2.4.6' }, 'boot-2'));
    const [part] = await t.tdb.db
      .select()
      .from(liveRecordingPart)
      .where(
        and(
          eq(liveRecordingPart.stationId, scope.stationId),
          eq(liveRecordingPart.file, `live-${seq}-c-1.flac`),
        ),
      );
    expect(part?.status).toBe('interrupted');
    expect(updates().at(-1)).toMatchObject({ episodeId, status: 'pending', version: 1 });
  });

  it('interrupts an earlier file of the same boot that never closed when the next one starts', async () => {
    const s1 = await session({ episodeId });
    const s2 = await session({ episodeId });
    // The first file's close was never announced (a write error, a lost event).
    await recorder.handle(
      engineEvent('engine.live.recording.started', {
        file: `live-${seq}-g-1.flac`,
        sessionId: s1,
        startedAt: at(0),
      }),
    );
    await recordFile(`live-${seq}-g-2.flac`, s2, 10, 20);
    const parts = await t.tdb.db
      .select()
      .from(liveRecordingPart)
      .where(eq(liveRecordingPart.stationId, scope.stationId));
    const status = (file: string) => parts.find((p) => p.file === file)?.status;
    expect(status(`live-${seq}-g-1.flac`)).toBe('interrupted');
    expect(status(`live-${seq}-g-2.flac`)).toBe('closed');
    // Both counted, none open: the recording builds.
    expect(updates().at(-1)).toMatchObject({ episodeId, status: 'pending', version: 2 });
    // A redelivered start of the first file doesn't touch the second one.
    await recorder.handle(
      engineEvent('engine.live.recording.started', {
        file: `live-${seq}-g-1.flac`,
        sessionId: s1,
        startedAt: at(0),
      }),
    );
    expect((await recordingOf({ episodeId }))[0]?.version).toBe(2);
  });

  it('ignores files of unknown sessions and of engines opened by hand', async () => {
    await recordFile(`live-${seq}-d-1.flac`, randomUUID(), 0, 10);
    await recorder.handle(
      engineEvent('engine.live.recording.closed', {
        file: `live-${seq}-d-2.flac`,
        sessionId: 'not-a-session',
        startedAt: at(0),
        endedAt: at(1),
      }),
    );
    expect(updates()).toEqual([]);
  });

  it('skips recordings while the station records nothing', async () => {
    const off = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/stations/${scope.stationId}/live/recording/settings`,
      cookies: { ondes_session: cookies.manager },
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    const s1 = await session({ episodeId });
    await recordFile(`live-${seq}-e-1.flac`, s1, 0, 10);
    expect(updates().at(-1)).toMatchObject({ status: 'skipped', version: 1 });
    await t.app.inject({
      method: 'PUT',
      url: `/api/v1/stations/${scope.stationId}/live/recording/settings`,
      cookies: { ondes_session: cookies.manager },
      payload: { enabled: true },
    });
  });
});

describe('live recording routes', () => {
  const settingsUrl = () => `/api/v1/stations/${scope.stationId}/live/recording/settings`;

  it('reads the defaults, writes settings for managers only and audits them', async () => {
    const read = await t.app.inject({
      method: 'GET',
      url: settingsUrl(),
      cookies: { ondes_session: cookies.presenter },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<LiveRecordingSettings>()).toEqual({ enabled: true, retentionDays: null });
    const denied = await t.app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: { ondes_session: cookies.presenter },
      payload: { retentionDays: 30 },
    });
    expect(denied.statusCode).toBe(403);
    const bad = await t.app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: { ondes_session: cookies.manager },
      payload: { retentionDays: 0 },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await t.app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: { ondes_session: cookies.manager },
      payload: { retentionDays: 30 },
    });
    expect(ok.json<LiveRecordingSettings>()).toEqual({ enabled: true, retentionDays: 30 });
    const audits = await t.tdb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'live_recording.settings.update'));
    expect(audits.at(-1)?.diff).toMatchObject({ retentionDays: { from: null, to: 30 } });
    await t.app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: { ondes_session: cookies.manager },
      payload: { retentionDays: null },
    });
  });

  it("reads an episode's recording with its parts, and rebuilds it", async () => {
    const s1 = await session({ episodeId });
    await recordFile(`live-${seq}-f-1.flac`, s1, 0, 30);
    const url = `/api/v1/stations/${scope.stationId}/shows/${showId}/episodes/${episodeId}/recording`;
    const res = await t.app.inject({
      method: 'GET',
      url,
      cookies: { ondes_session: cookies.presenter },
    });
    expect(res.statusCode).toBe(200);
    const { recording } = res.json<{ recording: LiveRecording }>();
    expect(recording).toMatchObject({
      episodeId,
      status: 'pending',
      version: 1,
      assetId: null,
      expiresAt: null,
    });
    expect(recording.parts.map((p) => [p.sessionId, p.status])).toEqual([[s1, 'closed']]);

    // Another show in the path: no recording.
    const other = await t.app.inject({
      method: 'GET',
      url: url.replace(showId, randomUUID()),
      cookies: { ondes_session: cookies.presenter },
    });
    expect(other.json()).toEqual({ recording: null });

    const rebuildUrl = `/api/v1/stations/${scope.stationId}/live/recordings/${recording.id}/rebuild`;
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: rebuildUrl,
          cookies: { ondes_session: cookies.presenter },
        })
      ).statusCode,
    ).toBe(403);
    // Waiting for its build already: nothing to rebuild.
    const busy = await t.app.inject({
      method: 'POST',
      url: rebuildUrl,
      cookies: { ondes_session: cookies.manager },
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ error: 'live_recording_state' });
    await t.tdb.sql`update live_recording set status = 'failed' where id = ${recording.id}`;
    const rebuilt = await t.app.inject({
      method: 'POST',
      url: rebuildUrl,
      cookies: { ondes_session: cookies.manager },
    });
    expect(rebuilt.statusCode).toBe(202);
    expect(rebuilt.json<LiveRecording>()).toMatchObject({ status: 'pending', version: 2 });
    const audits = await t.tdb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, recording.id));
    expect(audits.map((a) => a.action)).toEqual(['live_recording.rebuild']);
  });

  it('makes a ready recording the episode audio over other audio, for managers only', async () => {
    const ctx = { actor: system, scope };
    const manual = await createAsset(t.tdb.db, ctx, { type: 'episode', title: 'manual' });
    const built = await createAsset(t.tdb.db, ctx, { type: 'episode', title: 'live' });
    await t.tdb.sql`update episode set asset_id = ${manual.id} where id = ${episodeId}`;
    const [rec] = await t.tdb.db
      .insert(liveRecording)
      .values({ ...scope, episodeId, showId, status: 'ready', version: 1, builtVersion: 1 })
      .returning();
    if (!rec) throw new Error('no recording');
    const url = `/api/v1/stations/${scope.stationId}/live/recordings/${rec.id}/attach`;
    // Not built yet (no asset): refused.
    const early = await t.app.inject({
      method: 'POST',
      url,
      cookies: { ondes_session: cookies.manager },
    });
    expect(early.statusCode).toBe(409);
    await t.tdb.sql`update live_recording set asset_id = ${built.id} where id = ${rec.id}`;
    const denied = await t.app.inject({
      method: 'POST',
      url,
      cookies: { ondes_session: cookies.presenter },
    });
    expect(denied.statusCode).toBe(403);
    const ok = await t.app.inject({
      method: 'POST',
      url,
      cookies: { ondes_session: cookies.manager },
    });
    expect(ok.statusCode).toBe(200);
    const [ep] = await t.tdb.sql<{ asset_id: string }[]>`
      select asset_id from episode where id = ${episodeId}`;
    expect(ep?.asset_id).toBe(built.id);
    const audits = await t.tdb.db.select().from(auditLog).where(eq(auditLog.entityId, episodeId));
    expect(audits.at(-1)).toMatchObject({
      action: 'episode.update',
      diff: { assetId: { from: manual.id, to: built.id } },
    });
  });
});
