import { randomUUID } from 'node:crypto';
import {
  addMembership,
  auditLog,
  createAsset,
  createOrganization,
  createStation,
  logDay,
  logItem,
  resolveOrgScope,
  resolveRerun,
  resolveStationScope,
  type StationScope,
  showSlot,
} from '@ondes/db';
import type {
  Actor,
  AsRunList,
  Episode,
  Show,
  ShowOccurrencesResponse,
  ShowSlot,
  ShowSlotChange,
} from '@ondes/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as asrun from '../asrun/repo.ts';
import { createTestApp, signUpAndLogin, type TestApp } from '../auth/testing.ts';

// Reruns (#48): rerun slots and their strategy, "schedule a rerun", what each rerun occurrence
// resolves to (also across the March DST change), and the as-run's episode number and rerun
// flag (now playing).

const system: Actor = { type: 'system', name: 'test' };
const H = 3600 * 1000;

let t: TestApp;
let stationId: string;
let scope: StationScope;
const users: Record<'programmer' | 'presenter', { userId: string; cookie: string }> = {} as never;

beforeAll(async () => {
  t = await createTestApp();
  const db = t.tdb.db;
  const org = await createOrganization(db, system, { slug: 'reruns-org', name: 'Org' });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: 'reruns-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  stationId = st.id;
  scope = await resolveStationScope(db, org.id, st.id);
  for (const who of ['programmer', 'presenter'] as const) {
    users[who] = await signUpAndLogin(t, `${who}@reruns.test`);
    await addMembership(
      db,
      { actor: system, scope: orgScope },
      { level: 'station', stationId, userId: users[who].userId, role: who },
    );
  }
}, 60_000);

afterAll(() => t?.close());

function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  who: 'programmer' | 'presenter' = 'programmer',
) {
  return t.app.inject({
    method,
    url: `/api/v1/stations/${stationId}${url}`,
    cookies: { ondes_session: users[who].cookie },
    ...(payload ? { payload } : {}),
  });
}

async function ok<T>(res: Awaited<ReturnType<typeof call>>, status = 200): Promise<T> {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as T;
}

async function newShow(name: string): Promise<Show> {
  return ok<Show>(await call('POST', '/shows', { name, defaultDurationMs: 2 * H }), 201);
}

async function newSlot(showId: string, body: object): Promise<ShowSlot> {
  return ok<ShowSlot>(await call('POST', `/shows/${showId}/slots`, body), 201);
}

async function newEpisode(
  showId: string,
  extra: {
    slotId?: string;
    occurrenceDate?: string;
    audio?: boolean;
    durationMs?: number;
    /** Marked aired at this time (what the as-run does on its first airing). */
    airedAt?: string;
  } = {},
): Promise<Episode> {
  const { audio = true, durationMs, airedAt, ...occurrence } = extra;
  const assetId = audio
    ? (
        await createAsset(
          t.tdb.db,
          { actor: system, scope },
          { type: 'episode', title: 'audio', ...(durationMs ? { durationMs } : {}) },
        )
      ).id
    : null;
  return ok<Episode>(
    await call('POST', `/shows/${showId}/episodes`, {
      assetId,
      ...occurrence,
      ...(airedAt ? { status: 'aired', airedAt } : {}),
    }),
    201,
  );
}

const longAgo = '2026-01-01T12:00:00Z';

async function occurrences(showId: string, from: string, to: string) {
  return ok<ShowOccurrencesResponse>(
    await call('GET', `/show-occurrences?from=${from}&to=${to}&showId=${showId}`),
  );
}

const weekly = (startDate: string, byDay: string[], time: string) => ({
  freq: 'weekly',
  startDate,
  until: null,
  interval: 1,
  byDay,
  time,
});

describe('rerun slots', () => {
  it('defaults a rerun slot to the latest episode, and only rerun slots take a strategy', async () => {
    const s = await newShow('Default');
    const slot = await newSlot(s.id, {
      type: 'rerun',
      rule: weekly('2027-01-04', ['mo'], '10:00'),
    });
    expect(slot.rerun).toEqual({ strategy: 'latest_episode' });

    const live = await newSlot(s.id, { type: 'live', rule: weekly('2027-01-04', ['tu'], '20:00') });
    expect(live.rerun).toBeNull();

    const refused = await call('POST', `/shows/${s.id}/slots`, {
      type: 'prerecorded',
      rule: weekly('2027-01-04', ['we'], '20:00'),
      rerun: { strategy: 'latest_episode' },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe('not_a_rerun_slot');
  });

  it("refuses another show's episode", async () => {
    const a = await newShow('A');
    const b = await newShow('B');
    const ep = await newEpisode(b.id);
    const res = await call('POST', `/shows/${a.id}/slots`, {
      type: 'rerun',
      rule: weekly('2027-01-04', ['mo'], '10:00'),
      rerun: { strategy: 'episode', episodeId: ep.id },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('unknown_episode');
  });

  it('sets, keeps and drops the strategy as the slot changes, audited', async () => {
    const s = await newShow('Changes');
    const ep = await newEpisode(s.id);
    const slot = await newSlot(s.id, {
      type: 'prerecorded',
      rule: weekly('2027-01-04', ['mo'], '10:00'),
    });
    const toRerun = await ok<ShowSlotChange>(
      await call('PATCH', `/shows/${s.id}/slots/${slot.id}`, { type: 'rerun' }),
    );
    expect(toRerun.slot.rerun).toEqual({ strategy: 'latest_episode' });

    const chosen = await ok<ShowSlotChange>(
      await call('PATCH', `/shows/${s.id}/slots/${slot.id}`, {
        rerun: { strategy: 'episode', episodeId: ep.id },
      }),
    );
    expect(chosen.slot.rerun).toEqual({ strategy: 'episode', episodeId: ep.id });

    // Another change keeps the strategy.
    const moved = await ok<ShowSlotChange>(
      await call('PATCH', `/shows/${s.id}/slots/${slot.id}`, { durationMs: H }),
    );
    expect(moved.slot.rerun).toEqual({ strategy: 'episode', episodeId: ep.id });

    const back = await ok<ShowSlotChange>(
      await call('PATCH', `/shows/${s.id}/slots/${slot.id}`, { type: 'prerecorded' }),
    );
    expect(back.slot.rerun).toBeNull();

    const rows = await t.tdb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, slot.id))
      .orderBy(asc(auditLog.at));
    expect(rows.map((r) => r.action)).toEqual([
      'show_slot.create',
      'show_slot.update',
      'show_slot.update',
      'show_slot.update',
      'show_slot.update',
    ]);
  });

  it('reads a rerun slot stored without a strategy (before #48) as the latest episode', async () => {
    const s = await newShow('Legacy');
    const slot = await newSlot(s.id, {
      type: 'rerun',
      rule: weekly('2027-01-04', ['mo'], '10:00'),
    });
    await t.tdb.db
      .update(showSlot)
      .set({ rerunStrategy: null, rerunEpisodeId: null })
      .where(eq(showSlot.id, slot.id));
    const slots = await ok<{ items: ShowSlot[] }>(await call('GET', `/shows/${s.id}/slots`));
    expect(slots.items.find((x) => x.id === slot.id)?.rerun).toEqual({
      strategy: 'latest_episode',
    });
    const ep = await newEpisode(s.id, { airedAt: longAgo });
    const res = await occurrences(s.id, '2027-01-04T00:00:00Z', '2027-01-05T00:00:00Z');
    expect(res.occurrences.find((o) => o.slotId === slot.id)?.rerunOf?.id).toBe(ep.id);
  });

  it('saves a chosen-episode strategy before the episode is picked', async () => {
    const s = await newShow('Incomplete');
    const ep = await newEpisode(s.id, { airedAt: longAgo });
    const slot = await newSlot(s.id, {
      type: 'rerun',
      rule: weekly('2027-01-04', ['mo'], '10:00'),
      rerun: { strategy: 'episode', episodeId: null },
    });
    expect(slot.rerun).toEqual({ strategy: 'episode', episodeId: null });
    // The latest one airs until then.
    const res = await occurrences(s.id, '2027-01-04T00:00:00Z', '2027-01-05T00:00:00Z');
    expect(res.occurrences.find((o) => o.slotId === slot.id)?.rerunOf?.id).toBe(ep.id);
  });

  it('never airs a chosen episode before it has aired: the latest aired one airs instead', async () => {
    const s = await newShow('Too early');
    const premieres = await newSlot(s.id, {
      type: 'prerecorded',
      rule: weekly('2027-01-04', ['mo'], '20:00'),
    });
    const old = await newEpisode(s.id, { airedAt: longAgo });
    const later = await newEpisode(s.id, { slotId: premieres.id, occurrenceDate: '2027-01-11' });
    const neverAired = await newEpisode(s.id);
    const before = await newSlot(s.id, {
      type: 'rerun',
      rule: { freq: 'once', date: '2027-01-06', time: '10:00' },
      rerun: { strategy: 'episode', episodeId: later.id },
    });
    const after = await newSlot(s.id, {
      type: 'rerun',
      rule: { freq: 'once', date: '2027-01-13', time: '10:00' },
      rerun: { strategy: 'episode', episodeId: later.id },
    });
    const unscheduled = await newSlot(s.id, {
      type: 'rerun',
      rule: { freq: 'once', date: '2027-01-13', time: '12:00' },
      rerun: { strategy: 'episode', episodeId: neverAired.id },
    });
    const res = await occurrences(s.id, '2027-01-06T00:00:00Z', '2027-01-14T00:00:00Z');
    const of = (slotId: string) => res.occurrences.find((o) => o.slotId === slotId)?.rerunOf?.id;
    expect(of(before.id)).toBe(old.id);
    expect(of(after.id)).toBe(later.id);
    // A never-aired choice: the latest aired one by then (`later` premiered on the 11th).
    expect(of(unscheduled.id)).toBe(later.id);
  });

  it('reruns the latest episode that already went out, or the chosen one', async () => {
    const s = await newShow('Resolve');
    const premieres = await newSlot(s.id, {
      type: 'prerecorded',
      rule: weekly('2027-01-04', ['mo'], '20:00'),
    });
    const ep1 = await newEpisode(s.id, { slotId: premieres.id, occurrenceDate: '2027-01-04' });
    const ep2 = await newEpisode(s.id, { slotId: premieres.id, occurrenceDate: '2027-01-11' });
    // No audio, or never aired (unscheduled): never rerun.
    await newEpisode(s.id, { audio: false });
    await newEpisode(s.id);
    const latest = await newSlot(s.id, {
      type: 'rerun',
      rule: weekly('2027-01-05', ['tu'], '10:00'),
    });
    const chosen = await newSlot(s.id, {
      type: 'rerun',
      rule: weekly('2027-01-06', ['we'], '10:00'),
      rerun: { strategy: 'episode', episodeId: ep1.id },
    });

    const res = await occurrences(s.id, '2027-01-04T00:00:00Z', '2027-01-14T00:00:00Z');
    const rerunOf = (slotId: string, date: string) =>
      res.occurrences.find((o) => o.slotId === slotId && o.date === date)?.rerunOf;
    // Tuesday 5th: only ep1 premiered before; ep2 (ready, the 11th) is not burned.
    expect(rerunOf(latest.id, '2027-01-05')?.number).toBe(ep1.number);
    expect(rerunOf(latest.id, '2027-01-12')?.number).toBe(ep2.number);
    expect(rerunOf(chosen.id, '2027-01-06')?.id).toBe(ep1.id);
    expect(rerunOf(chosen.id, '2027-01-13')?.id).toBe(ep1.id);
    // Other slot types carry no `rerunOf`.
    expect(res.occurrences.find((o) => o.slotId === premieres.id)).not.toHaveProperty('rerunOf');

    // The log generator's entry point agrees.
    expect(
      await resolveRerun(t.tdb.db, scope, {
        slotId: latest.id,
        occurrenceDate: '2027-01-12',
        startsAt: new Date('2027-01-12T09:00:00Z'),
      }),
    ).toEqual({ kind: 'latest_episode', episodeId: ep2.id, assetId: ep2.assetId });
    expect(
      await resolveRerun(t.tdb.db, scope, {
        slotId: premieres.id,
        occurrenceDate: '2027-01-11',
        startsAt: new Date('2027-01-11T19:00:00Z'),
      }),
    ).toBeNull();

    // The chosen episode deleted: the slot keeps its strategy and the latest airs.
    expect((await call('DELETE', `/shows/${s.id}/episodes/${ep1.id}`)).statusCode).toBe(204);
    const slots = await ok<{ items: ShowSlot[] }>(await call('GET', `/shows/${s.id}/slots`));
    expect(slots.items.find((x) => x.id === chosen.id)?.rerun).toEqual({
      strategy: 'episode',
      episodeId: null,
    });
    const after = await occurrences(s.id, '2027-01-13T00:00:00Z', '2027-01-14T00:00:00Z');
    expect(after.occurrences.find((o) => o.slotId === chosen.id)?.rerunOf?.id).toBe(ep2.id);
  });

  it('has nothing to rerun before any episode went out', async () => {
    const s = await newShow('Empty');
    const slot = await newSlot(s.id, {
      type: 'rerun',
      rule: weekly('2027-01-04', ['mo'], '10:00'),
    });
    const res = await occurrences(s.id, '2027-01-04T00:00:00Z', '2027-01-05T00:00:00Z');
    expect(res.occurrences.find((o) => o.slotId === slot.id)?.rerunOf).toBeNull();
  });

  it('airs a 02:30 rerun after the March gap and at the first 02:30 in October', async () => {
    const s = await newShow('Night');
    await newEpisode(s.id, { airedAt: longAgo });
    const slot = await newSlot(s.id, {
      type: 'rerun',
      rule: weekly('2027-03-01', ['su'], '02:30'),
    });
    const march = await occurrences(s.id, '2027-03-27T00:00:00Z', '2027-03-29T00:00:00Z');
    const m = march.occurrences.find((o) => o.slotId === slot.id && o.date === '2027-03-28');
    // 02:30 doesn't exist on 28 March 2027: it airs at 03:30 CEST (01:30Z).
    expect(m?.startsAt).toBe('2027-03-28T01:30:00.000Z');
    expect(m?.rerunOf).not.toBeNull();
    const october = await occurrences(s.id, '2027-10-30T00:00:00Z', '2027-11-01T00:00:00Z');
    const o = october.occurrences.find((x) => x.slotId === slot.id && x.date === '2027-10-31');
    // 02:30 happens twice on 31 October 2027: the first one, CEST (00:30Z).
    expect(o?.startsAt).toBe('2027-10-31T00:30:00.000Z');
    expect(o?.rerunOf).not.toBeNull();
  });
});

describe('schedule a rerun', () => {
  it('creates a one-off rerun slot on the episode, with the premiere slot’s duration', async () => {
    const s = await newShow('Action');
    const premieres = await newSlot(s.id, {
      type: 'prerecorded',
      rule: weekly('2027-02-01', ['mo'], '20:00'),
      durationMs: 90 * 60_000,
    });
    const ep = await newEpisode(s.id, { slotId: premieres.id, occurrenceDate: '2027-02-01' });
    const slot = await ok<ShowSlot>(
      await call('POST', `/shows/${s.id}/episodes/${ep.id}/reruns`, {
        date: '2027-02-06',
        time: '14:00',
      }),
      201,
    );
    expect(slot).toMatchObject({
      showId: s.id,
      type: 'rerun',
      rule: { freq: 'once', date: '2027-02-06', time: '14:00' },
      durationMs: 90 * 60_000,
      rerun: { strategy: 'episode', episodeId: ep.id },
    });
    const [audit] = await t.tdb.db.select().from(auditLog).where(eq(auditLog.entityId, slot.id));
    expect(audit?.action).toBe('show_slot.create');

    const res = await occurrences(s.id, '2027-02-06T00:00:00Z', '2027-02-07T00:00:00Z');
    const o = res.occurrences.find((x) => x.slotId === slot.id);
    expect(o?.rerunOf).toMatchObject({ id: ep.id, number: ep.number });
  });

  it('falls back to the episode audio’s length, rounded up to the minute', async () => {
    const s = await ok<Show>(await call('POST', '/shows', { name: 'No default' }), 201);
    const ep = await newEpisode(s.id, { durationMs: 59 * 60_000 + 1, airedAt: longAgo });
    const slot = await ok<ShowSlot>(
      await call('POST', `/shows/${s.id}/episodes/${ep.id}/reruns`, {
        date: '2027-02-06',
        time: '14:00',
      }),
      201,
    );
    expect(slot.durationMs).toBe(60 * 60_000);
  });

  it('refuses an episode without audio, a date before its premiere, and presenters', async () => {
    const s = await newShow('Refusals');
    const silent = await newEpisode(s.id, { audio: false });
    const noAudio = await call('POST', `/shows/${s.id}/episodes/${silent.id}/reruns`, {
      date: '2027-02-06',
      time: '14:00',
    });
    expect(noAudio.statusCode).toBe(422);
    expect(noAudio.json().error).toBe('no_audio');

    const premieres = await newSlot(s.id, {
      type: 'prerecorded',
      rule: weekly('2027-02-01', ['mo'], '20:00'),
    });
    const ep = await newEpisode(s.id, { slotId: premieres.id, occurrenceDate: '2027-02-08' });
    const early = await call('POST', `/shows/${s.id}/episodes/${ep.id}/reruns`, {
      date: '2027-02-06',
      time: '14:00',
    });
    expect(early.statusCode).toBe(422);
    expect(early.json().error).toBe('before_premiere');

    const presenter = await call(
      'POST',
      `/shows/${s.id}/episodes/${ep.id}/reruns`,
      { date: '2027-02-10', time: '14:00' },
      'presenter',
    );
    expect(presenter.statusCode).toBe(403);

    // Never aired: unscheduled, or marked aired only after the rerun would start.
    const unscheduled = await newEpisode(s.id);
    const notAired = await call('POST', `/shows/${s.id}/episodes/${unscheduled.id}/reruns`, {
      date: '2027-02-10',
      time: '14:00',
    });
    expect(notAired.statusCode).toBe(422);
    expect(notAired.json().error).toBe('not_aired');
    const airsLater = await newEpisode(s.id, { airedAt: '2027-02-10T15:00:00Z' });
    const sameDay = await call('POST', `/shows/${s.id}/episodes/${airsLater.id}/reruns`, {
      date: '2027-02-10',
      time: '14:00',
    });
    expect(sameDay.json().error).toBe('not_aired');
    // 17:00 in Paris is after 15:00Z: fine.
    expect(
      (
        await call('POST', `/shows/${s.id}/episodes/${airsLater.id}/reruns`, {
          date: '2027-02-10',
          time: '17:00',
        })
      ).statusCode,
    ).toBe(201);

    const unknown = await call('POST', `/shows/${s.id}/episodes/${randomUUID()}/reruns`, {
      date: '2027-02-10',
      time: '14:00',
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('now playing', () => {
  async function itemFor(
    episodeId: string,
    assetId: string,
    originShowSlotId: string | null,
    plannedStart: Date,
  ) {
    const [day] = await t.tdb.db
      .insert(logDay)
      .values({
        orgId: scope.orgId,
        stationId: scope.stationId,
        localDate: plannedStart.toISOString().slice(0, 10),
        startsAt: new Date(plannedStart.getTime() - H),
        endsAt: new Date(plannedStart.getTime() + 23 * H),
      })
      .returning();
    if (!day) throw new Error('no day');
    const [item] = await t.tdb.db
      .insert(logItem)
      .values({
        orgId: scope.orgId,
        stationId: scope.stationId,
        logDayId: day.id,
        position: 0,
        kind: 'episode',
        plannedStart,
        plannedDurationMs: 2 * H,
        assetId,
        episodeId,
        originType: originShowSlotId ? 'show' : 'manual',
        originShowSlotId,
      })
      .returning({ id: logItem.id });
    if (!item) throw new Error('no item');
    return item.id;
  }

  async function airs(itemId: string, at: Date) {
    const recorded = await asrun.recordStart(t.tdb.db, scope, {
      eventId: randomUUID(),
      bootId: 'boot',
      seq: Math.floor(Math.random() * 1e9) + 1,
      at,
      itemId,
      segmentId: null,
      source: 'queue',
      title: null,
      artist: null,
      filename: null,
      rid: null,
    });
    if (!recorded) throw new Error('not recorded');
    return recorded.entry;
  }

  it('marks an unscheduled episode aired on its first airing, and a rerun after', async () => {
    const s = await newShow('By hand');
    const ep = await newEpisode(s.id);
    const first = await airs(
      await itemFor(ep.id, ep.assetId as string, null, new Date('2027-05-01T10:00:00Z')),
      new Date('2027-05-01T10:00:00Z'),
    );
    expect(first.episode?.rerun).toBe(false);
    const aired = await ok<Episode>(await call('GET', `/shows/${s.id}/episodes/${ep.id}`));
    expect(aired.status).toBe('aired');
    expect(new Date(aired.airedAt as unknown as string).toISOString()).toBe(
      '2027-05-01T10:00:00.000Z',
    );
    const again = await airs(
      await itemFor(ep.id, ep.assetId as string, null, new Date('2027-05-08T10:00:00Z')),
      new Date('2027-05-08T10:00:00Z'),
    );
    expect(again.episode?.rerun).toBe(true);
    // The first airing stays the episode's.
    const still = await ok<Episode>(await call('GET', `/shows/${s.id}/episodes/${ep.id}`));
    expect(new Date(still.airedAt as unknown as string).toISOString()).toBe(
      '2027-05-01T10:00:00.000Z',
    );
  });

  it('shows the original episode number and the rerun flag', async () => {
    const s = await newShow('Now playing');
    const premieres = await newSlot(s.id, {
      type: 'prerecorded',
      rule: weekly('2027-04-05', ['mo'], '20:00'),
    });
    const ep = await newEpisode(s.id, { slotId: premieres.id, occurrenceDate: '2027-04-05' });
    const rerunSlot = await ok<ShowSlot>(
      await call('POST', `/shows/${s.id}/episodes/${ep.id}/reruns`, {
        date: '2027-04-07',
        time: '10:00',
      }),
      201,
    );

    const premiere = await airs(
      await itemFor(ep.id, ep.assetId as string, premieres.id, new Date('2027-04-05T18:00:00Z')),
      new Date('2027-04-05T18:00:00Z'),
    );
    expect(premiere.episode).toEqual({
      id: ep.id,
      showId: s.id,
      number: ep.number,
      rerun: false,
    });

    const rerun = await airs(
      await itemFor(ep.id, ep.assetId as string, rerunSlot.id, new Date('2027-04-07T08:00:00Z')),
      new Date('2027-04-07T08:00:00Z'),
    );
    expect(rerun.episode).toEqual({ id: ep.id, showId: s.id, number: ep.number, rerun: true });

    // Now playing: the newest as-run entry, through the api.
    const list = await ok<AsRunList>(
      await call(
        'GET',
        '/asrun?from=2027-04-07T00:00:00Z&to=2027-04-08T00:00:00Z&order=desc&limit=1',
      ),
    );
    expect(list.items[0]?.episode).toEqual({
      id: ep.id,
      showId: s.id,
      number: ep.number,
      rerun: true,
    });
  });
});
