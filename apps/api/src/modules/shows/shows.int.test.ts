import {
  addMembership,
  auditLog,
  createAsset,
  createOrganization,
  createStation,
  resolveOrgScope,
  resolveStationScope,
} from '@ondes/db';
import type {
  Actor,
  Episode,
  Show,
  ShowOccurrencesResponse,
  ShowSlot,
  StationRole,
} from '@ondes/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, signUpAndLogin, type TestApp } from '../auth/testing.ts';

// The shows API on the real app: permissions (write vs write_own for hosts), tenant isolation,
// audit rows, episode numbering, exceptions and occurrences across the March DST change.

const system: Actor = { type: 'system', name: 'test' };
const H = 3600 * 1000;

let t: TestApp;
let stationId: string;
let otherStationId: string;
let episodeAsset: string;
let songAsset: string;
let otherEpisodeAsset: string;
const users: Record<string, { userId: string; cookie: string }> = {};
type Who = 'programmer' | 'host' | 'presenter' | 'viewer' | 'outsider';

beforeAll(async () => {
  t = await createTestApp();
  const db = t.tdb.db;
  const org = await createOrganization(db, system, { slug: 'shows-org', name: 'Org' });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: 'shows-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  stationId = st.id;
  const scope = await resolveStationScope(db, org.id, st.id);
  episodeAsset = (
    await createAsset(db, { actor: system, scope }, { type: 'episode', title: 'Ep audio' })
  ).id;
  songAsset = (await createAsset(db, { actor: system, scope }, { type: 'song', title: 'Song' })).id;

  const other = await createOrganization(db, system, { slug: 'shows-other', name: 'Other' });
  const otherOrgScope = await resolveOrgScope(db, other.id);
  const ost = await createStation(
    db,
    { actor: system, scope: otherOrgScope },
    { slug: 'shows-other-fm', name: 'Other FM', timezone: 'Europe/Paris' },
  );
  otherStationId = ost.id;
  const otherScope = await resolveStationScope(db, other.id, ost.id);
  otherEpisodeAsset = (
    await createAsset(db, { actor: system, scope: otherScope }, { type: 'episode', title: 'X' })
  ).id;

  const roles: [Who, StationRole][] = [
    ['programmer', 'programmer'],
    ['host', 'presenter'],
    ['presenter', 'presenter'],
    ['viewer', 'viewer'],
  ];
  for (const [who, role] of roles) {
    users[who] = await signUpAndLogin(t, `${who}@shows.test`);
    await addMembership(
      db,
      { actor: system, scope: orgScope },
      { level: 'station', stationId, userId: users[who].userId, role },
    );
  }
  // Owner of the other org: signed in, but not a member here.
  users.outsider = await signUpAndLogin(t, 'outsider@shows.test');
  await addMembership(
    db,
    { actor: system, scope: otherOrgScope },
    { level: 'org', userId: users.outsider.userId, role: 'owner' },
  );
}, 60_000);

afterAll(() => t?.close());

function call(
  who: Who,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  station = stationId,
) {
  return t.app.inject({
    method,
    url: `/api/v1/stations/${station}${url}`,
    cookies: { ondes_session: users[who]?.cookie ?? '' },
    ...(payload ? { payload } : {}),
  });
}

async function ok<T>(res: Awaited<ReturnType<typeof call>>, status = 200): Promise<T> {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as T;
}

async function audits(entityId: string) {
  return t.tdb.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.entityId, entityId))
    .orderBy(asc(auditLog.at));
}

async function newShow(name: string, extra: object = {}): Promise<Show> {
  return ok<Show>(
    await call('programmer', 'POST', '/shows', {
      name,
      defaultDurationMs: 2 * H,
      hostUserIds: [users.host?.userId],
      ...extra,
    }),
    201,
  );
}

describe('shows', () => {
  it('creates a show with hosts, audited', async () => {
    const created = await newShow('Matinale', {
      description: 'Le réveil',
      artworkUrl: 'https://cdn.example/matinale.png',
      colour: '#1E90FF',
      tags: ['talk', 'talk', 'news'],
    });
    expect(created).toMatchObject({
      name: 'Matinale',
      colour: '#1e90ff',
      tags: ['talk', 'news'],
      defaultSlotType: 'prerecorded',
      hosts: [{ userId: users.host?.userId, name: 'host' }],
      nextEpisodeNumber: 1,
    });
    const [audit] = await audits(created.id);
    expect(audit).toMatchObject({ action: 'show.create', stationId, actorType: 'user' });
    expect(audit?.diff).toMatchObject({ name: { from: null, to: 'Matinale' } });

    const list = await ok<{ items: Show[] }>(await call('viewer', 'GET', '/shows'));
    expect(list.items.map((s) => s.id)).toContain(created.id);
  });

  it('refuses hosts who are not members of the station, and an http artwork url', async () => {
    const res = await call('programmer', 'POST', '/shows', {
      name: 'X',
      hostUserIds: [users.outsider?.userId],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('invalid_host');
    const http = await call('programmer', 'POST', '/shows', {
      name: 'X',
      artworkUrl: 'http://cdn.example/a.png',
    });
    expect(http.statusCode).toBe(400);
  });

  it('lets a host edit their show, but not its hosts; other presenters and viewers not at all', async () => {
    const s = await newShow('Host edits');
    const renamed = await ok<Show>(
      await call('host', 'PATCH', `/shows/${s.id}`, { description: 'by the host' }),
    );
    expect(renamed.description).toBe('by the host');
    expect((await call('host', 'PATCH', `/shows/${s.id}`, { hostUserIds: [] })).statusCode).toBe(
      403,
    );
    expect(
      (await call('presenter', 'PATCH', `/shows/${s.id}`, { description: 'x' })).statusCode,
    ).toBe(403);
    expect((await call('viewer', 'PATCH', `/shows/${s.id}`, { name: 'x' })).statusCode).toBe(403);
    expect((await call('host', 'POST', '/shows', { name: 'Mine' })).statusCode).toBe(403);
    expect((await call('host', 'DELETE', `/shows/${s.id}`)).statusCode).toBe(403);

    const updated = await ok<Show>(
      await call('programmer', 'PATCH', `/shows/${s.id}`, {
        hostUserIds: [users.presenter?.userId],
      }),
    );
    expect(updated.hosts.map((h) => h.userId)).toEqual([users.presenter?.userId]);
    const audit = (await audits(s.id)).at(-1);
    expect(audit?.action).toBe('show.update');
    expect(audit?.diff).toEqual({
      hostUserIds: { from: [users.host?.userId], to: [users.presenter?.userId] },
    });
  });

  it('keeps shows inside their tenant', async () => {
    const s = await newShow('Private');
    expect((await call('outsider', 'GET', `/shows/${s.id}`)).statusCode).toBe(404);
    expect((await call('outsider', 'GET', '/shows')).statusCode).toBe(404);
    // The outsider owns the other station; this show isn't there.
    expect(
      (await call('outsider', 'GET', `/shows/${s.id}`, undefined, otherStationId)).statusCode,
    ).toBe(404);
    expect(
      (await call('outsider', 'PATCH', `/shows/${s.id}`, { name: 'x' }, otherStationId)).statusCode,
    ).toBe(404);
    expect(
      (await call('outsider', 'GET', `/shows/${s.id}/episodes`, undefined, otherStationId))
        .statusCode,
    ).toBe(404);
  });

  it('deletes a show with its slots and episodes, audited', async () => {
    const s = await newShow('Short-lived');
    const slot = await ok<ShowSlot>(
      await call('programmer', 'POST', `/shows/${s.id}/slots`, {
        rule: { freq: 'once', date: '2026-06-01', time: '10:00' },
      }),
      201,
    );
    await ok<Episode>(await call('programmer', 'POST', `/shows/${s.id}/episodes`, {}), 201);
    expect((await call('programmer', 'DELETE', `/shows/${s.id}`)).statusCode).toBe(204);
    expect((await call('programmer', 'GET', `/shows/${s.id}`)).statusCode).toBe(404);
    expect((await call('programmer', 'GET', `/shows/${s.id}/slots/${slot.id}`)).statusCode).toBe(
      404,
    );
    expect((await audits(s.id)).at(-1)?.action).toBe('show.delete');
  });
});

describe('slots and exceptions', () => {
  let s: Show;
  let slot: ShowSlot;

  beforeAll(async () => {
    s = await newShow('Nuit blanche');
  });

  it('creates a weekly slot with the show defaults, programmers only', async () => {
    const rule = {
      freq: 'weekly',
      startDate: '2026-03-01',
      until: null,
      interval: 1,
      byDay: ['su'],
      time: '02:30',
    };
    expect((await call('host', 'POST', `/shows/${s.id}/slots`, { rule })).statusCode).toBe(403);
    slot = await ok<ShowSlot>(
      await call('programmer', 'POST', `/shows/${s.id}/slots`, { rule }),
      201,
    );
    expect(slot).toMatchObject({ type: 'prerecorded', durationMs: 2 * H, rule, exceptions: [] });
    expect((await audits(slot.id))[0]?.action).toBe('show_slot.create');
  });

  it('refuses a slot without a duration when the show has none, and invalid rules', async () => {
    const bare = await ok<Show>(await call('programmer', 'POST', '/shows', { name: 'Bare' }), 201);
    const once = { freq: 'once', date: '2026-06-01', time: '10:00' };
    const res = await call('programmer', 'POST', `/shows/${bare.id}/slots`, { rule: once });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('duration_required');
    for (const rule of [
      { ...once, time: '24:00' },
      {
        freq: 'weekly',
        startDate: '2026-03-01',
        until: '2026-02-01',
        interval: 1,
        byDay: ['mo'],
        time: '10:00',
      },
      {
        freq: 'weekly',
        startDate: '2026-03-01',
        until: null,
        interval: 0,
        byDay: ['mo'],
        time: '10:00',
      },
      {
        freq: 'weekly',
        startDate: '2026-03-01',
        until: null,
        interval: 1,
        byDay: [],
        time: '10:00',
      },
    ]) {
      const bad = await call('programmer', 'POST', `/shows/${bare.id}/slots`, {
        rule,
        durationMs: H,
      });
      expect(bad.statusCode, JSON.stringify(rule)).toBe(400);
    }
  });

  it('expands across the spring-forward night: 02:30 airs at 03:30 CEST', async () => {
    const res = await ok<ShowOccurrencesResponse>(
      await call(
        'viewer',
        'GET',
        `/show-occurrences?from=2026-03-21T00:00:00Z&to=2026-04-06T00:00:00Z&showId=${s.id}`,
      ),
    );
    expect(res.timezone).toBe('Europe/Paris');
    expect(res.occurrences.map((o) => [o.date, o.startsAt, o.endsAt])).toEqual([
      ['2026-03-22', '2026-03-22T01:30:00.000Z', '2026-03-22T03:30:00.000Z'],
      ['2026-03-29', '2026-03-29T01:30:00.000Z', '2026-03-29T03:30:00.000Z'],
      ['2026-04-05', '2026-04-05T00:30:00.000Z', '2026-04-05T02:30:00.000Z'],
    ]);
    expect(res.occurrences[0]).toMatchObject({
      slotId: slot.id,
      show: { id: s.id, name: 'Nuit blanche' },
      type: 'prerecorded',
      moved: false,
      episode: null,
    });
  });

  it('cancels and moves single occurrences, audited, and refuses non-occurrences', async () => {
    await ok<ShowSlot>(
      await call('programmer', 'PUT', `/shows/${s.id}/slots/${slot.id}/exceptions/2026-03-22`, {
        kind: 'cancelled',
      }),
    );
    const moved = await ok<ShowSlot>(
      await call('programmer', 'PUT', `/shows/${s.id}/slots/${slot.id}/exceptions/2026-03-29`, {
        kind: 'moved',
        startDate: '2026-03-28',
        startTime: '22:00',
        durationMs: H,
      }),
    );
    expect(moved.exceptions).toEqual([
      { date: '2026-03-22', kind: 'cancelled' },
      {
        date: '2026-03-29',
        kind: 'moved',
        startDate: '2026-03-28',
        startTime: '22:00',
        durationMs: H,
      },
    ]);
    const res = await ok<ShowOccurrencesResponse>(
      await call(
        'viewer',
        'GET',
        `/show-occurrences?from=2026-03-21T00:00:00Z&to=2026-04-01T00:00:00Z&showId=${s.id}`,
      ),
    );
    expect(res.occurrences.map((o) => [o.date, o.startsAt, o.durationMs, o.moved])).toEqual([
      ['2026-03-29', '2026-03-28T21:00:00.000Z', H, true],
    ]);

    const notOne = await call(
      'programmer',
      'PUT',
      `/shows/${s.id}/slots/${slot.id}/exceptions/2026-03-23`,
      { kind: 'cancelled' },
    );
    expect(notOne.statusCode).toBe(422);
    expect(notOne.json().error).toBe('not_an_occurrence');
    const far = await call(
      'programmer',
      'PUT',
      `/shows/${s.id}/slots/${slot.id}/exceptions/2026-04-05`,
      { kind: 'moved', startDate: '2026-04-20', startTime: '10:00' },
    );
    expect(far.statusCode).toBe(422);
    expect(far.json().error).toBe('move_too_far');

    const restored = await ok<ShowSlot>(
      await call('programmer', 'DELETE', `/shows/${s.id}/slots/${slot.id}/exceptions/2026-03-22`),
    );
    expect(restored.exceptions.map((e) => e.date)).toEqual(['2026-03-29']);
    expect(
      (await call('programmer', 'DELETE', `/shows/${s.id}/slots/${slot.id}/exceptions/2026-03-22`))
        .statusCode,
    ).toBe(404);
    expect((await audits(slot.id)).map((a) => a.action)).toEqual([
      'show_slot.create',
      'show_slot.exception.put',
      'show_slot.exception.put',
      'show_slot.exception.delete',
    ]);
  });

  it('drops exceptions the new rule no longer has when the rule changes', async () => {
    const updated = await ok<ShowSlot>(
      await call('programmer', 'PATCH', `/shows/${s.id}/slots/${slot.id}`, {
        rule: { ...slot.rule, byDay: ['sa'] },
      }),
    );
    expect(updated.exceptions).toEqual([]);
    expect((await audits(slot.id)).at(-1)?.action).toBe('show_slot.update');
  });

  it('reports conflicts between overlapping slots', async () => {
    const a = await newShow('Conflict A');
    const b = await newShow('Conflict B');
    const sa = await ok<ShowSlot>(
      await call('programmer', 'POST', `/shows/${a.id}/slots`, {
        rule: { freq: 'once', date: '2026-07-01', time: '20:00' },
      }),
      201,
    );
    const sb = await ok<ShowSlot>(
      await call('programmer', 'POST', `/shows/${b.id}/slots`, {
        rule: { freq: 'once', date: '2026-07-01', time: '21:00' },
        durationMs: H,
      }),
      201,
    );
    const res = await ok<ShowOccurrencesResponse>(
      await call(
        'viewer',
        'GET',
        '/show-occurrences?from=2026-07-01T00:00:00Z&to=2026-07-02T00:00:00Z',
      ),
    );
    expect(res.conflicts).toEqual([
      {
        a: { slotId: sa.id, date: '2026-07-01' },
        b: { slotId: sb.id, date: '2026-07-01' },
        startsAt: '2026-07-01T19:00:00.000Z',
        endsAt: '2026-07-01T20:00:00.000Z',
        overlapMs: H,
      },
    ]);
  });

  it('refuses ranges over 92 days and other tenants', async () => {
    expect(
      (
        await call(
          'viewer',
          'GET',
          '/show-occurrences?from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z',
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(
          'outsider',
          'GET',
          '/show-occurrences?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z',
        )
      ).statusCode,
    ).toBe(404);
    // The other station's occurrences don't include this station's slots.
    const other = await ok<ShowOccurrencesResponse>(
      await call(
        'outsider',
        'GET',
        '/show-occurrences?from=2026-03-21T00:00:00Z&to=2026-04-06T00:00:00Z',
        undefined,
        otherStationId,
      ),
    );
    expect(other.occurrences).toEqual([]);
  });
});

describe('episodes', () => {
  let s: Show;
  let slot: ShowSlot;
  let live: ShowSlot;

  beforeAll(async () => {
    s = await newShow('Vandale Mix');
    slot = await ok<ShowSlot>(
      await call('programmer', 'POST', `/shows/${s.id}/slots`, {
        rule: {
          freq: 'weekly',
          startDate: '2026-09-07',
          until: null,
          interval: 2,
          byDay: ['mo'],
          time: '20:00',
        },
      }),
      201,
    );
    live = await ok<ShowSlot>(
      await call('programmer', 'POST', `/shows/${s.id}/slots`, {
        type: 'live',
        rule: { freq: 'once', date: '2026-09-10', time: '18:00' },
      }),
      201,
    );
  });

  it('numbers episodes per show, live and pre-recorded alike', async () => {
    const first = await ok<Episode>(
      await call('host', 'POST', `/shows/${s.id}/episodes`, { title: 'Pilot' }),
      201,
    );
    expect(first).toMatchObject({
      number: 1,
      kind: 'prerecorded',
      status: 'planned',
      assetId: null,
    });
    const second = await ok<Episode>(
      await call('programmer', 'POST', `/shows/${s.id}/episodes`, {
        slotId: live.id,
        occurrenceDate: '2026-09-10',
      }),
      201,
    );
    expect(second).toMatchObject({ number: 2, kind: 'live', slotId: live.id });
    // An explicit number (catching up with history) moves the counter.
    const jump = await ok<Episode>(
      await call('programmer', 'POST', `/shows/${s.id}/episodes`, { number: 120 }),
      201,
    );
    expect(jump.number).toBe(120);
    expect((await ok<Show>(await call('viewer', 'GET', `/shows/${s.id}`))).nextEpisodeNumber).toBe(
      121,
    );
    const taken = await call('programmer', 'POST', `/shows/${s.id}/episodes`, { number: 2 });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe('episode_number_taken');
    const renumber = await call('programmer', 'PATCH', `/shows/${s.id}/episodes/${first.id}`, {
      number: 120,
    });
    expect(renumber.statusCode).toBe(409);
    expect((await audits(first.id))[0]?.action).toBe('episode.create');
  });

  it('numbers concurrent creations one after the other', async () => {
    const parallel = await newShow('Parallel');
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        call('programmer', 'POST', `/shows/${parallel.id}/episodes`, {}),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
    expect(results.map((r) => (r.json() as Episode).number).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('attaches an episode asset (ready) and refuses other assets', async () => {
    const e = await ok<Episode>(
      await call('host', 'POST', `/shows/${s.id}/episodes`, {
        slotId: slot.id,
        occurrenceDate: '2026-09-21',
      }),
      201,
    );
    expect(e.status).toBe('planned');
    const ready = await ok<Episode>(
      await call('host', 'PATCH', `/shows/${s.id}/episodes/${e.id}`, { assetId: episodeAsset }),
    );
    expect(ready).toMatchObject({ assetId: episodeAsset, status: 'ready' });
    const back = await ok<Episode>(
      await call('host', 'PATCH', `/shows/${s.id}/episodes/${e.id}`, { assetId: null }),
    );
    expect(back.status).toBe('planned');
    for (const [assetId, error] of [
      [songAsset, 'invalid_asset'],
      [otherEpisodeAsset, 'unknown_asset'],
    ] as const) {
      const res = await call('host', 'PATCH', `/shows/${s.id}/episodes/${e.id}`, { assetId });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe(error);
    }
    const aired = await ok<Episode>(
      await call('programmer', 'PATCH', `/shows/${s.id}/episodes/${e.id}`, {
        status: 'aired',
        airedAt: '2026-09-21T18:00:00.000Z',
      }),
    );
    expect(aired).toMatchObject({ status: 'aired', airedAt: '2026-09-21T18:00:00.000Z' });
  });

  it('links episodes to real occurrences only, one per occurrence', async () => {
    // Every other Monday from 7 Sep: the 14th is an off week.
    const off = await call('programmer', 'POST', `/shows/${s.id}/episodes`, {
      slotId: slot.id,
      occurrenceDate: '2026-09-14',
    });
    expect(off.statusCode).toBe(422);
    expect(off.json().error).toBe('not_an_occurrence');
    const twice = await call('programmer', 'POST', `/shows/${s.id}/episodes`, {
      slotId: slot.id,
      occurrenceDate: '2026-09-21',
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error).toBe('occurrence_taken');
    const half = await call('programmer', 'POST', `/shows/${s.id}/episodes`, { slotId: slot.id });
    expect(half.statusCode).toBe(400);
    const other = await newShow('Not this one');
    const foreign = await call('programmer', 'POST', `/shows/${other.id}/episodes`, {
      slotId: slot.id,
      occurrenceDate: '2026-10-05',
    });
    expect(foreign.statusCode).toBe(422);
    expect(foreign.json().error).toBe('unknown_slot');
  });

  it('shows the planned episode on its occurrence', async () => {
    const res = await ok<ShowOccurrencesResponse>(
      await call(
        'viewer',
        'GET',
        `/show-occurrences?from=2026-09-20T00:00:00Z&to=2026-09-22T00:00:00Z&showId=${s.id}`,
      ),
    );
    expect(res.occurrences).toHaveLength(1);
    expect(res.occurrences[0]).toMatchObject({
      date: '2026-09-21',
      startsAt: '2026-09-21T18:00:00.000Z',
      episode: { status: 'aired' },
    });
  });

  it('lets only hosts and programmers write episodes', async () => {
    expect((await call('presenter', 'POST', `/shows/${s.id}/episodes`, {})).statusCode).toBe(403);
    expect((await call('viewer', 'POST', `/shows/${s.id}/episodes`, {})).statusCode).toBe(403);
    const list = await ok<{ items: Episode[] }>(
      await call('viewer', 'GET', `/shows/${s.id}/episodes?status=aired`),
    );
    expect(list.items.map((e) => e.status)).toEqual(['aired']);
  });

  it('keeps episodes when their slot is deleted, and deletes them on request', async () => {
    const res = await ok<{ items: Episode[] }>(
      await call('viewer', 'GET', `/shows/${s.id}/episodes`),
    );
    const linked = res.items.find((e) => e.slotId === live.id);
    expect((await call('programmer', 'DELETE', `/shows/${s.id}/slots/${live.id}`)).statusCode).toBe(
      204,
    );
    const after = await ok<Episode>(
      await call('viewer', 'GET', `/shows/${s.id}/episodes/${linked?.id}`),
    );
    expect(after).toMatchObject({ slotId: null, occurrenceDate: '2026-09-10' });
    expect((await call('host', 'DELETE', `/shows/${s.id}/episodes/${after.id}`)).statusCode).toBe(
      204,
    );
    const rows = await t.tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, after.id), eq(auditLog.action, 'episode.delete')));
    expect(rows).toHaveLength(1);
  });
});
