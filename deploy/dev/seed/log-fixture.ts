// Fixture log (#100): yesterday, today and tomorrow (station-local) for the demo station, so
// the feeder, as-run, timeline and dashboard have a realistic log before the generator (#50).
// Called from index.ts (`pnpm dev:seed`). Creates the fixture's assets (metadata only, no
// audio files: `pnpm dev:seed:audio` adds them, see audio.ts) and writes each day only if it has no items yet, so manual
// edits survive a re-seed. `LOG_FIXTURE_FORCE=1 pnpm dev:seed` rewrites the days.
//
// Each hour's voice track is a segue (ADR 0017) between two songs, created through the segues
// repository (audited, islands synced) once the day is written. Days written before segues
// existed have a `segment` island instead (`Island: A → VT → B`): from tomorrow on, those are
// migrated in place (song A, song B, the segue, the hour's fill stretched by the time the VT
// took), through the log's edit functions. Today and past days are left as they are. With
// RabbitMQ reachable (RABBITMQ_URL), the edits' events are published and the island renders
// enqueued like the api does; without it the worker's sweep picks the renders up.

import {
  buildFixtureLog,
  FIXTURE_LIBRARY,
  type FixtureAsset,
  fixtureFill,
  fixtureSegueLanes,
  fixtureSong,
} from '../../../apps/api/src/modules/log/fixture.ts';
import {
  insertLogItem,
  type LogEditOutcome,
  logDayItemCount,
  replaceLogItem,
  writeLogDay,
} from '../../../apps/api/src/modules/log/repo.ts';
import { publishEdit } from '../../../apps/api/src/modules/log/routes.ts';
import { addDays, localDateOf } from '../../../apps/api/src/modules/log/time.ts';
import { eventsOf, publishAll } from '../../../apps/api/src/modules/segues/events.ts';
import { segueMedia } from '../../../apps/api/src/modules/segues/media.ts';
import { requestRenders } from '../../../apps/api/src/modules/segues/render.ts';
import { createSegue } from '../../../apps/api/src/modules/segues/repo.ts';
import { createAsset, type Db, type StationScope } from '../../../packages/db/src/index.ts';
import {
  connectQueue,
  createEventPublisher,
  createJobPublisher,
  type JobPublisher,
} from '../../../packages/queue/src/index.ts';
import {
  type Actor,
  type LocalDate,
  PLAYOUT_SAMPLE_RATE,
  type RealtimeEvent,
  realtimeEventSchema,
} from '../../../packages/shared/src/index.ts';

export const FIXTURE_PREFIX = 'fixture/log/';

/** Title prefix of the islands written as `segment` items before segues (#55). */
const LEGACY_ISLAND_PREFIX = 'Island: ';

type Ctx = { actor: Actor; scope: StationScope };

/** Where the seed's events and render jobs go: RabbitMQ when reachable, else nowhere. */
export type Bus = {
  events?: { publish(event: RealtimeEvent): Promise<void> };
  jobs?: JobPublisher;
  close(): Promise<void>;
};

const log = {
  error: (obj: unknown, msg: string) => console.error(`dev:seed: ${msg}`, obj),
} as unknown as Parameters<typeof publishEdit>[1];

export async function connectBus(): Promise<Bus> {
  const url = process.env.RABBITMQ_URL;
  if (!url) return { close: async () => {} };
  try {
    const queue = await connectQueue(url, { connectionName: 'dev-seed' });
    const events = createEventPublisher(queue.rabbit, queue.topology, realtimeEventSchema);
    const jobs = createJobPublisher(queue.rabbit, queue.topology);
    return {
      events,
      jobs,
      async close() {
        await Promise.all([events.close(), jobs.close()]);
        await queue.close();
      },
    };
  } catch (error) {
    console.warn(`dev:seed: RabbitMQ unreachable, no events or render jobs (${error})`);
    return { close: async () => {} };
  }
}

export async function seedLogFixture(
  db: Db,
  actor: Actor,
  scope: StationScope,
  timezone: string,
  options: { force?: boolean; now?: Date } = {},
): Promise<string> {
  const ctx: Ctx = { actor, scope };
  const existing = await db.query.asset.findMany({
    where: (t, { and, eq, like }) =>
      and(eq(t.stationId, scope.stationId), like(t.sourceFilename, `${FIXTURE_PREFIX}%`)),
    columns: { id: true, type: true, title: true, durationMs: true, sourceFilename: true },
  });
  const assets: FixtureAsset[] = [];
  for (const spec of FIXTURE_LIBRARY) {
    const sourceFilename = `${FIXTURE_PREFIX}${spec.type}/${spec.title}`;
    const found =
      existing.find((a) => a.sourceFilename === sourceFilename) ??
      (await createAsset(db, ctx, { ...spec, sourceFilename }));
    assets.push({
      id: found.id,
      type: found.type,
      title: found.title,
      durationMs: found.durationMs ?? spec.durationMs,
    });
  }

  const today = localDateOf(options.now ?? new Date(), timezone);
  let bus: Bus | undefined;
  const connect = async () => {
    bus ??= await connectBus();
    return bus;
  };
  try {
    const written: string[] = [];
    for (const localDate of [addDays(today, -1), today, addDays(today, 1)]) {
      if (!options.force && (await logDayItemCount(db, scope, localDate)) > 0) continue;
      const { items, segues } = buildFixtureLog(localDate, timezone, assets);
      const out = await writeLogDay(db, ctx, {
        localDate,
        status: 'published',
        items,
        generatedAt: new Date(),
        seed: 'fixture',
        generatorVersion: 'log-fixture/2',
        cause: 'fixture',
      });
      const ids = await topLevelItemIds(db, scope, localDate);
      for (const s of segues) {
        const from = ids[s.fromIndex];
        const to = ids[s.fromIndex + 1];
        if (!from || !to) throw new Error(`fixture segue ${s.fromIndex} has no items`);
        await addSegue(db, ctx, await connect(), from, to, s.voice);
      }
      written.push(`${localDate} (${out.itemCount} items, ${segues.length} segues)`);
    }

    const migrated = await migrateIslands(db, ctx, today, assets, connect);
    const parts = [
      written.length ? `log fixture written: ${written.join(', ')}` : 'log fixture: days exist',
    ];
    if (migrated) parts.push(`${migrated} island segment(s) migrated to segues`);
    return parts.join('; ');
  } finally {
    await bus?.close();
  }
}

/** Ids of a day's top-level items, in play order: the indexes of `buildFixtureLog`. */
async function topLevelItemIds(db: Db, scope: StationScope, localDate: LocalDate) {
  const day = await db.query.logDay.findFirst({
    where: (t, { and, eq }) => and(eq(t.stationId, scope.stationId), eq(t.localDate, localDate)),
    columns: { id: true },
  });
  return day ? (await topLevelItems(db, scope, day.id)).map((r) => r.id) : [];
}

/** A day's top-level items in play order (segment parts left out). */
function topLevelItems(db: Db, scope: StationScope, dayId: string) {
  return db.query.logItem.findMany({
    where: (t, { and, eq, isNull }) =>
      and(eq(t.stationId, scope.stationId), eq(t.logDayId, dayId), isNull(t.segmentId)),
    orderBy: (t, { asc }) => [asc(t.position)],
  });
}

/** The segue A → B with `voice` in its lane, published and its render enqueued. */
async function addSegue(
  db: Db,
  ctx: Ctx,
  bus: Bus,
  fromItemId: string,
  toItemId: string,
  voice: FixtureAsset,
) {
  const media = (await segueMedia(db, ctx.scope, { itemIds: [], assetIds: [voice.id] })).assets[
    voice.id
  ];
  const voiceSamples = media
    ? Math.round(((media.cueOut - media.cueIn) * PLAYOUT_SAMPLE_RATE) / media.sampleRate)
    : Math.round((voice.durationMs * PLAYOUT_SAMPLE_RATE) / 1000);
  const { segue, sync } = await createSegue(db, ctx, {
    fromItemId,
    toItemId,
    ...fixtureSegueLanes(voice.id, voiceSamples),
    origin: 'manual',
  });
  if (!segue) throw new Error('created segue missing');
  await publishAll(
    bus.events,
    eventsOf(ctx.scope, sync, {
      change: 'created',
      segue: {
        segueId: segue.id,
        status: segue.status,
        problem: segue.problem,
        islandId: segue.island?.id ?? null,
        fromItemId: segue.fromItemId,
        toItemId: segue.toItemId,
      },
    }),
    log,
  );
  await requestRenders(bus.jobs, ctx.scope, sync, log);
}

/**
 * Replaces the fixture's legacy island segments (`Island: A → VT → B`, clock origin, parts
 * song/vt/song) of the days after `today` with song A, song B and a segue carrying the VT. The
 * two songs are shorter than the segment (no VT time, a crossfade between them), so the hour's
 * fill grows by the difference and the hour still ends on the hour. Returns how many it
 * migrated; a second run finds none.
 */
async function migrateIslands(
  db: Db,
  ctx: Ctx,
  today: LocalDate,
  assets: readonly FixtureAsset[],
  connect: () => Promise<Bus>,
): Promise<number> {
  const days = await db.query.logDay.findMany({
    where: (t, { and, eq, gt }) =>
      and(eq(t.stationId, ctx.scope.stationId), gt(t.localDate, today)),
    orderBy: (t, { asc }) => [asc(t.localDate)],
    columns: { id: true },
  });
  const segments = [];
  for (const day of days) {
    for (const item of await topLevelItems(db, ctx.scope, day.id)) {
      if (
        item.kind === 'segment' &&
        item.title?.startsWith(LEGACY_ISLAND_PREFIX) &&
        item.originType === 'clock' &&
        item.originClockId === null
      ) {
        segments.push(item);
      }
    }
  }
  const bed = assets.find((a) => a.type === 'bed');
  let migrated = 0;
  for (const seg of segments) {
    const parts = await db.query.logItem.findMany({
      where: (t, { and, eq }) => and(eq(t.stationId, ctx.scope.stationId), eq(t.segmentId, seg.id)),
      orderBy: (t, { asc }) => [asc(t.position)],
    });
    const [a, vt, b] = parts;
    if (
      parts.length !== 3 ||
      a?.kind !== 'song' ||
      vt?.kind !== 'vt' ||
      b?.kind !== 'song' ||
      !a.assetId ||
      !vt.assetId ||
      !b.assetId
    ) {
      continue;
    }
    const bus = await connect();
    const publish = (outcome: LogEditOutcome) =>
      publishEdit(bus.events, log, ctx.scope.stationId, outcome);
    const song = (p: { assetId: string; ms: number }, slot: number) =>
      fixtureSong({ id: p.assetId, type: 'song', title: '', durationMs: p.ms }, slot);
    const slot = seg.originSlotIndex ?? 0;
    const songA = song({ assetId: a.assetId, ms: a.plannedDurationMs }, slot);
    const songB = song({ assetId: b.assetId, ms: b.plannedDurationMs }, slot);
    const delta = seg.plannedDurationMs - songA.plannedDurationMs - songB.plannedDurationMs;

    await publish(await replaceLogItem(db, ctx, seg.id, songA));
    const inserted = await insertLogItem(db, ctx, { after: seg.id }, songB);
    await publish(inserted);
    if (delta !== 0) await stretchFill(db, ctx, seg.logDayId, inserted.itemId, delta, bed, publish);

    const voice = assets.find((x) => x.id === vt.assetId) ?? {
      id: vt.assetId,
      type: 'vt' as const,
      title: '',
      durationMs: vt.plannedDurationMs,
    };
    await addSegue(db, ctx, bus, seg.id, inserted.itemId, voice);
    migrated++;
  }
  return migrated;
}

/**
 * Gives the hour of `afterItemId` `deltaMs` more fill: the fixture's fill before the next
 * anchored item (the next hour's marker, a hard start) grows, or a new one goes there.
 */
async function stretchFill(
  db: Db,
  ctx: Ctx,
  dayId: string,
  afterItemId: string,
  deltaMs: number,
  bed: FixtureAsset | undefined,
  publish: (outcome: LogEditOutcome) => Promise<void>,
) {
  const rows = await topLevelItems(db, ctx.scope, dayId);
  const start = rows.findIndex((r) => r.id === afterItemId);
  let last = afterItemId;
  for (const r of rows.slice(start + 1)) {
    // `not_before` (the 18:30 agenda) only waits: the hour goes on after it.
    if (r.anchorAt && r.timing !== 'not_before') {
      if (bed)
        await publish(await insertLogItem(db, ctx, { before: r.id }, fixtureFill(bed, deltaMs, 0)));
      return;
    }
    if (
      r.kind === 'fill' &&
      r.title === 'Fill to the hour' &&
      r.originType === 'clock' &&
      r.assetId
    ) {
      const fill = fixtureFill(
        { id: r.assetId, type: 'bed', title: '', durationMs: 0 },
        r.plannedDurationMs + deltaMs,
        r.originSlotIndex ?? 0,
      );
      await publish(await replaceLogItem(db, ctx, r.id, fill));
      return;
    }
    last = r.id;
  }
  if (bed)
    await publish(await insertLogItem(db, ctx, { after: last }, fixtureFill(bed, deltaMs, 0)));
}
