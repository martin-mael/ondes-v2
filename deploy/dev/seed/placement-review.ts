// Smart VT placement review (#61, ADR 0037): 50 auto segues for the owner to listen to.
//
//   node --env-file-if-exists=.env deploy/dev/seed/placement-review.ts [--date YYYY-MM-DD]
//     [--count 50] [--bed] [--force]
//   node --env-file-if-exists=.env deploy/dev/seed/placement-review.ts --report [--date …]
//
// Writes a draft log day (default: two weeks from today, station-local, for the demo station
// or STATION_ID) of song pairs A → B from the station's library, each transition with a segue
// placed by `autoPlacement` (origin `auto`) carrying one of its voice tracks. Draft: the
// feeder never plays it. Prints a checklist with a link to each transition's segue editor.
//
// The cases are deterministic (the same library gives the same day) and spread over what
// decides the placement: A with or without an outro marker, B with or without an intro marker,
// the voice fitting the instrumental parts or delaying B. Songs and VTs need a playout copy;
// markers come from autocue or the cue editor. `--bed` lays the station's first bed under
// voices that outlast the music (the editor does this when the segue has a bed lane).
//
// The owner listens to each transition in the editor and fixes the ones that need it.
// `--report` counts, over the transitions this seed wrote, the ones whose segue is still the one
// it placed (lanes unchanged since its `segue.create` audit row) against the acceptance target:
// 80 % (#61). Saving without a change doesn't count as an adjustment; a seeded segue that was
// changed, deleted or replaced does. `--count` is 1 to 200; no A → B pair repeats.
//
// Refuses a day that already has items unless `--force` (which rewrites it). Needs the dev
// stack (`pnpm dev:up`) and the api's database; with RabbitMQ reachable the island renders are
// enqueued (the running worker renders them), otherwise the worker's sweep picks them up.

import { parseArgs } from 'node:util';
import { logDayItemCount, writeLogDay } from '../../../apps/api/src/modules/log/repo.ts';
import { addDays, localDateOf } from '../../../apps/api/src/modules/log/time.ts';
import { eventsOf, publishAll } from '../../../apps/api/src/modules/segues/events.ts';
import { segueMedia } from '../../../apps/api/src/modules/segues/media.ts';
import { requestRenders } from '../../../apps/api/src/modules/segues/render.ts';
import { createSegue } from '../../../apps/api/src/modules/segues/repo.ts';
import {
  createDb,
  type Db,
  resolveStationScope,
  type StationScope,
} from '../../../packages/db/src/index.ts';
import {
  type Actor,
  autoPlacement,
  type LocalDate,
  localDateSchema,
  type PlacementReport,
  placementMediaOf,
  type SegueMedia,
} from '../../../packages/shared/src/index.ts';
import { demo } from './index.ts';
import { connectBus } from './log-fixture.ts';

const actor: Actor = { type: 'system', name: 'dev-seed:placement-review' };
const SEED = 61;
const GENERATOR = 'placement-review/1';
const MAX_COUNT = 200;

type Media = SegueMedia & { title: string };
type Case = { a: Media; b: Media; voice: Media; report: PlacementReport; kind: string };

const log = {
  error: (obj: unknown, msg: string) => console.error(`placement-review: ${msg}`, obj),
} as unknown as Parameters<typeof publishAll>[2];

/** mulberry32: a tiny seeded PRNG, so the case set is the same on every run. */
function random(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** What the reviewer is listening to, in a few words. */
function kindOf(r: PlacementReport): string {
  const markers = `${r.markers.outro ? 'outro' : 'no outro'}, ${r.markers.intro ? 'intro' : 'no intro'}`;
  const fit =
    r.fit === 'post'
      ? 'fits'
      : r.dry > 0
        ? r.bed
          ? 'B delayed, bed'
          : 'B delayed, dry voice'
        : 'B delayed';
  return `${markers}; ${fit}`;
}

async function library(db: Db, scope: StationScope) {
  const rows = await db.query.asset.findMany({
    where: (t, { and, eq, inArray }) =>
      and(eq(t.stationId, scope.stationId), inArray(t.type, ['song', 'vt', 'bed'])),
    columns: { id: true, type: true, title: true },
    orderBy: (t, { asc }) => [asc(t.id)],
  });
  const { assets } = await segueMedia(db, scope, { itemIds: [], assetIds: rows.map((r) => r.id) });
  const of = (type: string) =>
    rows.flatMap((r) => {
      const m = assets[r.id];
      return r.type === type && m ? [{ ...m, title: r.title ?? r.id }] : [];
    });
  return { songs: of('song'), vts: of('vt'), beds: of('bed') };
}

/**
 * `count` cases: candidates drawn with a seeded PRNG, then taken round-robin over their kind so
 * every kind the library can produce is represented, the common ones most.
 */
function pickCases(lib: Awaited<ReturnType<typeof library>>, count: number, bed: Media | null) {
  const next = random(SEED);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)] as T;
  const byKind = new Map<string, Case[]>();
  const pairs = new Set<string>();
  for (let i = 0; i < count * 40; i++) {
    const a = pick(lib.songs);
    const b = pick(lib.songs);
    const pair = `${a.assetId}:${b.assetId}`;
    if (a.assetId === b.assetId || pairs.has(pair)) continue;
    pairs.add(pair);
    const voice = pick(lib.vts);
    const { report } = autoPlacement(placementMediaOf(a), placementMediaOf(b), [voice], {
      bed: bed && { assetId: bed.assetId, cueIn: bed.cueIn, cueOut: bed.cueOut },
    });
    const kind = kindOf(report);
    byKind.set(kind, [...(byKind.get(kind) ?? []), { a, b, voice, report, kind }]);
  }
  const kinds = [...byKind.keys()].sort();
  const cases: Case[] = [];
  for (let round = 0; cases.length < count; round++) {
    let added = false;
    for (const kind of kinds) {
      const c = byKind.get(kind)?.[round];
      if (c && cases.length < count) {
        cases.push(c);
        added = true;
      }
    }
    if (!added) break;
  }
  return cases;
}

async function seedReview(
  db: Db,
  scope: StationScope,
  localDate: LocalDate,
  options: { count: number; bed: boolean; force: boolean; appUrl: string },
) {
  if (!options.force && (await logDayItemCount(db, scope, localDate)) > 0) {
    throw new Error(
      `${localDate} already has items: pick another --date, or --force to rewrite it`,
    );
  }
  const lib = await library(db, scope);
  if (lib.songs.length < 2 || !lib.vts.length) {
    throw new Error(
      `needs at least 2 songs and 1 VT with a playout copy (has ${lib.songs.length} songs, ` +
        `${lib.vts.length} VTs): import some, or run \`pnpm dev:seed:audio\``,
    );
  }
  const bed = options.bed ? (lib.beds[0] ?? null) : null;
  if (options.bed && !bed)
    console.warn('placement-review: no bed with a playout copy, --bed ignored');
  const cases = pickCases(lib, options.count, bed);
  if (cases.length < options.count) {
    console.warn(
      `placement-review: the library gives ${cases.length} distinct song pairs, not ` +
        `${options.count}: import more songs for a full set`,
    );
  }

  const ms = (m: Media) => Math.round(((m.cueOut - m.cueIn) * 1000) / m.sampleRate);
  const items = cases.flatMap((c, i) =>
    [c.a, c.b].map((m) => ({
      kind: 'song' as const,
      assetId: m.assetId,
      plannedDurationMs: ms(m),
      origin: { type: 'clock' as const, clockId: null, slotIndex: i },
    })),
  );
  await writeLogDay(
    db,
    { actor, scope },
    {
      localDate,
      status: 'draft',
      items,
      generatedAt: new Date(),
      seed: `placement-review/${SEED}`,
      generatorVersion: GENERATOR,
      cause: 'fixture',
    },
  );
  const day = await db.query.logDay.findFirst({
    where: (t, { and, eq }) => and(eq(t.stationId, scope.stationId), eq(t.localDate, localDate)),
    columns: { id: true },
  });
  if (!day) throw new Error('log day missing after writing it');
  const rows = await db.query.logItem.findMany({
    where: (t, { and, eq, isNull }) =>
      and(eq(t.stationId, scope.stationId), eq(t.logDayId, day.id), isNull(t.segmentId)),
    orderBy: (t, { asc }) => [asc(t.position)],
    columns: { id: true, plannedStart: true },
  });

  const bus = await connectBus();
  const lines: string[] = [];
  try {
    for (const [i, c] of cases.entries()) {
      const from = rows[2 * i];
      const to = rows[2 * i + 1];
      if (!from || !to) throw new Error(`case ${i + 1} has no items`);
      const { lanes } = autoPlacement(placementMediaOf(c.a), placementMediaOf(c.b), [c.voice], {
        bed: bed && { assetId: bed.assetId, cueIn: bed.cueIn, cueOut: bed.cueOut },
      });
      const { segue, sync } = await createSegue(
        db,
        { actor, scope },
        {
          fromItemId: from.id,
          toItemId: to.id,
          ...lanes,
          origin: 'auto',
        },
      );
      if (!segue) throw new Error('created segue missing');
      await publishAll(
        bus.events,
        eventsOf(scope, sync, {
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
      await requestRenders(bus.jobs, scope, sync, log);
      const url =
        `${options.appUrl}/stations/${scope.stationId}/log/segue?` +
        new URLSearchParams({ date: localDate, from: from.id, to: to.id });
      const sec = (n: number) => `${(n / 44_100).toFixed(1)} s`;
      lines.push(
        `- [ ] ${String(i + 1).padStart(2)}. ${c.a.title} → ${c.b.title} · voice ${c.voice.title} ` +
          `(${sec(c.voice.cueOut - c.voice.cueIn)}) · ${c.kind}` +
          (c.report.delay ? ` (B +${sec(c.report.delay)})` : '') +
          (segue.status === 'ready' ? '' : ` · ${segue.status}`) +
          `\n      ${url}`,
      );
    }
  } finally {
    await bus.close();
  }
  const kinds = new Map<string, number>();
  for (const c of cases) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
  console.log(
    `# Smart VT placement review: ${localDate} (${cases.length} transitions, draft)\n\n` +
      `${[...kinds].map(([k, n]) => `${n} × ${k}`).join('\n')}\n\n` +
      'Listen to each one in the segue editor; fix and save the ones that need it.\n' +
      'Then: `node --env-file-if-exists=.env deploy/dev/seed/placement-review.ts --report ' +
      `--date ${localDate}\`\n\n${lines.join('\n')}`,
  );
}

/** JSON with sorted keys: lanes compare equal whatever the key order jsonb gave them. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)))
      : v,
  );
}

/**
 * The transitions this seed wrote on the day (consecutive item pairs, as `seedReview` lays them),
 * each counted as untouched when its segue is the one the seed created (its `segue.create` audit
 * row by this seed's actor) with the same lanes: an editor save with no change keeps it so.
 */
async function report(db: Db, scope: StationScope, localDate: LocalDate) {
  const day = await db.query.logDay.findFirst({
    where: (t, { and, eq }) => and(eq(t.stationId, scope.stationId), eq(t.localDate, localDate)),
    columns: { id: true, generatorVersion: true },
  });
  if (!day || day.generatorVersion !== GENERATOR) {
    throw new Error(`${localDate} isn't a placement review day: seed one first (without --report)`);
  }
  const items = await db.query.logItem.findMany({
    where: (t, { and, eq, isNull }) =>
      and(eq(t.stationId, scope.stationId), eq(t.logDayId, day.id), isNull(t.segmentId)),
    orderBy: (t, { asc }) => [asc(t.position)],
    columns: { id: true },
  });
  const pairs = items.flatMap((from, i) => {
    const to = items[i + 1];
    return i % 2 === 0 && to ? [{ from: from.id, to: to.id }] : [];
  });
  const segues = pairs.length
    ? await db.query.segue.findMany({
        where: (t, { and, eq, inArray }) =>
          and(
            eq(t.stationId, scope.stationId),
            inArray(
              t.fromItemId,
              pairs.map((p) => p.from),
            ),
          ),
        columns: {
          id: true,
          fromItemId: true,
          toItemId: true,
          outLane: true,
          inLane: true,
          voices: true,
        },
      })
    : [];
  const created = segues.length
    ? await db.query.auditLog.findMany({
        where: (t, { and, eq, inArray }) =>
          and(
            eq(t.stationId, scope.stationId),
            eq(t.action, 'segue.create'),
            eq(t.actorType, 'system'),
            eq(t.actorId, actor.type === 'system' ? actor.name : ''),
            inArray(
              t.entityId,
              segues.map((s) => s.id),
            ),
          ),
        columns: { entityId: true, diff: true },
      })
    : [];
  const seeded = new Map(created.map((row) => [row.entityId, row.diff]));
  let untouched = 0;
  const adjusted: number[] = [];
  for (const [i, pair] of pairs.entries()) {
    const segue = segues.find((s) => s.fromItemId === pair.from && s.toItemId === pair.to);
    const diff = segue && seeded.get(segue.id);
    const same =
      segue &&
      diff &&
      canonical([segue.outLane, segue.inLane, segue.voices]) ===
        canonical([diff.outLane?.to, diff.inLane?.to, diff.voices?.to ?? []]);
    if (same) untouched++;
    else adjusted.push(i + 1);
  }
  const pct = pairs.length ? Math.round((100 * untouched) / pairs.length) : 0;
  console.log(
    `${localDate}: ${untouched} of ${pairs.length} seeded auto segues need no manual adjustment ` +
      `(${pct} %; target 80 %): ${pct >= 80 ? 'met' : 'not met'}.` +
      (adjusted.length ? `\nAdjusted: ${adjusted.join(', ')}.` : ''),
  );
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      date: { type: 'string' },
      count: { type: 'string', default: '50' },
      bed: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      report: { type: 'boolean', default: false },
    },
  });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('placement-review: DATABASE_URL is not set. Copy .env.example to .env first.');
    process.exit(1);
  }
  const { db, close } = createDb(databaseUrl, { max: 1, applicationName: 'placement-review' });
  try {
    const st = await db.query.station.findFirst({
      where: (t, { eq }) =>
        process.env.STATION_ID ? eq(t.id, process.env.STATION_ID) : eq(t.slug, demo.station.slug),
    });
    if (!st) throw new Error('no station: run `pnpm dev:seed` first, or set STATION_ID');
    const scope = await resolveStationScope(db, st.orgId, st.id);
    const localDate = values.date
      ? localDateSchema.parse(values.date)
      : addDays(localDateOf(new Date(), st.timezone), 14);
    if (values.report) await report(db, scope, localDate);
    else {
      const count = Number(values.count);
      if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
        throw new Error(
          `--count must be a whole number from 1 to ${MAX_COUNT} (got ${values.count})`,
        );
      }
      await seedReview(db, scope, localDate, {
        count,
        bed: values.bed,
        force: values.force,
        appUrl: process.env.APP_URL ?? 'http://localhost:5173',
      });
    }
  } catch (error) {
    console.error(`placement-review: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  } finally {
    await close();
  }
}
