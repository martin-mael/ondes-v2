import {
  auditLog,
  createOrganization,
  createStation,
  liveHandover,
  liveRequest,
  liveSession,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
} from '@ondes/db';
import { createTestDatabase } from '@ondes/db/testing';
import type { Actor, RealtimeEvent } from '@ondes/shared';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createShow, createSlot } from '../shows/repo.ts';
import { createLiveHandovers, type LiveHandovers } from './handover.ts';
import { createStreamer, updateStreamer } from './repo.ts';
import { createLiveSwitcher, type LiveSwitchEngine, type LiveSwitcher } from './switching.ts';
import { fakeEngine } from './testing/fake-engine.ts';

// DJ handover (#66, ADR 0038) against a real database and an in-memory engine with a pool of
// two harbor inputs: the crossfade asked of the engine, a handover keeping the slot's episode,
// muting, and scheduled handovers. The recorded test on the real engine is
// live-handover.engine.int.test.ts.

const system: Actor = { type: 'system', name: 'handover-test' };
const logger = { info: () => {}, warn: () => {}, error: () => {} };
// The show's live slot: Thursday 5 November 2026, 20:00–21:00 in Paris (19:00–20:00 UTC).
const IN_SLOT = new Date('2026-11-05T19:10:00Z');
const AFTER_SLOT = new Date('2026-11-05T20:10:00Z');

let tdb: Awaited<ReturnType<typeof createTestDatabase>>;
let scope: StationScope;
let engine: ReturnType<typeof fakeEngine>;
let published: RealtimeEvent[];
let now: Date;
let s: LiveSwitcher;
let h: LiveHandovers;
const ids: Record<string, string> = {};
const ctx = () => ({ actor: system, scope });
const later = (ms: number) => new Date(now.getTime() + ms);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function services() {
  const engineFor = async (stationId: string) =>
    stationId === scope.stationId ? (engine as LiveSwitchEngine) : undefined;
  const publish = (event: RealtimeEvent) => {
    published.push(event);
  };
  s = createLiveSwitcher({ db: tdb.db, engineFor, publish, logger, now: () => now });
  h = createLiveHandovers({
    db: tdb.db,
    switcher: s,
    engineFor,
    publish,
    logger,
    now: () => now,
  });
}

async function sessions() {
  return tdb.db
    .select()
    .from(liveSession)
    .where(eq(liveSession.stationId, scope.stationId))
    .orderBy(liveSession.startedAt);
}

const handoverEvents = () =>
  published.flatMap((e) => (e.type === 'live.handover.changed' ? [e.data.status] : []));

beforeAll(async () => {
  tdb = await createTestDatabase();
  const db = tdb.db;
  const org = await createOrganization(db, system, { slug: 'handover-org', name: 'Org' });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: 'handover-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(db, org.id, st.id);
  const show = await createShow(db, ctx(), { name: 'Night Shift' });
  ids.show = show.id;
  await createSlot(db, ctx(), show.id, {
    type: 'live',
    rule: { freq: 'once', date: '2026-11-05', time: '20:00' },
    durationMs: 3_600_000,
  });
  for (const [username, extra] of [
    ['resident', { showIds: [show.id] }],
    ['guest', { anyTime: true }],
    ['later', { anyTime: true }],
  ] as [string, { showIds?: string[]; anyTime?: boolean }][]) {
    const created = await createStreamer(db, ctx(), { displayName: username, username, ...extra });
    ids[username] = created.streamer.id;
  }
}, 60_000);

afterAll(() => {
  h?.close();
  return tdb?.drop();
});

beforeEach(async () => {
  h?.close();
  await tdb.db.delete(liveSession);
  await tdb.db.delete(liveHandover);
  await tdb.db.delete(liveRequest);
  engine = fakeEngine();
  published = [];
  now = IN_SLOT;
  services();
});

describe('DJ handover', () => {
  it('asks the engine for the crossfade: the default, or the one given', async () => {
    engine.connect(1, ids.guest ?? null);
    engine.connect(2, ids.later ?? null);
    await s.goLive(ctx(), 1);
    await s.goLive(ctx(), 2, 'manual', undefined, { fadeMs: 4500 });
    await s.goLive(ctx(), 1, 'manual', undefined, { fadeMs: 0 });
    expect(engine.fades).toEqual([2000, 4500, 0]);
  });

  it('keeps the slot’s show and episode for a DJ handed the air during it', async () => {
    engine.connect(1, ids.resident ?? null);
    engine.connect(2, ids.guest ?? null);
    const resident = await s.goLive(ctx(), 1, 'slot');
    expect(resident.episode).not.toBeNull();
    const guest = await s.goLive(ctx(), 2);
    expect(guest).toMatchObject({
      trigger: 'manual',
      streamer: { id: ids.guest },
      show: { id: ids.show, name: 'Night Shift' },
      episode: resident.episode,
    });
    // And back: the resident's own slot binds them again, to the same episode.
    const back = await s.goLive(ctx(), 1);
    expect(back.episode).toEqual(resident.episode);
    const rows = await sessions();
    expect(rows.map((r) => [r.endReason, r.episodeId, r.slotId !== null])).toEqual([
      ['handover', resident.episode?.id, true],
      ['handover', resident.episode?.id, true],
      [null, resident.episode?.id, true],
    ]);
    expect(new Set(rows.map((r) => r.scheduledEndAt?.toISOString()))).toEqual(
      new Set(['2026-11-05T20:00:00.000Z']),
    );
  });

  it('keeps the slot for a DJ approved ad hoc during it', async () => {
    engine.connect(1, ids.resident ?? null);
    engine.connect(2, ids.guest ?? null);
    const resident = await s.goLive(ctx(), 1, 'slot');
    const [request] = await tdb.db
      .insert(liveRequest)
      .values({
        orgId: scope.orgId,
        stationId: scope.stationId,
        streamerId: ids.guest ?? '',
        input: 2,
        connectedAt: now,
      })
      .returning();
    const approved = await s.approve(ctx(), request?.id ?? '');
    expect(approved).toMatchObject({
      trigger: 'ad_hoc',
      streamer: { id: ids.guest },
      show: { id: ids.show },
      episode: resident.episode,
    });
  });

  it('carries nothing over once the slot is over, nor from an unbound session', async () => {
    engine.connect(1, ids.resident ?? null);
    engine.connect(2, ids.guest ?? null);
    await s.goLive(ctx(), 1, 'slot');
    now = AFTER_SLOT;
    expect((await s.goLive(ctx(), 2)).show).toBeNull();
    // guest → later, neither bound: still nothing.
    engine.connect(1, ids.later ?? null);
    expect((await s.goLive(ctx(), 1)).show).toBeNull();
  });

  it('mutes and unmutes an input, audited, and reports it in the status', async () => {
    engine.connect(2, ids.guest ?? null);
    expect(await s.mute(ctx(), 2, true)).toBe(true);
    expect((await s.status(scope, true)).inputs.map((i) => i.muted)).toEqual([false, true]);
    expect(await s.mute(ctx(), 2, true)).toBe(true); // again: muted from true
    expect(await s.mute(ctx(), 2, false)).toBe(true);
    expect(engine.commands).toEqual(['mute 2', 'mute 2', 'unmute 2']);
    const audits = await tdb.db
      .select({ diff: auditLog.diff })
      .from(auditLog)
      .where(and(eq(auditLog.stationId, scope.stationId), eq(auditLog.action, 'live.input.mute')))
      .orderBy(auditLog.at);
    // The state before, as the engine reported it.
    expect(audits.map((a) => (a.diff as { muted: unknown }).muted)).toEqual([
      { from: false, to: true },
      { from: true, to: true },
      { from: true, to: false },
    ]);
  });

  it('never lets a mute carry over to the next DJ on the input', async () => {
    // Nobody connected: refused (the engine would keep it for whoever connects next).
    await expect(s.mute(ctx(), 1, true)).rejects.toMatchObject({
      statusCode: 409,
      code: 'live_input_not_connected',
    });
    expect(await s.mute(ctx(), 1, false)).toBe(false); // unmuting nobody: harmless
    // The DJ hangs up between Node's check and the engine's: the engine refuses, still a 409.
    engine.connect(1, ids.guest ?? null);
    const state = engine.state;
    engine.state = async () => {
      const st = await state();
      engine.hangUp(1);
      return st;
    };
    await expect(s.mute(ctx(), 1, true)).rejects.toMatchObject({
      code: 'live_input_not_connected',
    });
    engine.state = state;
    // Muted, then the DJ hangs up: the next one starts unmuted.
    engine.connect(2, ids.guest ?? null);
    await s.mute(ctx(), 2, true);
    engine.hangUp(2);
    engine.connect(2, ids.later ?? null);
    expect((await s.status(scope, true)).inputs[1]?.muted).toBe(false);
  });

  it('serialises switches across replicas: the engine ends on the session the db has open', async () => {
    const replica = createLiveSwitcher({
      db: tdb.db,
      engineFor: async () => engine as LiveSwitchEngine,
      logger,
      now: () => now,
    });
    engine.connect(1, ids.guest ?? null);
    engine.connect(2, ids.later ?? null);
    await s.goLive(ctx(), 1);
    // A slow engine call for the handover to input 2 (a scheduled handover, say)…
    let release = () => {};
    engine.hold = new Promise((r) => {
      release = r;
    });
    const toTwo = s.goLive(ctx(), 2);
    for (let i = 0; i < 100 && engine.hold; i++) await sleep(10);
    expect(engine.hold).toBeNull(); // its session is committed, the engine call on the way
    // …while a member puts the first DJ back by hand on another replica: it waits.
    const backToOne = replica.goLive(ctx(), 1);
    await sleep(200);
    expect(engine.commands).toEqual(['open 1']);
    release();
    await Promise.all([toTwo, backToOne]);
    expect(engine.commands).toEqual(['open 1', 'open 2', 'open 1']);
    const open = (await sessions()).filter((r) => r.endedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ input: 1, id: engine.sessionId });
  });
});

describe('scheduled handovers', () => {
  it('hands the air to the DJ at its time, on whichever input they are connected', async () => {
    engine.connect(1, ids.resident ?? null);
    await s.goLive(ctx(), 1, 'slot');
    const scheduled = await h.schedule(ctx(), {
      streamerId: ids.later ?? '',
      at: later(60_000),
      fadeMs: 3000,
    });
    expect(scheduled).toMatchObject({
      status: 'pending',
      streamer: { id: ids.later, displayName: 'later' },
      fadeMs: 3000,
      reason: null,
      sessionId: null,
    });
    engine.connect(2, ids.later ?? null);
    now = later(60_000);
    await h.run(scope, scheduled.id);
    const [listed] = await h.list(scope);
    expect(listed).toMatchObject({ id: scheduled.id, status: 'done', reason: null });
    const open = (await sessions()).find((r) => r.endedAt === null);
    expect(open).toMatchObject({ id: listed?.sessionId, input: 2, streamerId: ids.later });
    // In the resident's slot, with no slot of their own: the same episode (see above).
    expect(open?.slotId).not.toBeNull();
    expect(engine.fades.at(-1)).toBe(3000);
    expect(handoverEvents()).toEqual(['pending', 'running', 'done']);
    // Run again (another replica's timer): nothing happens.
    await h.run(scope, scheduled.id);
    expect(engine.commands.filter((c) => c.startsWith('open'))).toHaveLength(2);
  });

  it('runs once when two replicas fire together', async () => {
    const other = createLiveHandovers({
      db: tdb.db,
      switcher: s,
      engineFor: async () => engine as LiveSwitchEngine,
      logger,
      now: () => now,
    });
    engine.connect(2, ids.later ?? null);
    const scheduled = await h.schedule(ctx(), {
      streamerId: ids.later ?? '',
      at: later(1000),
      fadeMs: 2000,
    });
    now = later(1000);
    await Promise.all([h.run(scope, scheduled.id), other.run(scope, scheduled.id)]);
    expect(engine.commands).toEqual(['open 2']);
    expect((await h.list(scope))[0]?.status).toBe('done');
  });

  it('arms a timer for a handover due soon, from the sweep or when scheduled', async () => {
    engine.connect(2, ids.later ?? null);
    // Due within the look-ahead: armed at once, fires on its own.
    const soon = await h.schedule(ctx(), {
      streamerId: ids.later ?? '',
      at: later(300),
      fadeMs: 2000,
    });
    for (let i = 0; i < 40 && (await h.list(scope))[0]?.status !== 'done'; i++) await sleep(50);
    expect((await h.list(scope)).find((x) => x.id === soon.id)?.status).toBe('done');
    // Further ahead: the sweep arms it once it comes within the look-ahead.
    engine.hangUp(2);
    engine.connect(1, ids.guest ?? null);
    const far = await h.schedule(ctx(), {
      streamerId: ids.guest ?? '',
      at: later(30_000),
      fadeMs: 2000,
    });
    await h.sweep(scope);
    await sleep(100);
    expect((await h.list(scope)).find((x) => x.id === far.id)?.status).toBe('pending');
    now = later(29_800);
    await h.sweep(scope);
    const status = async () => (await h.list(scope)).find((x) => x.id === far.id)?.status;
    for (let i = 0; i < 40 && (await status()) !== 'done'; i++) await sleep(50);
    expect((await h.list(scope)).find((x) => x.id === far.id)?.status).toBe('done');
  });

  it('fails when the DJ isn’t connected or may not go on air, and when missed', async () => {
    const absent = await h.schedule(ctx(), {
      streamerId: ids.later ?? '',
      at: later(1000),
      fadeMs: 2000,
    });
    now = later(1000);
    await h.run(scope, absent.id);

    engine.connect(1, ids.guest ?? null);
    const disabled = await h.schedule(ctx(), {
      streamerId: ids.guest ?? '',
      at: later(1000),
      fadeMs: 2000,
    });
    await updateStreamer(tdb.db, ctx(), ids.guest ?? '', { enabled: false });
    now = later(1000);
    await h.run(scope, disabled.id);
    await updateStreamer(tdb.db, ctx(), ids.guest ?? '', { enabled: true });

    // No api running at its time: more than a minute late, it never switches.
    const missed = await h.schedule(ctx(), {
      streamerId: ids.guest ?? '',
      at: later(1000),
      fadeMs: 2000,
    });
    now = later(61_500);
    await h.sweep(scope);

    const byId = new Map((await h.list(scope)).map((x) => [x.id, x]));
    expect([absent, disabled, missed].map((x) => byId.get(x.id)?.reason)).toEqual([
      'not_connected',
      'streamer_not_allowed',
      'missed',
    ]);
    expect(engine.commands).toEqual([]);
  });

  it('keeps the claim of a slow switch, and records it done', async () => {
    h.close();
    h = createLiveHandovers({
      db: tdb.db,
      switcher: s,
      engineFor: async () => engine as LiveSwitchEngine,
      logger,
      now: () => now,
      leaseRenewMs: 20,
    });
    engine.connect(2, ids.later ?? null);
    const scheduled = await h.schedule(ctx(), {
      streamerId: ids.later ?? '',
      at: later(1000),
      fadeMs: 2000,
    });
    let release = () => {};
    engine.hold = new Promise((r) => {
      release = r;
    });
    now = later(1000);
    const running = h.run(scope, scheduled.id);
    for (let i = 0; i < 100 && engine.hold; i++) await sleep(10);
    // Past the lease while the engine call hangs: renewed, so not taken for a dead replica's.
    now = later(70_000);
    await sleep(100);
    await h.sweep(scope);
    expect((await h.list(scope))[0]?.status).toBe('running');
    release();
    await running;
    expect((await h.list(scope))[0]).toMatchObject({ status: 'done', reason: null });
  });

  it('fails a claim left running by a replica that stopped', async () => {
    const scheduled = await h.schedule(ctx(), {
      streamerId: ids.later ?? '',
      at: later(1000),
      fadeMs: 2000,
    });
    await tdb.db
      .update(liveHandover)
      .set({ status: 'running', claimedAt: later(1000) })
      .where(eq(liveHandover.id, scheduled.id));
    now = later(30_000);
    await h.sweep(scope);
    expect((await h.list(scope))[0]?.status).toBe('running');
    now = later(40_000);
    await h.sweep(scope);
    expect((await h.list(scope))[0]).toMatchObject({ status: 'failed', reason: 'interrupted' });
  });

  it('cancels a pending handover once; validates time and DJ', async () => {
    const scheduled = await h.schedule(ctx(), {
      streamerId: ids.later ?? '',
      at: later(60_000),
      fadeMs: 2000,
    });
    expect((await h.cancel(ctx(), scheduled.id)).status).toBe('cancelled');
    await expect(h.cancel(ctx(), scheduled.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'live_handover_ended',
    });
    now = later(60_000);
    await h.run(scope, scheduled.id);
    expect(engine.commands).toEqual([]);

    const bad = (at: Date, streamerId = ids.later ?? '') =>
      h.schedule(ctx(), { streamerId, at, fadeMs: 2000 });
    await expect(bad(later(-1))).rejects.toMatchObject({ code: 'live_handover_in_past' });
    await expect(bad(later(25 * 3600_000))).rejects.toMatchObject({
      code: 'live_handover_too_far',
    });
    await expect(bad(later(1000), crypto.randomUUID())).rejects.toMatchObject({
      name: 'NotFoundError',
    });
    // Another station can't see it, let alone cancel it.
    const pending = await h.schedule(ctx(), {
      streamerId: ids.later ?? '',
      at: later(60_000),
      fadeMs: 2000,
    });
    const other = await createStation(
      tdb.db,
      { actor: system, scope: await resolveOrgScope(tdb.db, scope.orgId) },
      { slug: `other-${crypto.randomUUID().slice(0, 8)}`, name: 'Other', timezone: 'Europe/Paris' },
    );
    const otherScope = await resolveStationScope(tdb.db, scope.orgId, other.id);
    await expect(h.cancel({ actor: system, scope: otherScope }, pending.id)).rejects.toMatchObject({
      name: 'NotFoundError',
    });
    await h.run(otherScope, pending.id);
    expect((await h.list(scope)).find((x) => x.id === pending.id)?.status).toBe('pending');
    const audits = await tdb.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, scheduled.id), like(auditLog.action, 'live_handover.%')))
      .orderBy(auditLog.at);
    expect(audits.map((a) => a.action)).toEqual(['live_handover.create', 'live_handover.cancel']);
  });
});
