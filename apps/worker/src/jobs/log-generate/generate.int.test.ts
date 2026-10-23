import {
  asset,
  attachEpisodeAudio,
  auditLog,
  category,
  categoryMember,
  clock,
  clockGrid,
  clockSlot,
  createOrganization,
  createStation,
  episode,
  fillWithClockMusic,
  loadGeneratorSnapshot,
  logDay,
  logItem,
  logItemFallback,
  resolveOrgScope,
  resolveStationScope,
  StaleGeneratorSnapshotError,
  type StationScope,
  segue,
  show,
  showSlot,
  writeGeneratedDay,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import { type GeneratedDay, generateDays } from '@ondes/scheduling';
import {
  type Actor,
  type LocalDate,
  localDayBounds,
  type RealtimeEvent,
  type SlotRule,
  zonedInstant,
} from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTOR, runLogGenerate } from './generate.ts';

// The `log-generate` job end to end on a real database (#50): snapshot loading, the written
// day (contract, timing, origins), kept items and segues across a regeneration, fallback marks,
// `log.updated`, the audit row, clock music for #47 and late episode audio.

const system: Actor = { type: 'system', name: 'test' };
const TZ = 'Europe/Paris';
const DATE: LocalDate = '2026-11-04';
const HOUR = 3_600_000;

let tdb: TestDatabase;
let scope: StationScope;
let clockId: string;
let showId: string;
let slotId: string;
let liveSlotId: string;
let premiereId: string;
const songIds: string[] = [];
const events: RealtimeEvent[] = [];

const deps = () => ({
  db: tdb.db,
  publish: async (event: RealtimeEvent) => {
    events.push(event);
  },
  now: () => new Date('2026-11-01T00:00:00Z'),
});

const base = () => ({ orgId: scope.orgId, stationId: scope.stationId });

beforeAll(async () => {
  tdb = await createTestDatabase();
  const org = await createOrganization(tdb.db, system, { slug: 'gen-worker', name: 'Org' });
  const orgScope = await resolveOrgScope(tdb.db, org.id);
  const st = await createStation(
    tdb.db,
    { actor: system, scope: orgScope },
    { slug: 'gen-worker-fm', name: 'FM', timezone: TZ },
  );
  scope = await resolveStationScope(tdb.db, org.id, st.id);

  const songs = await tdb.db
    .insert(asset)
    .values(
      Array.from({ length: 120 }, (_, i) => ({
        ...base(),
        type: 'song' as const,
        title: `Song ${i}`,
        artists: [`Artist ${i % 40}`],
        album: `Album ${i % 25}`,
        durationMs: 180_000 + (i % 7) * 15_000,
      })),
    )
    .returning({ id: asset.id });
  songIds.push(...songs.map((s) => s.id));
  const jingles = await tdb.db
    .insert(asset)
    .values(
      [1, 2, 3].map((i) => ({
        ...base(),
        type: 'jingle' as const,
        title: `ID ${i}`,
        durationMs: 6_000,
      })),
    )
    .returning({ id: asset.id });

  const [music, ids] = await tdb.db
    .insert(category)
    .values([
      { ...base(), name: 'Music', assetType: 'song', searchDepthPercent: 50, restMinutes: 180 },
      { ...base(), name: 'IDs', assetType: 'jingle', restMinutes: 0 },
    ])
    .returning({ id: category.id });
  if (!music || !ids) throw new Error('no categories');
  await tdb.db.insert(categoryMember).values([
    ...songIds.map((assetId) => ({
      ...base(),
      categoryId: music.id,
      assetId,
      mode: 'include' as const,
    })),
    ...jingles.map((j) => ({
      ...base(),
      categoryId: ids.id,
      assetId: j.id,
      mode: 'include' as const,
    })),
  ]);

  const [c] = await tdb.db
    .insert(clock)
    .values({ ...base(), name: 'Hour', targetDurationMs: HOUR })
    .returning({ id: clock.id });
  if (!c) throw new Error('no clock');
  clockId = c.id;
  await tdb.db.insert(clockSlot).values([
    { ...base(), clockId, position: 0, kind: 'marker', timing: 'soft', offsetMs: 0, capMs: 60_000 },
    { ...base(), clockId, position: 1, kind: 'jingle', categoryId: ids.id },
    ...Array.from({ length: 16 }, (_, i) => ({
      ...base(),
      clockId,
      position: i + 2,
      kind: 'category' as const,
      categoryId: music.id,
    })),
  ]);
  await tdb.db.insert(clockGrid).values({ ...base(), defaultClockId: clockId, version: 1 });

  const [s] = await tdb.db
    .insert(show)
    .values({ ...base(), name: 'Le Midi' })
    .returning({ id: show.id });
  if (!s) throw new Error('no show');
  showId = s.id;
  const daily = (time: string): SlotRule => ({
    freq: 'weekly',
    startDate: '2026-11-02',
    until: null,
    interval: 1,
    byDay: ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'],
    time,
  });
  const [pre, live] = await tdb.db
    .insert(showSlot)
    .values([
      {
        ...base(),
        showId,
        type: 'prerecorded',
        rule: daily('12:00'),
        startsOn: '2026-11-02',
        durationMs: HOUR,
      },
      {
        ...base(),
        showId,
        type: 'live',
        rule: daily('19:00'),
        startsOn: '2026-11-02',
        durationMs: 2 * HOUR,
      },
    ])
    .returning({ id: showSlot.id });
  if (!pre || !live) throw new Error('no slots');
  slotId = pre.id;
  liveSlotId = live.id;
  const [ep] = await tdb.db
    .insert(episode)
    .values({ ...base(), showId, number: 1, kind: 'prerecorded', slotId, occurrenceDate: DATE })
    .returning({ id: episode.id });
  if (!ep) throw new Error('no episode');
  premiereId = ep.id;
}, 60_000);

afterAll(() => tdb?.drop());

// The worker has no query builder of its own: read whole (small, throwaway) tables.
async function items(localDate: LocalDate) {
  const day = (await tdb.db.select().from(logDay)).find(
    (d) => d.stationId === scope.stationId && d.localDate === localDate,
  );
  if (!day) return { day: null, rows: [] };
  const rows = (await tdb.db.select().from(logItem))
    .filter((r) => r.logDayId === day.id)
    .sort((a, b) => a.position - b.position);
  return { day, rows };
}

describe('log-generate job', () => {
  it('writes the days, with shows, clocks, origins and timing, and announces them', async () => {
    const report = await runLogGenerate(deps(), scope, {
      localDates: [DATE, '2026-11-05'],
      status: 'draft',
    });
    expect(report?.days.map((d) => d.localDate)).toEqual([DATE, '2026-11-05']);

    const { day, rows } = await items(DATE);
    expect(day).toMatchObject({ status: 'draft', version: 1, generatorVersion: '1' });
    expect(day?.seed).toBe(`${scope.stationId}:${DATE}`);
    expect(rows[0]?.plannedStart).toEqual(localDayBounds(DATE, TZ).startsAt);
    expect(rows.map((r) => r.position)).toEqual(rows.map((_, i) => i));

    // The premiere has no audio yet: an empty episode item at 12:00 for #47 to fill.
    const midday = zonedInstant(DATE, '12:00', TZ);
    const ep = rows.find((r) => r.kind === 'episode');
    expect(ep).toMatchObject({
      assetId: null,
      episodeId: premiereId,
      originType: 'show',
      originShowSlotId: slotId,
      timing: 'hard',
      plannedStart: midday,
      plannedDurationMs: HOUR,
    });
    const live = rows.find((r) => r.kind === 'live_slot');
    expect(live).toMatchObject({ originShowSlotId: liveSlotId, plannedDurationMs: 2 * HOUR });
    const songs = rows.filter((r) => r.kind === 'song');
    expect(songs.length).toBeGreaterThan(200);
    expect(songs.every((r) => r.originType === 'clock' && r.originClockId === clockId)).toBe(true);
    expect(songs.every((r) => songIds.includes(r.assetId as string))).toBe(true);

    const event = events.findLast((e) => e.type === 'log.updated');
    expect(event).toMatchObject({ type: 'log.updated', data: { cause: 'generate' } });
    // Then the issues, for the api's alerts (#101).
    expect(events.at(-1)).toMatchObject({
      type: 'log.generated',
      data: { orgId: scope.orgId, days: [{ localDate: DATE, changed: true }, { changed: true }] },
    });
    expect(event?.type === 'log.updated' && event.data.days.map((d) => d.localDate)).toEqual([
      DATE,
      '2026-11-05',
    ]);
    const audits = (await tdb.db.select().from(auditLog)).filter(
      (a) => a.action === 'log_day.generate' && a.entityId === day?.id,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: 'system',
      actorId: ACTOR.type === 'system' ? ACTOR.name : null,
    });
  });

  it('is deterministic: regenerating with the same seed and inputs is a no-op (#101)', async () => {
    const first = await items(DATE);
    const before = first.rows.map((r) => [r.id, r.kind, r.assetId, r.plannedStart.getTime()]);
    const audits = async () =>
      (await tdb.db.select().from(auditLog)).filter((a) => a.action === 'log_day.generate').length;
    const auditsBefore = await audits();
    const eventsBefore = events.length;
    // The same days as the first run: the same snapshot (a lone day would see the next day's
    // items as planned history, and pick around them).
    const report = await runLogGenerate(deps(), scope, {
      localDates: [DATE, '2026-11-05'],
      status: 'draft',
    });
    expect(report?.days.map((d) => d.changed)).toEqual([false, false]);
    const { day, rows } = await items(DATE);
    // Not even new ids: nothing was written, no new version, no audit row, no `log.updated`.
    expect(rows.map((r) => [r.id, r.kind, r.assetId, r.plannedStart.getTime()])).toEqual(before);
    expect(day?.version).toBe(first.day?.version);
    expect(await audits()).toBe(auditsBefore);
    expect(events.slice(eventsBefore).map((e) => e.type)).toEqual(['log.generated']);
  });

  it('keeps locked items, segue ends and fallback marks with their ids on regeneration', async () => {
    const { rows } = await items(DATE);
    const songs = rows.filter((r) => r.kind === 'song');
    const [a, b] = [songs[30], songs[31]] as [(typeof songs)[number], (typeof songs)[number]];
    expect(b.position).toBe(a.position + 1);
    const locked = songs[60] as (typeof songs)[number];
    await tdb.sql`update log_item set locked = true where id = ${locked.id}`;
    const [sg] = await tdb.db
      .insert(segue)
      .values({
        ...base(),
        fromItemId: a.id,
        toItemId: b.id,
        fromAssetId: a.assetId,
        toAssetId: b.assetId,
        outLane: { envelope: [] },
        inLane: { start: 0, envelope: [] },
      })
      .returning({ id: segue.id });
    // #47 put a fallback in the episode's place.
    const ep = rows.find((r) => r.kind === 'episode') as (typeof rows)[number];
    await tdb.sql`update log_item set asset_id = ${songIds[0] as string}, origin_type = 'manual',
      origin_show_slot_id = null where id = ${ep.id}`;
    await tdb.db.insert(logItemFallback).values({
      ...base(),
      logItemId: ep.id,
      slotId,
      occurrenceDate: DATE,
      kind: 'clock_music',
      assetId: songIds[0] as string,
    });

    await runLogGenerate(deps(), scope, { localDates: [DATE], seed: 'another', status: 'draft' });
    const after = (await items(DATE)).rows;
    const byId = new Map(after.map((r) => [r.id, r]));
    expect(byId.get(locked.id)?.locked).toBe(true);
    const [na, nb] = [byId.get(a.id), byId.get(b.id)];
    expect(na && nb && nb.position === na.position + 1).toBe(true);
    const still = (await tdb.db.select().from(segue)).find((x) => x.id === sg?.id);
    expect(still).toMatchObject({ fromItemId: a.id, toItemId: b.id });
    // The fallback stands for the occurrence: no second episode item at 12:00.
    expect(byId.get(ep.id)).toBeDefined();
    expect(after.filter((r) => r.kind === 'episode').map((r) => r.id)).toEqual([ep.id]);
    const mark = (await tdb.db.select().from(logItemFallback)).find((m) => m.logItemId === ep.id);
    expect(mark).toBeDefined();
    // Everything else is new.
    const kept = new Set([locked.id, a.id, b.id, ep.id]);
    expect(
      after
        .filter((r) => !kept.has(r.id) && rows.some((o) => o.id === r.id))
        .map((r) => `${r.kind}@${r.position} locked=${r.locked}`),
    ).toEqual([]);
  });

  it('plans clock music for the missing-episode fallback (#47)', async () => {
    const startsAt = zonedInstant('2026-11-05', '12:00', TZ);
    const fill = await fillWithClockMusic(
      tdb.db,
      scope,
      { clockId, startsAt, durationMs: HOUR },
      new Date('2026-11-01T00:00:00Z'),
    );
    expect(fill?.length).toBeGreaterThan(10);
    expect(fill?.[0]).toMatchObject({
      kind: 'marker',
      timing: 'soft',
      anchorAt: startsAt.toISOString(),
    });
    const total = (fill ?? []).reduce((sum, i) => sum + (i.plannedDurationMs ?? 0), 0);
    expect(Math.abs(total - HOUR)).toBeLessThan(5 * 60_000);
  });

  it('puts late episode audio into the empty items planned for it', async () => {
    const [audio] = await tdb.db
      .insert(asset)
      .values({ ...base(), type: 'episode', title: 'Le Midi #2', durationMs: HOUR - 60_000 })
      .returning({ id: asset.id });
    const [ep2] = await tdb.db
      .insert(episode)
      .values({
        ...base(),
        showId,
        number: 2,
        kind: 'prerecorded',
        slotId,
        occurrenceDate: '2026-11-05',
      })
      .returning({ id: episode.id });
    await runLogGenerate(deps(), scope, { localDates: ['2026-11-05'], status: 'draft' });
    let row = (await items('2026-11-05')).rows.find((r) => r.kind === 'episode');
    expect(row).toMatchObject({ episodeId: ep2?.id, assetId: null });

    await tdb.sql`update episode set asset_id = ${audio?.id as string}, status = 'ready'
      where id = ${ep2?.id as string}`;
    const days = await attachEpisodeAudio(
      tdb.db,
      { actor: ACTOR, scope },
      ep2?.id as string,
      new Date('2026-11-01T00:00:00Z'),
    );
    expect(days.map((d) => d.localDate)).toEqual(['2026-11-05']);
    const after = (await items('2026-11-05')).rows;
    row = after.find((r) => r.kind === 'episode');
    // It takes the episode's own length, and the day is retimed: the minute left before 13:00
    // shows as a gap on the next (anchored) item.
    expect(row).toMatchObject({ assetId: audio?.id, plannedDurationMs: HOUR - 60_000 + 20 });
    const next = after[(row?.position ?? 0) + 1];
    expect(next?.plannedStart).toEqual(zonedInstant('2026-11-05', '13:00', TZ));
    expect(next).toMatchObject({ conflictKind: 'gap', conflictMs: 60_000 - 20 });
  });
  it('plans a rerun with the latest episode that aired before it (#48 rule)', async () => {
    const date: LocalDate = '2026-11-08';
    const [aired, unaired] = await tdb.db
      .insert(asset)
      .values([
        { ...base(), type: 'episode', title: 'Le Midi #10', durationMs: HOUR - 120_000 },
        { ...base(), type: 'episode', title: 'Le Midi #11', durationMs: HOUR - 120_000 },
      ])
      .returning({ id: asset.id });
    const [ep10] = await tdb.db
      .insert(episode)
      .values([
        {
          ...base(),
          showId,
          number: 10,
          kind: 'prerecorded',
          assetId: aired?.id,
          status: 'aired',
          airedAt: new Date('2026-10-30T11:00:00Z'),
        },
        // Has audio but never aired, and isn't scheduled: not rerunnable.
        {
          ...base(),
          showId,
          number: 11,
          kind: 'prerecorded',
          assetId: unaired?.id,
          status: 'ready',
        },
      ])
      .returning({ id: episode.id });
    const [rerunSlot] = await tdb.db
      .insert(showSlot)
      .values({
        ...base(),
        showId,
        type: 'rerun',
        rule: { freq: 'once', date, time: '21:00' },
        startsOn: date,
        endsOn: date,
        durationMs: HOUR,
      })
      .returning({ id: showSlot.id });
    await runLogGenerate(deps(), scope, { localDates: [date], status: 'draft' });
    const rerun = (await items(date)).rows.find((r) => r.originShowSlotId === rerunSlot?.id);
    expect(rerun).toMatchObject({
      kind: 'episode',
      episodeId: ep10?.id,
      assetId: aired?.id,
      timing: 'hard',
      plannedStart: zonedInstant(date, '21:00', TZ),
    });
  });
  it('refuses to write over an item that became kept after the snapshot was loaded', async () => {
    const date: LocalDate = '2026-11-10';
    await runLogGenerate(deps(), scope, { localDates: [date], status: 'draft' });
    const loaded = await loadGeneratorSnapshot(tdb.db, scope, {
      dates: [date],
      now: new Date('2026-11-01T00:00:00Z'),
    });
    if (!loaded) throw new Error('no snapshot');
    const [day] = generateDays(loaded.snapshot, [date], { seed: 'late-lock' });
    // Someone locks an item while the day is being generated.
    const song = (await items(date)).rows.find((r) => r.kind === 'song');
    await tdb.sql`update log_item set locked = true where id = ${song?.id as string}`;
    await expect(
      writeGeneratedDay(tdb.db, { actor: ACTOR, scope }, day as GeneratedDay),
    ).rejects.toBeInstanceOf(StaleGeneratorSnapshotError);
    expect((await items(date)).rows.find((r) => r.id === song?.id)?.locked).toBe(true);
    // The job's retry loads a fresh snapshot and keeps it.
    await runLogGenerate(deps(), scope, { localDates: [date], seed: 'late-lock', status: 'draft' });
    expect((await items(date)).rows.find((r) => r.id === song?.id)?.locked).toBe(true);
  });
});
