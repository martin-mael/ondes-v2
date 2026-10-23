import { randomUUID } from 'node:crypto';
import {
  addMembership,
  alert,
  auditLog,
  createAsset,
  createOrganization,
  createStation,
  episodeCheck,
  logItem,
  logItemFallback,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
} from '@ondes/db';
import {
  type Actor,
  alertTypes,
  type Episode,
  type EpisodeCheckStep,
  type LogEditResult,
  localDateOf,
  type Show,
  type ShowSlot,
  zonedParts,
} from '@ondes/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runEpisodeCheck } from '../../../../../worker/src/jobs/episode-check/check.ts';
import * as asrun from '../../asrun/repo.ts';
import { createTestApp, signUpAndLogin, type TestApp } from '../../auth/testing.ts';
import { createEpisodeCheckService } from './service.ts';

// Missing-episode alerts and fallbacks (#47) on the real app. Most tests insert the steps the
// worker records in `episode_check` directly; the last one runs the worker's pass end to end.
// Real time: the log refuses to edit what already aired, so the occurrence is 40 min ahead.

const system: Actor = { type: 'system', name: 'test' };
const MIN = 60_000;

let t: TestApp;
let scope: StationScope;
let stationId: string;
const users: Record<'programmer' | 'host' | 'viewer', { userId: string; cookie: string }> =
  {} as never;

beforeAll(async () => {
  t = await createTestApp();
  const db = t.tdb.db;
  const org = await createOrganization(db, system, { slug: 'ep-check', name: 'Org' });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: 'ep-check-fm', name: 'Vandale', timezone: 'Europe/Paris' },
  );
  stationId = st.id;
  scope = await resolveStationScope(db, org.id, st.id);
  const roles = [
    ['programmer', 'programmer'],
    ['host', 'presenter'],
    ['viewer', 'viewer'],
  ] as const;
  for (const [who, role] of roles) {
    users[who] = await signUpAndLogin(t, `${who}@ep-check.test`);
    await addMembership(
      db,
      { actor: system, scope: orgScope },
      { level: 'station', stationId, userId: users[who].userId, role },
    );
  }
}, 60_000);

afterAll(() => t?.close());

async function api<T>(method: string, url: string, payload?: object, status = 200): Promise<T> {
  const res = await t.app.inject({
    method: method as 'GET',
    url: `/api/v1/stations/${stationId}${url}`,
    cookies: { ondes_session: users.programmer.cookie },
    ...(payload ? { payload } : {}),
  });
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as T;
}

const audio = async (title: string) =>
  (await createAsset(t.tdb.db, { actor: system, scope }, { type: 'episode', title })).id;

/** A show with one pre-recorded slot `minutesAhead` from now, its premiere without audio. */
async function plan(name: string, minutesAhead: number, fallbackPolicy = 'latest_episode') {
  const show = await api<Show>(
    'POST',
    '/shows',
    {
      name,
      hostUserIds: [users.host.userId],
      fallbackPolicy,
    },
    201,
  );
  const startsAt = new Date(Math.ceil((Date.now() + minutesAhead * MIN) / MIN) * MIN);
  const local = zonedParts(startsAt, 'Europe/Paris');
  const slot = await api<ShowSlot>(
    'POST',
    `/shows/${show.id}/slots`,
    { type: 'prerecorded', rule: { freq: 'once', ...local }, durationMs: 60 * MIN },
    201,
  );
  const date = localDateOf(startsAt, 'Europe/Paris');
  const premiere = await api<Episode>(
    'POST',
    `/shows/${show.id}/episodes`,
    { slotId: slot.id, occurrenceDate: date },
    201,
  );
  return { show, slot, date, startsAt, premiere };
}

type Planned = Awaited<ReturnType<typeof plan>>;

/** What the worker records when a step is due. */
async function due(p: Planned, step: EpisodeCheckStep) {
  await t.tdb.db.insert(episodeCheck).values({
    orgId: scope.orgId,
    stationId,
    showId: p.show.id,
    slotId: p.slot.id,
    occurrenceDate: p.date,
    step,
    startsAt: p.startsAt,
    endsAt: new Date(p.startsAt.getTime() + 60 * MIN),
    episodeId: p.premiere.id,
  });
}

/** The occurrence's item in the log as the generator (#50) leaves an empty slot: no audio. */
async function emptySlotItem(p: Planned) {
  const placeholder = await audio(`${p.show.name} placeholder`);
  const { item } = await api<LogEditResult>(
    'POST',
    '/log/items',
    {
      placement: { localDate: p.date },
      item: {
        kind: 'episode',
        assetId: placeholder,
        episodeId: p.premiere.id,
        plannedDurationMs: 60 * MIN,
        timing: 'hard',
        anchorAt: p.startsAt.toISOString(),
      },
    },
    201,
  );
  if (!item) throw new Error('no item');
  await t.tdb.db.update(logItem).set({ assetId: null }).where(eq(logItem.id, item.id));
  return item.id;
}

async function openAlert(p: Planned) {
  const [row] = await t.tdb.db
    .select()
    .from(alert)
    .where(
      and(
        eq(alert.stationId, stationId),
        eq(alert.dedupeKey, `${alertTypes.episodeMissing}:${p.slot.id}:${p.date}`),
      ),
    );
  return row;
}

const mailsTo = (email: string) => t.outbox.filter((m) => m.to === email);

let seq = 1000;
/** The engine says `itemId` went on air: the as-run entry it records. */
async function airs(itemId: string, at: Date) {
  const recorded = await asrun.recordStart(t.tdb.db, scope, {
    eventId: randomUUID(),
    bootId: 'boot-ep',
    seq: seq++,
    at,
    itemId,
    segmentId: null,
    source: 'queue',
    title: null,
    artist: null,
    filename: null,
    rid: String(seq),
  });
  if (!recorded) throw new Error('not recorded');
  return recorded.entry;
}

async function stepOf(p: Planned, step: EpisodeCheckStep) {
  const [row] = await t.tdb.db
    .select()
    .from(episodeCheck)
    .where(and(eq(episodeCheck.slotId, p.slot.id), eq(episodeCheck.step, step)));
  return row;
}

/** An older, aired episode of the show with audio: what `latest_episode` reruns. */
async function airedEpisode(p: Planned, number: number) {
  const assetId = await audio(`${p.show.name} #${number}`);
  const ep = await api<Episode>(
    'POST',
    `/shows/${p.show.id}/episodes`,
    {
      number,
      assetId,
      status: 'aired',
      airedAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    },
    201,
  );
  return { episodeId: ep.id, assetId };
}

describe('missing-episode alerts', () => {
  it('alerts the dashboard and emails the hosts and programmers once per step', async () => {
    const p = await plan('Le Midi', 40);
    await due(p, 't6h');
    await t.app.episodeCheck.processPending();

    const raised = await openAlert(p);
    expect(raised).toMatchObject({ type: 'show.episode_missing', severity: 'warning' });
    expect(raised?.resolvedAt).toBeNull();
    expect(raised?.message).toContain('Le Midi airs in 6 hours');
    const hostMail = mailsTo('host@ep-check.test').filter((m) => m.subject.includes('Le Midi'));
    const progMail = mailsTo('programmer@ep-check.test').filter((m) =>
      m.subject.includes('Le Midi'),
    );
    expect(hostMail).toHaveLength(1);
    expect(progMail).toHaveLength(1);
    expect(
      mailsTo('viewer@ep-check.test').filter((m) => m.subject.includes('Le Midi')),
    ).toHaveLength(0);
    // Station time, never UTC.
    const local = zonedParts(p.startsAt, 'Europe/Paris').time;
    expect(hostMail[0]?.subject).toContain(local);
    expect(hostMail[0]?.text).toContain('the latest episode airs again');

    // A step worked off again (a retry) emails nobody twice.
    await t.tdb.db
      .update(episodeCheck)
      .set({ processedAt: null, claimedAt: null })
      .where(eq(episodeCheck.slotId, p.slot.id));
    await t.app.episodeCheck.processPending();
    expect(mailsTo('host@ep-check.test').filter((m) => m.subject.includes('Le Midi'))).toHaveLength(
      1,
    );
  });

  it('records nothing for an occurrence whose audio arrived, and resolves its alert', async () => {
    const p = await plan('Le Soir', 50);
    await due(p, 't48h');
    await t.app.episodeCheck.processPending();
    expect((await openAlert(p))?.severity).toBe('info');

    await api('PATCH', `/shows/${p.show.id}/episodes/${p.premiere.id}`, {
      assetId: await audio('Le Soir #1'),
    });
    await due(p, 't6h');
    await t.app.episodeCheck.processPending();
    const [step] = await t.tdb.db
      .select()
      .from(episodeCheck)
      .where(and(eq(episodeCheck.slotId, p.slot.id), eq(episodeCheck.step, 't6h')));
    expect(step?.result).toBe('episode_ready');

    await t.app.episodeCheck.reconcile();
    expect(await openAlert(p)).toMatchObject({ resolution: 'episode_ready' });
    expect((await openAlert(p))?.resolvedAt).not.toBeNull();
  });
});

describe('fallbacks', () => {
  it('airs the latest episode in the empty slot, and the as-run marks it', async () => {
    const p = await plan('La Matinale', 40);
    // An older episode with audio, already aired: the latest one to rerun.
    const rerunAsset = await audio('La Matinale #0');
    const old = await api<Episode>(
      'POST',
      `/shows/${p.show.id}/episodes`,
      {
        number: 50,
        assetId: rerunAsset,
        status: 'aired',
        airedAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      },
      201,
    );
    const itemId = await emptySlotItem(p);
    await due(p, 'fallback');
    await t.app.episodeCheck.processPending();

    const [item] = await t.tdb.db.select().from(logItem).where(eq(logItem.id, itemId));
    expect(item).toMatchObject({
      kind: 'episode',
      assetId: rerunAsset,
      episodeId: old.id,
      timing: 'hard',
      plannedStart: p.startsAt,
    });
    const [mark] = await t.tdb.db
      .select()
      .from(logItemFallback)
      .where(eq(logItemFallback.logItemId, itemId));
    expect(mark).toMatchObject({
      kind: 'latest_episode',
      episodeId: old.id,
      missingEpisodeId: p.premiere.id,
    });
    const audits = await t.tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, itemId), eq(auditLog.action, 'log_item.replace')));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'system', actorId: 'episode-check' });
    expect(await openAlert(p)).toMatchObject({
      severity: 'warning',
      title: 'Episode missing: La Matinale',
      details: { fallback: 'latest_episode', i18n: { key: 'episodeMissing.fallback' } },
    });

    // The item goes on air: its as-run entry says it was a fallback.
    const recorded = await asrun.recordStart(t.tdb.db, scope, {
      eventId: randomUUID(),
      bootId: 'boot-ep',
      seq: 1,
      at: p.startsAt,
      itemId,
      segmentId: null,
      source: 'queue',
      title: null,
      artist: null,
      filename: null,
      rid: '1',
    });
    expect(recorded?.entry).toMatchObject({ logItemId: itemId, fallback: 'latest_episode' });
    const listed = await api<{ items: { id: string; fallback: string | null }[] }>(
      'GET',
      `/asrun?date=${p.date}`,
    );
    expect(listed.items.find((e) => e.id === recorded?.entry.id)?.fallback).toBe('latest_episode');

    // Worked off again: nothing changes.
    await t.tdb.db
      .update(episodeCheck)
      .set({ processedAt: null, claimedAt: null })
      .where(eq(episodeCheck.slotId, p.slot.id));
    await t.app.episodeCheck.processPending();
    expect(
      await t.tdb.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, itemId), eq(auditLog.action, 'log_item.replace'))),
    ).toHaveLength(1);
  });

  it('reruns the chosen episode, and puts the premiere back when its audio arrives in time', async () => {
    const p = await plan('Le Club', 45, 'episode');
    const chosenAsset = await audio('Le Club best of');
    const chosen = await api<Episode>(
      'POST',
      `/shows/${p.show.id}/episodes`,
      // Only an aired episode can stand in (#48, ADR 0028).
      {
        number: 20,
        assetId: chosenAsset,
        status: 'aired',
        airedAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      },
      201,
    );
    await api('PATCH', `/shows/${p.show.id}`, { fallbackEpisodeId: chosen.id });
    const itemId = await emptySlotItem(p);
    await due(p, 'fallback');
    await t.app.episodeCheck.processPending();
    const [aired] = await t.tdb.db.select().from(logItem).where(eq(logItem.id, itemId));
    expect(aired?.assetId).toBe(chosenAsset);

    // The host uploads 45 min ahead: the premiere airs after all.
    const premiereAsset = await audio('Le Club #1');
    await api('PATCH', `/shows/${p.show.id}/episodes/${p.premiere.id}`, {
      assetId: premiereAsset,
    });
    await t.app.episodeCheck.reconcile();
    const [restored] = await t.tdb.db.select().from(logItem).where(eq(logItem.id, itemId));
    expect(restored).toMatchObject({ assetId: premiereAsset, episodeId: p.premiere.id });
    expect(
      await t.tdb.db.select().from(logItemFallback).where(eq(logItemFallback.logItemId, itemId)),
    ).toHaveLength(0);
    expect((await openAlert(p))?.resolution).toBe('episode_ready');
  });

  it('fills the slot with clock music from #50’s interface, every item marked', async () => {
    const p = await plan('Le Mix', 40, 'clock_music');
    const itemId = await emptySlotItem(p);
    const songs = await Promise.all(
      ['One', 'Two'].map(
        async (title) =>
          (await createAsset(t.tdb.db, { actor: system, scope }, { type: 'song', title })).id,
      ),
    );
    const clockId = randomUUID();
    const asked: unknown[] = [];
    const service = createEpisodeCheckService({
      db: t.tdb.db,
      alerts: t.app.alerts,
      mailer: t.app.mailer,
      appUrl: 'http://app.test',
      logger: t.app.log,
      fallback: {
        resolveClock: async (_scope, at) =>
          at.getTime() === p.startsAt.getTime() ? clockId : null,
        clockMusic: {
          fill: async (_scope, request) => {
            asked.push(request);
            return songs.map((assetId) => ({ kind: 'song', assetId, plannedDurationMs: 30 * MIN }));
          },
        },
      },
    });
    await due(p, 'fallback');
    await service.processPending();

    expect(asked).toEqual([{ clockId, startsAt: p.startsAt, durationMs: 60 * MIN }]);
    const [first] = await t.tdb.db.select().from(logItem).where(eq(logItem.id, itemId));
    expect(first).toMatchObject({ kind: 'song', assetId: songs[0], timing: 'hard' });
    const marks = await t.tdb.db
      .select()
      .from(logItemFallback)
      .where(eq(logItemFallback.slotId, p.slot.id));
    expect(marks).toHaveLength(2);
    expect(marks.every((m) => m.kind === 'clock_music')).toBe(true);
    expect((await openAlert(p))?.severity).toBe('warning');
  });

  it('raises a critical alert when nothing can stand in', async () => {
    const p = await plan('Le Vide', 40, 'none');
    await emptySlotItem(p);
    await due(p, 'fallback');
    await t.app.episodeCheck.processPending();
    expect(await openAlert(p)).toMatchObject({
      severity: 'critical',
      title: 'Episode missing: Le Vide, no fallback',
    });

    // `clock_music` without the log generator (#50): nothing to air either.
    const q = await plan('La Nuit', 40, 'clock_music');
    await emptySlotItem(q);
    await due(q, 'fallback');
    await t.app.episodeCheck.processPending();
    expect((await openAlert(q))?.severity).toBe('critical');
  });
});

describe('robustness', () => {
  it('backs a failed step off to a later sweep instead of burning its attempts', async () => {
    const p = await plan('Le Retry', 40);
    await due(p, 't6h');
    let clock = Date.now();
    let failures = 1;
    const service = createEpisodeCheckService({
      db: t.tdb.db,
      alerts: t.app.alerts,
      mailer: {
        async send(message) {
          if (failures-- > 0) throw new Error('SMTP down');
          await t.app.mailer.send(message);
        },
      },
      appUrl: 'http://app.test',
      logger: t.app.log,
      fallback: { resolveClock: async () => null, clockMusic: { fill: async () => null } },
      now: () => new Date(clock),
    });
    await service.processPending();
    const failed = await stepOf(p, 't6h');
    expect(failed).toMatchObject({ processedAt: null, attempts: 1, error: 'SMTP down' });
    expect(failed?.retryAt?.getTime()).toBe(clock + 30_000);
    // Not again in the same sweep, nor before its time.
    expect(await service.processPending()).toBe(0);

    clock += 31_000;
    await service.processPending();
    expect(await stepOf(p, 't6h')).toMatchObject({ result: 'alerted', attempts: 1 });
    expect(
      mailsTo('host@ep-check.test').filter((m) => m.subject.includes('Le Retry')),
    ).toHaveLength(1);
  });

  it('waits for the slot’s log item until the slot starts', async () => {
    const p = await plan('Le Retard', 40);
    await airedEpisode(p, 7);
    await due(p, 'fallback');
    await t.app.episodeCheck.processPending();
    // No item yet (the generator hasn't written it): no critical alert, looked at again later.
    const waiting = await stepOf(p, 'fallback');
    expect(waiting).toMatchObject({ processedAt: null, attempts: 0 });
    expect(waiting?.retryAt?.getTime()).toBeGreaterThan(Date.now());
    expect(await openAlert(p)).toBeUndefined();

    const itemId = await emptySlotItem(p);
    await t.tdb.db
      .update(episodeCheck)
      .set({ retryAt: new Date(Date.now() - 1000) })
      .where(eq(episodeCheck.id, waiting?.id ?? ''));
    await t.app.episodeCheck.processPending();
    expect((await stepOf(p, 'fallback'))?.result).toBe('fallback_applied');
    expect((await airs(itemId, p.startsAt)).fallback).toBe('latest_episode');
  });

  it('leaves an item an operator changed alone: no fallback mark on air, no restore', async () => {
    const p = await plan('Le Choix', 45);
    await airedEpisode(p, 3);
    const itemId = await emptySlotItem(p);
    await due(p, 'fallback');
    await t.app.episodeCheck.processPending();

    // The programmer puts something else there by hand.
    const special = await audio('Le Choix spécial');
    await api('PUT', `/log/items/${itemId}`, {
      kind: 'episode',
      assetId: special,
      plannedDurationMs: 60 * MIN,
      timing: 'hard',
      anchorAt: p.startsAt.toISOString(),
    });
    // The premiere's audio arrives: the operator's choice stays.
    await api('PATCH', `/shows/${p.show.id}/episodes/${p.premiere.id}`, {
      assetId: await audio('Le Choix #1'),
    });
    await t.app.episodeCheck.reconcile();
    const [item] = await t.tdb.db.select().from(logItem).where(eq(logItem.id, itemId));
    expect(item?.assetId).toBe(special);
    expect(
      await t.tdb.db.select().from(logItemFallback).where(eq(logItemFallback.logItemId, itemId)),
    ).toHaveLength(0);
    expect((await airs(itemId, p.startsAt)).fallback).toBeNull();
  });
});

describe('show settings', () => {
  it('saves the fallback policy, audited, and refuses another show’s episode', async () => {
    const a = await plan('A', 600);
    const b = await plan('B', 600);
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/stations/${stationId}/shows/${a.show.id}`,
      cookies: { ondes_session: users.programmer.cookie },
      payload: { fallbackPolicy: 'episode', fallbackEpisodeId: b.premiere.id },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('invalid_fallback_episode');

    const saved = await api<Show>('PATCH', `/shows/${a.show.id}`, {
      fallbackPolicy: 'clock_music',
    });
    expect(saved).toMatchObject({ fallbackPolicy: 'clock_music', fallbackEpisodeId: null });
    const [audit] = await t.tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, a.show.id), eq(auditLog.action, 'show.update')));
    expect(audit?.diff).toMatchObject({
      fallbackPolicy: { from: 'latest_episode', to: 'clock_music' },
    });
  });
});

describe('end to end', () => {
  it('the worker’s pass records the steps, the api airs the fallback, the as-run marks it', async () => {
    const p = await plan('Le Bout en Bout', 40);
    const rerun = await airedEpisode(p, 9);
    const itemId = await emptySlotItem(p);

    // The worker's job, as the sweep runs it.
    const report = await runEpisodeCheck(t.tdb.db, scope, new Date());
    expect(report.recorded).toEqual(
      expect.arrayContaining([
        { slotId: p.slot.id, occurrenceDate: p.date, step: 't6h' },
        { slotId: p.slot.id, occurrenceDate: p.date, step: 'fallback' },
      ]),
    );
    await t.app.episodeCheck.processPending();

    // In air order: the 6 h alert (emails), then the fallback, which has the last word.
    expect(
      mailsTo('programmer@ep-check.test').filter((m) => m.subject.includes('Le Bout')),
    ).toHaveLength(1);
    expect(await openAlert(p)).toMatchObject({
      severity: 'warning',
      title: 'Episode missing: Le Bout en Bout',
    });
    expect((await openAlert(p))?.details).toMatchObject({
      i18n: {
        key: 'episodeMissing.fallback',
        params: { show: 'Le Bout en Bout', fallback: 'latest_episode' },
      },
    });
    const [item] = await t.tdb.db.select().from(logItem).where(eq(logItem.id, itemId));
    expect(item).toMatchObject({ assetId: rerun.assetId, episodeId: rerun.episodeId });
    expect((await airs(itemId, p.startsAt)).fallback).toBe('latest_episode');
  });
});
