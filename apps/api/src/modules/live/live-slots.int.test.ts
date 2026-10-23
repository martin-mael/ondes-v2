import { randomUUID } from 'node:crypto';
import {
  addMembership,
  auditLog,
  createAsset,
  createOrganization,
  createStation,
  episode,
  liveRequest,
  liveSession,
  liveSlotCheck,
  logItem,
  logItemFallback,
  type OrgScope,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
  show,
  user,
} from '@ondes/db';
import { createTestDatabase } from '@ondes/db/testing';
import type { Actor, RaiseAlert, RealtimeEvent, ShowSlot } from '@ondes/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AlertService } from '../alerts/service.ts';
import * as asrun from '../asrun/repo.ts';
import { writeLogDay } from '../log/repo.ts';
import { noClockMusic, noClockResolver } from '../shows/episode-check/fallback.ts';
import { createEpisode, createShow, createSlot, getSlot, updateSlot } from '../shows/repo.ts';
import { createEvent } from './events.ts';
import { createStreamer, updateStreamer } from './repo.ts';
import { createLiveSlotCheck } from './slot-check.ts';
import { standingOf } from './standing.ts';
import { createLiveSwitcher, type LiveSwitchEngine } from './switching.ts';
import { fakeEngine } from './testing/fake-engine.ts';

// Live slots, ad-hoc live and events (#65, ADR 0033) against a real database and the
// in-memory engine pool. Europe/Paris; the DST cases are the last Sundays of March and October.

const system: Actor = { type: 'system', name: 'live-slots-test' };
const logger = { info: () => {}, warn: () => {}, error: () => {} };
const MIN = 60_000;
// Night Shift's live slot: Thursday 5 November 2026, 20:00–21:00 in Paris (19:00–20:00 UTC).
const NIGHT_START = new Date('2026-11-05T19:00:00Z');
// Dawn's: Friday 6 November, 08:00–09:00 (07:00–08:00 UTC), DJ goes live when early.
const DAWN_START = new Date('2026-11-06T07:00:00Z');
// Nobody's slot: Saturday 7 November, noon in Paris.
const OUTSIDE = new Date('2026-11-07T11:00:00Z');

let tdb: Awaited<ReturnType<typeof createTestDatabase>>;
let scope: StationScope;
let orgScope: OrgScope;
let engine: ReturnType<typeof fakeEngine>;
let published: RealtimeEvent[];
let now: Date;
const ids: Record<string, string> = {};
let nightSlot: ShowSlot;
let dawnSlot: ShowSlot;

const ctx = () => ({ actor: system, scope });
const at = (d: Date, minutes = 0) => new Date(d.getTime() + minutes * MIN);

function switcher(onSlotLive?: (s: StationScope, o: { slotId: string; date: string }) => unknown) {
  return createLiveSwitcher({
    db: tdb.db,
    engineFor: async (stationId) =>
      stationId === scope.stationId ? (engine as LiveSwitchEngine) : undefined,
    publish: (event) => {
      published.push(event);
    },
    logger,
    now: () => now,
    ...(onSlotLive ? { onSlotLive } : {}),
  });
}

async function sessions() {
  return tdb.db
    .select()
    .from(liveSession)
    .where(eq(liveSession.stationId, scope.stationId))
    .orderBy(liveSession.startedAt);
}

async function openSession() {
  return (await sessions()).find((s) => s.endedAt === null);
}

/** The streamer just logged in (the auth callback stamps it). */
async function login(name: string, when = now) {
  const { streamer } = await import('@ondes/db');
  await tdb.db
    .update(streamer)
    .set({ lastConnectedAt: when })
    .where(eq(streamer.id, ids[name] as string));
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  const db = tdb.db;
  const org = await createOrganization(db, system, { slug: 'live-slots-org', name: 'Org' });
  orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: 'live-slots-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(db, org.id, st.id);
  const night = await createShow(db, ctx(), { name: 'Night Shift' });
  ids.night = night.id;
  nightSlot = await createSlot(db, ctx(), night.id, {
    type: 'live',
    rule: { freq: 'once', date: '2026-11-05', time: '20:00' },
    durationMs: 60 * MIN,
    live: { graceMs: 10 * MIN },
  });
  const dawn = await createShow(db, ctx(), { name: 'Dawn' });
  ids.dawn = dawn.id;
  dawnSlot = await createSlot(db, ctx(), dawn.id, {
    type: 'live',
    rule: { freq: 'once', date: '2026-11-06', time: '08:00' },
    durationMs: 60 * MIN,
    live: { earlyConnect: 'go_live' },
  });
  // Weekly on Sundays at 02:30: in the spring-forward gap on 29 March, twice on 25 October.
  const small = await createShow(db, ctx(), { name: 'Small Hours' });
  ids.small = small.id;
  await createSlot(db, ctx(), small.id, {
    type: 'live',
    rule: {
      freq: 'weekly',
      startDate: '2026-03-01',
      until: '2026-11-01',
      interval: 1,
      byDay: ['su'],
      time: '02:30',
    },
    durationMs: 60 * MIN,
  });
  const people: [string, object][] = [
    ['resident', { showIds: [night.id, small.id] }],
    ['early', { showIds: [dawn.id] }],
    ['guest', { anyTime: true }],
    ['walkin', { anyTime: true, adHoc: 'allowed' }],
    ['stage', { anyTime: true }],
  ];
  for (const [username, extra] of people) {
    const created = await createStreamer(db, ctx(), {
      displayName: `DJ ${username}`,
      username,
      ...extra,
    });
    ids[username] = created.streamer.id;
  }
}, 60_000);

afterAll(() => tdb?.drop());

beforeEach(async () => {
  await tdb.db.delete(liveSession);
  await tdb.db.delete(liveRequest);
  engine = fakeEngine();
  published = [];
  now = OUTSIDE;
});

describe('live slot settings', () => {
  it('defaults, keeps and drops them with the slot type', async () => {
    const s = await createShow(tdb.db, ctx(), { name: 'Settings' });
    const slot = await createSlot(tdb.db, ctx(), s.id, {
      type: 'live',
      rule: { freq: 'once', date: '2026-12-01', time: '10:00' },
      durationMs: 30 * MIN,
    });
    expect(slot.live).toEqual({ graceMs: 5 * MIN, earlyConnect: 'wait' });
    const changed = await updateSlot(tdb.db, ctx(), s.id, slot.id, {
      live: { earlyConnect: 'go_live' },
    });
    expect(changed.slot.live).toEqual({ graceMs: 5 * MIN, earlyConnect: 'go_live' });
    const pre = await updateSlot(tdb.db, ctx(), s.id, slot.id, { type: 'prerecorded' });
    expect(pre.slot.live).toBeNull();
    await expect(
      createSlot(tdb.db, ctx(), s.id, {
        type: 'prerecorded',
        rule: { freq: 'once', date: '2026-12-02', time: '10:00' },
        durationMs: 30 * MIN,
        live: { graceMs: 0 },
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'not_a_live_slot' });
    const audits = await tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, slot.id), eq(auditLog.action, 'show_slot.update')));
    expect(audits).toHaveLength(2);
  });
});

describe('standing', () => {
  it('reads live slots in station time across DST', async () => {
    const resident = ids.resident as string;
    // 29 March: 02:30 doesn't exist and airs at 03:30 CEST (01:30 UTC).
    expect((await standingOf(tdb.db, scope, resident, new Date('2026-03-29T01:35:00Z'))).kind).toBe(
      'slot',
    );
    // 15 min before it: waiting (the slot waits for its start).
    expect((await standingOf(tdb.db, scope, resident, new Date('2026-03-29T01:20:00Z'))).kind).toBe(
      'waiting',
    );
    // An hour before (01:30 CET, wall clock): nothing yet.
    expect((await standingOf(tdb.db, scope, resident, new Date('2026-03-29T00:30:00Z'))).kind).toBe(
      'ad_hoc',
    );
    // 25 October: the first 02:30 (CEST, 00:30 UTC), not the second (CET, 01:30 UTC).
    const oct = await standingOf(tdb.db, scope, resident, new Date('2026-10-25T00:40:00Z'));
    expect(oct).toMatchObject({
      kind: 'slot',
      binding: { occurrence: { date: '2026-10-25', startsAt: new Date('2026-10-25T00:30:00Z') } },
    });
    expect((await standingOf(tdb.db, scope, resident, new Date('2026-10-25T01:40:00Z'))).kind).toBe(
      'ad_hoc',
    );
  });
});

describe('live slots', () => {
  it('puts the DJ on air at the slot start with a new episode, and keeps it on a reconnect', async () => {
    const live: { slotId: string; date: string }[] = [];
    const s = switcher((_, o) => live.push(o));
    engine.connect(1, ids.resident ?? null);
    // Connected 10 min early, slot waits: nothing on air, nothing to approve.
    now = at(NIGHT_START, -10);
    await s.sweep(scope);
    expect(await sessions()).toHaveLength(0);
    expect(await tdb.db.select().from(liveRequest)).toHaveLength(0);

    now = at(NIGHT_START, 1);
    await s.sweep(scope);
    const first = await openSession();
    expect(first).toMatchObject({
      trigger: 'slot',
      showId: ids.night,
      slotId: nightSlot.id,
      occurrenceDate: '2026-11-05',
      title: 'Night Shift',
      streamerName: 'DJ resident',
      episodeNumber: 1,
      scheduledEndAt: at(NIGHT_START, 60),
    });
    expect(live).toEqual([{ slotId: nightSlot.id, date: '2026-11-05' }]);
    const [ep] = await tdb.db
      .select()
      .from(episode)
      .where(eq(episode.id, first?.episodeId as string));
    expect(ep).toMatchObject({ kind: 'live', status: 'aired', number: 1, airedAt: now });
    const [counter] = await tdb.db
      .select({ next: show.nextEpisodeNumber })
      .from(show)
      .where(eq(show.id, ids.night as string));
    expect(counter?.next).toBe(2);
    const status = await s.status(scope, true);
    expect(status.session).toMatchObject({
      show: { id: ids.night, name: 'Night Shift' },
      episode: { id: ep?.id, number: 1 },
      title: 'Night Shift',
    });

    // The as-run shows the live session with show, episode and DJ (the issue's acceptance).
    const recorded = await asrun.recordStart(tdb.db, scope, {
      eventId: randomUUID(),
      bootId: 'b1',
      seq: 1,
      at: now,
      itemId: null,
      segmentId: null,
      source: 'live',
      title: 'Live mix',
      artist: null,
      filename: null,
      rid: null,
      liveSessionId: first?.id ?? null,
    });
    expect(recorded?.entry).toMatchObject({
      source: 'live',
      liveSessionId: first?.id,
      episode: { id: ep?.id, showId: ids.night, number: 1, rerun: false },
      live: { sessionId: first?.id, djName: 'DJ resident', title: 'Night Shift' },
    });

    // They drop and reconnect: a new session, the same episode.
    engine.hangUp(1);
    await s.onEvent({
      id: randomUUID(),
      stationId: scope.stationId,
      at: now.toISOString(),
      type: 'engine.live.disconnected',
      data: { bootId: 'b1', seq: 2, input: 1, streamerId: null },
    } as RealtimeEvent);
    now = at(NIGHT_START, 5);
    engine.connect(2, ids.resident ?? null);
    await login('resident');
    await s.sweep(scope);
    const second = await openSession();
    expect(second).toMatchObject({ input: 2, trigger: 'slot', episodeId: first?.episodeId });
    expect(second?.id).not.toBe(first?.id);
  });

  it('uses the episode planned for the occurrence and puts an early DJ on air for go_live', async () => {
    const planned = await createEpisode(tdb.db, ctx(), ids.dawn as string, {
      number: 7,
      title: 'Dawn #7',
      slotId: dawnSlot.id,
      occurrenceDate: '2026-11-06',
    });
    expect(planned).toMatchObject({ kind: 'live', status: 'planned' });
    const s = switcher();
    engine.connect(1, ids.early ?? null);
    now = at(DAWN_START, -12);
    await s.sweep(scope);
    expect(await openSession()).toMatchObject({
      trigger: 'slot',
      episodeId: planned.id,
      episodeNumber: 7,
      scheduledEndAt: at(DAWN_START, 60),
    });
    const [ep] = await tdb.db.select().from(episode).where(eq(episode.id, planned.id));
    expect(ep?.status).toBe('aired');
  });

  it('a slot DJ takes over from an ad-hoc DJ, never from one put on air by hand', async () => {
    const s = switcher();
    engine.connect(1, ids.walkin ?? null);
    now = at(NIGHT_START, -30);
    await s.sweep(scope);
    expect(await openSession()).toMatchObject({ trigger: 'ad_hoc', streamerId: ids.walkin });

    engine.connect(2, ids.resident ?? null);
    now = at(NIGHT_START, 1);
    await s.sweep(scope);
    expect(await openSession()).toMatchObject({ trigger: 'slot', streamerId: ids.resident });
    expect(engine.commands).toEqual(['open 1', 'open 2']);

    // A manager hands the air back to the walk-in by hand: the slot DJ doesn't grab it again.
    await s.goLive(ctx(), 1, 'manual', null);
    now = at(NIGHT_START, 2);
    await s.sweep(scope);
    expect(await openSession()).toMatchObject({ trigger: 'manual', streamerId: ids.walkin });
  });
});

describe('ad-hoc live', () => {
  it('puts an allowed DJ on air, and a manual return holds until they log in again', async () => {
    const s = switcher();
    engine.connect(1, ids.walkin ?? null);
    await login('walkin', at(OUTSIDE, -1));
    await s.sweep(scope);
    expect(await openSession()).toMatchObject({ trigger: 'ad_hoc', title: null, slotId: null });
    now = at(OUTSIDE, 1);
    await s.returnToAutomation(ctx());
    now = at(OUTSIDE, 2);
    await s.sweep(scope);
    expect(await openSession()).toBeUndefined();
    await login('walkin', at(OUTSIDE, 3));
    now = at(OUTSIDE, 4);
    await s.sweep(scope);
    expect(await openSession()).toMatchObject({ trigger: 'ad_hoc' });
  });

  it('asks once per connection, and a manager approves', async () => {
    const s = switcher();
    engine.connect(2, ids.guest ?? null);
    await login('guest', at(OUTSIDE, -1));
    await s.sweep(scope);
    await s.sweep(scope);
    expect(await openSession()).toBeUndefined();
    const rows = await tdb.db.select().from(liveRequest);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', input: 2, streamerId: ids.guest });
    expect(published.filter((e) => e.type === 'live.request.created')).toHaveLength(1);

    const manager: Actor = { type: 'system', name: 'manager' };
    const session = await s.approve({ actor: manager, scope }, rows[0]?.id as string);
    expect(session).toMatchObject({ trigger: 'ad_hoc', input: 2 });
    await expect(s.approve({ actor: manager, scope }, rows[0]?.id as string)).rejects.toMatchObject(
      { statusCode: 409, code: 'live_request_decided' },
    );
    expect(published.find((e) => e.type === 'live.request.decided')).toMatchObject({
      data: { status: 'approved' },
    });
    // On air: no new request on the next sweep.
    now = at(OUTSIDE, 1);
    await s.sweep(scope);
    expect(await tdb.db.select().from(liveRequest)).toHaveLength(1);
  });

  it('a refused DJ stays off air until they log in again; hanging up cancels a pending request', async () => {
    const s = switcher();
    engine.connect(1, ids.guest ?? null);
    await login('guest', at(OUTSIDE, -1));
    await s.sweep(scope);
    const [pending] = await tdb.db.select().from(liveRequest);
    await s.refuse(ctx(), pending?.id as string);
    now = at(OUTSIDE, 1);
    await s.sweep(scope);
    expect(await openSession()).toBeUndefined();
    expect(await tdb.db.select().from(liveRequest)).toHaveLength(1);

    // A new login is a new request; hanging up before anyone answers cancels it.
    await login('guest', at(OUTSIDE, 2));
    now = at(OUTSIDE, 3);
    await s.sweep(scope);
    const pendingNow = await tdb.db
      .select()
      .from(liveRequest)
      .where(eq(liveRequest.status, 'pending'));
    expect(pendingNow).toHaveLength(1);
    engine.hangUp(1);
    await s.sweep(scope);
    const [cancelled] = await tdb.db
      .select()
      .from(liveRequest)
      .where(eq(liveRequest.id, pendingNow[0]?.id as string));
    expect(cancelled?.status).toBe('cancelled');
    await expect(s.approve(ctx(), cancelled?.id as string)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe('events', () => {
  it('puts the event DJ on air at its start, with its title', async () => {
    const event = await createEvent(tdb.db, ctx(), {
      title: 'Fête de la musique',
      startsAt: new Date('2026-11-08T17:00:00Z'),
      endsAt: new Date('2026-11-08T21:00:00Z'),
      streamerIds: [ids.stage as string],
    });
    const s = switcher();
    engine.connect(1, ids.stage ?? null);
    await login('stage', new Date('2026-11-08T16:50:00Z'));
    now = new Date('2026-11-08T16:50:00Z');
    await s.sweep(scope);
    // Waiting for the start: no request either.
    expect(await openSession()).toBeUndefined();
    expect(await tdb.db.select().from(liveRequest)).toHaveLength(0);
    now = new Date('2026-11-08T17:00:30Z');
    await s.sweep(scope);
    expect(await openSession()).toMatchObject({
      trigger: 'event',
      eventId: event.id,
      title: 'Fête de la musique',
      scheduledEndAt: new Date('2026-11-08T21:00:00Z'),
    });
  });
});

describe('missed live slots', () => {
  it('raises the alert, puts the fallback in the log after the grace period and marks the episode missing', async () => {
    const raised: RaiseAlert[] = [];
    const resolved: string[] = [];
    const alerts = {
      raise: async (_: StationScope, input: RaiseAlert) => {
        raised.push(input);
        return { alert: null, outcome: 'raised' };
      },
      resolve: async (_: StationScope, key: string) => {
        resolved.push(key);
        return null;
      },
    } as unknown as AlertService;
    // Its own show: Ghost Shift, Monday 9 November 20:00–21:00 in Paris, 10 min grace.
    const ghost = await createShow(tdb.db, ctx(), { name: 'Ghost Shift' });
    const ghostSlot = await createSlot(tdb.db, ctx(), ghost.id, {
      type: 'live',
      rule: { freq: 'once', date: '2026-11-09', time: '20:00' },
      durationMs: 60 * MIN,
      live: { graceMs: 10 * MIN },
    });
    const GHOST_START = new Date('2026-11-09T19:00:00Z');
    // A Ghost Shift episode that already aired, with audio: the latest-episode fallback.
    const assetId = (await createAsset(tdb.db, ctx(), { type: 'episode', title: 'Ghost Shift #0' }))
      .id;
    const aired = await createEpisode(tdb.db, ctx(), ghost.id, {
      number: 100,
      assetId,
      status: 'aired',
      airedAt: '2026-10-01T19:00:00Z',
    });
    // The planned premiere that won't happen.
    const premiere = await createEpisode(tdb.db, ctx(), ghost.id, {
      slotId: ghostSlot.id,
      occurrenceDate: '2026-11-09',
    });
    // The generator's live slot item (#50).
    await writeLogDay(tdb.db, ctx(), {
      localDate: '2026-11-09',
      status: 'published',
      cause: 'generate',
      items: [
        {
          kind: 'live_slot',
          plannedDurationMs: 60 * MIN,
          title: 'Ghost Shift',
          timing: 'hard',
          anchorAt: GHOST_START.toISOString(),
          origin: { type: 'show', showSlotId: ghostSlot.id },
        },
      ],
    });
    const check = createLiveSlotCheck({
      db: tdb.db,
      alerts,
      fallback: { resolveClock: noClockResolver, clockMusic: noClockMusic },
      logger: logger as never,
      now: () => now,
    });
    // Within the 10 min grace: nothing.
    now = at(GHOST_START, 9);
    await check.sweep(scope);
    expect(raised).toHaveLength(0);

    now = at(GHOST_START, 10);
    await check.sweep(scope);
    await check.sweep(scope);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      type: 'live.slot_missed',
      severity: 'warning',
      dedupeKey: `live.slot_missed:${ghostSlot.id}:2026-11-09`,
      details: { fallback: 'latest_episode', i18n: { key: 'liveSlotMissed.fallback' } },
    });
    const items = await tdb.db
      .select()
      .from(logItem)
      .where(eq(logItem.stationId, scope.stationId))
      .orderBy(logItem.position);
    expect(items.map((i) => [i.kind, i.plannedDurationMs])).toEqual([
      ['live_slot', 10 * MIN],
      ['episode', 50 * MIN],
    ]);
    expect(items[1]).toMatchObject({ assetId, episodeId: aired.id });
    const [mark] = await tdb.db.select().from(logItemFallback);
    expect(mark).toMatchObject({ kind: 'latest_episode', missingEpisodeId: premiere.id });

    // The slot ends with nobody on air: the premiere is missing, the alert resolves.
    now = at(GHOST_START, 61);
    await check.sweep(scope);
    await check.sweep(scope);
    const [ep] = await tdb.db.select().from(episode).where(eq(episode.id, premiere.id));
    expect(ep?.status).toBe('missing');
    expect(resolved).toEqual([`live.slot_missed:${ghostSlot.id}:2026-11-09`]);
    const [row] = await tdb.db.select().from(liveSlotCheck);
    expect(row).toMatchObject({ fallback: 'latest_episode' });
    expect(row?.closedAt).not.toBeNull();
    // The slot's settings are unchanged by all this.
    expect((await getSlot(tdb.db, scope, ghost.id, ghostSlot.id)).live).toEqual({
      graceMs: 10 * MIN,
      earlyConnect: 'wait',
    });
  });
});

describe('review fixes', () => {
  /** A show with a live slot on `date` at 20:00 Paris (19:00 UTC in November), 10 min grace. */
  async function liveShow(name: string, date: string) {
    const created = await createShow(tdb.db, ctx(), { name });
    const slot = await createSlot(tdb.db, ctx(), created.id, {
      type: 'live',
      rule: { freq: 'once', date, time: '20:00' },
      durationMs: 60 * MIN,
      live: { graceMs: 10 * MIN },
    });
    return { show: created, slot, start: new Date(`${date}T19:00:00Z`) };
  }

  async function dj(username: string, extra: object) {
    const created = await createStreamer(tdb.db, ctx(), {
      displayName: `DJ ${username}`,
      username,
      ...extra,
    });
    ids[username] = created.streamer.id;
    return created.streamer.id;
  }

  const fakeAlerts = () => {
    const raised: RaiseAlert[] = [];
    const resolved: string[] = [];
    const alerts = {
      raise: async (_: StationScope, input: RaiseAlert) => {
        raised.push(input);
        return { alert: null, outcome: 'raised' };
      },
      resolve: async (_: StationScope, key: string) => {
        resolved.push(key);
        return null;
      },
    } as unknown as AlertService;
    return { raised, resolved, alerts };
  };

  const slotCheck = (alerts: AlertService) =>
    createLiveSlotCheck({
      db: tdb.db,
      alerts,
      fallback: { resolveClock: noClockResolver, clockMusic: noClockMusic },
      logger: logger as never,
      now: () => now,
    });

  it('binds a DJ on air ad hoc to their slot when it starts: episode, as-run, no missed alert', async () => {
    const { show: overlap, slot, start } = await liveShow('Overlap', '2026-11-10');
    const planned = await createEpisode(tdb.db, ctx(), overlap.id, {
      slotId: slot.id,
      occurrenceDate: '2026-11-10',
    });
    const host = await dj('host', { showIds: [overlap.id], anyTime: true, adHoc: 'allowed' });
    const { raised, resolved, alerts } = fakeAlerts();
    const check = slotCheck(alerts);
    const s = switcher();
    engine.connect(1, host);
    now = at(start, -30);
    await s.sweep(scope);
    const adHoc = await openSession();
    expect(adHoc).toMatchObject({ trigger: 'ad_hoc', slotId: null });
    // The engine reports the DJ's audio: one live as-run entry, still on air.
    await asrun.recordStart(tdb.db, scope, {
      eventId: randomUUID(),
      bootId: 'b1',
      seq: 50,
      at: now,
      itemId: null,
      segmentId: null,
      source: 'live',
      title: null,
      artist: null,
      filename: null,
      rid: null,
      liveSessionId: adHoc?.id ?? null,
    });

    now = at(start, 1);
    await s.sweep(scope);
    const bound = await openSession();
    expect(bound).toMatchObject({
      id: adHoc?.id,
      trigger: 'slot',
      slotId: slot.id,
      occurrenceDate: '2026-11-10',
      episodeId: planned.id,
      title: 'Overlap',
      scheduledEndAt: at(start, 60),
    });
    // Same session, no gate change.
    expect(engine.commands).toEqual(['open 1']);
    const { items } = await asrun.listAsRun(tdb.db, scope, {
      from: at(start, -60).toISOString(),
      to: at(start, 60).toISOString(),
    });
    expect(items.find((e) => e.liveSessionId === adHoc?.id)).toMatchObject({
      episode: { id: planned.id, number: planned.number },
      live: { djName: 'DJ host', title: 'Overlap' },
    });

    // Past the grace period and at the end: not missed, the episode aired.
    now = at(start, 11);
    await check.sweep(scope);
    now = at(start, 61);
    await check.sweep(scope);
    expect(raised).toHaveLength(0);
    expect(resolved).toEqual([`live.slot_missed:${slot.id}:2026-11-10`]);
    const [ep] = await tdb.db.select().from(episode).where(eq(episode.id, planned.id));
    expect(ep?.status).toBe('aired');
  });

  it('counts a DJ of the show on air across the slot even when unbound', async () => {
    const { show: s2, slot, start } = await liveShow('Unbound', '2026-11-11');
    const host2 = await dj('host2', { showIds: [s2.id], anyTime: true });
    // Put on air by hand before the slot and never bound (another replica's sweep, say).
    await tdb.db.insert(liveSession).values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      streamerId: host2,
      input: 1,
      trigger: 'manual',
      startedAt: at(start, -20),
    });
    const { raised, alerts } = fakeAlerts();
    now = at(start, 15);
    await slotCheck(alerts).sweep(scope);
    expect(raised).toHaveLength(0);
    expect(slot.id).toBeTruthy();
  });

  it('keeps an ad-hoc request pending when going on air fails', async () => {
    const shy = await dj('shy', { anyTime: true });
    const s = switcher();
    engine.connect(1, shy);
    await login('shy', at(OUTSIDE, -1));
    await s.sweep(scope);
    const [pending] = await tdb.db
      .select()
      .from(liveRequest)
      .where(eq(liveRequest.streamerId, shy));
    // Disabled since (the revoker isn't wired here): the go-live refuses.
    await updateStreamer(tdb.db, ctx(), shy, { enabled: false });
    await expect(s.approve(ctx(), pending?.id as string)).rejects.toMatchObject({
      statusCode: 409,
      code: 'streamer_not_allowed',
    });
    const [after] = await tdb.db
      .select()
      .from(liveRequest)
      .where(eq(liveRequest.id, pending?.id as string));
    expect(after?.status).toBe('pending');
    expect(published.some((e) => e.type === 'live.request.decided')).toBe(false);
  });

  it('keeps a session the engine applied though its call failed, and closes an untracked gate', async () => {
    const s = switcher();
    engine.connect(1, ids.walkin ?? null);
    const setLive = engine.setLive;
    engine.setLive = async (enabled, opts) => {
      await setLive(enabled, opts);
      throw new Error('timeout');
    };
    const session = await s.goLive(ctx(), 1, 'manual', null);
    expect(engine.sessionId).toBe(session.id);
    expect(await openSession()).toMatchObject({ id: session.id });
    engine.setLive = setLive;

    // A gate on a session Node has no record of: closed by the next sweep.
    await tdb.db.delete(liveSession);
    now = at(OUTSIDE, 1);
    await s.sweep(scope);
    expect(engine.commands.at(-1)).toBe('close');
    expect(engine.enabled).toBe(false);
  });

  it('an event listing nobody needs approval for approval DJs, and binds the approved session', async () => {
    const event = await createEvent(tdb.db, ctx(), {
      title: 'Open mic',
      startsAt: new Date('2026-11-12T19:00:00Z'),
      endsAt: new Date('2026-11-12T21:00:00Z'),
    });
    const s = switcher();
    now = new Date('2026-11-12T19:05:00Z');
    engine.connect(1, ids.guest ?? null);
    await login('guest');
    await s.sweep(scope);
    expect(await openSession()).toBeUndefined();
    const [pending] = await tdb.db
      .select()
      .from(liveRequest)
      .where(
        and(eq(liveRequest.streamerId, ids.guest as string), eq(liveRequest.status, 'pending')),
      );
    expect(pending).toBeTruthy();
    await s.approve(ctx(), pending?.id as string);
    expect(await openSession()).toMatchObject({
      trigger: 'ad_hoc',
      eventId: event.id,
      title: 'Open mic',
    });

    // An `allowed` DJ goes on air for it by themselves.
    await tdb.db.delete(liveSession);
    engine = fakeEngine();
    engine.connect(2, ids.walkin ?? null);
    now = new Date('2026-11-12T19:10:00Z');
    await s.sweep(scope);
    expect(await openSession()).toMatchObject({ trigger: 'event', eventId: event.id });
  });

  it('a slot DJ wins over an event DJ connected on a lower input', async () => {
    const { show: s3, start } = await liveShow('Clash', '2026-11-13');
    const slotDj = await dj('clash', { showIds: [s3.id] });
    await createEvent(tdb.db, ctx(), {
      title: 'Clashing event',
      startsAt: at(start, -30),
      endsAt: at(start, 60),
      streamerIds: [ids.stage as string],
    });
    const s = switcher();
    engine.connect(1, ids.stage ?? null);
    engine.connect(2, slotDj);
    now = at(start, 1);
    await s.sweep(scope);
    expect(await openSession()).toMatchObject({ trigger: 'slot', streamerId: slotDj, input: 2 });
  });

  it('a manager can’t approve their own request while another manager can', async () => {
    const [me] = await tdb.db
      .insert(user)
      .values({ email: 'selfie@live-slots.test', name: 'Selfie' })
      .returning();
    const [other] = await tdb.db
      .insert(user)
      .values({ email: 'other@live-slots.test', name: 'Other' })
      .returning();
    const meId = me?.id as string;
    // A station manager who is also a DJ.
    const mgr = { actor: system, scope: orgScope };
    await addMembership(tdb.db, mgr, {
      level: 'station',
      stationId: scope.stationId,
      userId: meId,
      role: 'station_manager',
    });
    const selfie = await dj('selfie', { anyTime: true, userId: meId });
    const s = switcher();
    engine.connect(1, selfie);
    await login('selfie');
    await s.sweep(scope);
    const [pending] = await tdb.db
      .select()
      .from(liveRequest)
      .where(eq(liveRequest.streamerId, selfie));
    const asMe = { actor: { type: 'user' as const, userId: meId }, scope };
    // Another manager can decide: refused.
    await addMembership(tdb.db, mgr, {
      level: 'station',
      stationId: scope.stationId,
      userId: other?.id as string,
      role: 'station_manager',
    });
    await expect(s.approve(asMe, pending?.id as string)).rejects.toMatchObject({
      statusCode: 403,
      code: 'live_self_approval',
    });
  });

  it('closes a missed slot whose end is long past (an outage), and reads DST slots right', async () => {
    const { raised, resolved, alerts } = fakeAlerts();
    const check = slotCheck(alerts);
    // Small Hours, 29 March: 02:30 is in the gap and airs 03:30 CEST (01:30 UTC), 5 min grace.
    now = new Date('2026-03-29T01:34:00Z');
    await check.sweep(scope);
    expect(raised).toHaveLength(0);
    now = new Date('2026-03-29T01:35:00Z');
    await check.sweep(scope);
    expect(raised).toHaveLength(1);
    // No log item for it: nothing could stand in.
    expect(raised[0]).toMatchObject({
      severity: 'critical',
      details: { occurrenceDate: '2026-03-29', startsAt: '2026-03-29T01:30:00.000Z' },
    });
    // The api was down for two days: the row is closed all the same.
    now = new Date('2026-03-31T12:00:00Z');
    await check.sweep(scope);
    const [row] = await tdb.db
      .select()
      .from(liveSlotCheck)
      .where(eq(liveSlotCheck.occurrenceDate, '2026-03-29'));
    expect(row?.closedAt).toEqual(now);
    expect(resolved).toContain(row ? `live.slot_missed:${row.slotId}:2026-03-29` : '');

    // 25 October: the first 02:30 (CEST, 00:30 UTC); ends 01:30 UTC, during the second 02:30.
    now = new Date('2026-10-25T00:35:00Z');
    await check.sweep(scope);
    expect(raised.at(-1)).toMatchObject({
      details: { occurrenceDate: '2026-10-25', startsAt: '2026-10-25T00:30:00.000Z' },
    });
    now = new Date('2026-10-25T01:31:00Z');
    await check.sweep(scope);
    const [oct] = await tdb.db
      .select()
      .from(liveSlotCheck)
      .where(eq(liveSlotCheck.occurrenceDate, '2026-10-25'));
    expect(oct?.closedAt).toEqual(now);
  });
});
