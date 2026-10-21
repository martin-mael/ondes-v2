import {
  asRunEntry,
  asset,
  assetFile,
  type Executor,
  logItem,
  type StationScope,
  station,
  unsafeScope,
  whereStation,
} from '@ondes/db';
import {
  type AsRunEntry,
  type AsRunList,
  type AsRunSource,
  asRunOutcome,
  type EngineSource,
  type ListAsRunQuery,
  listAsRunQuerySchema,
  uuidSchema,
} from '@ondes/shared';
import { and, arrayOverlaps, asc, desc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';
import { localDayBounds } from '../log/time.ts';

// As-run queries (#30). Writes come from the durable engine-events consumer (recorder.ts);
// they only ever insert a row, or set the end of a row that has none (append-only).

type Row = typeof asRunEntry.$inferSelect;

export function toEntry(row: Row): AsRunEntry {
  return {
    id: row.id,
    stationId: row.stationId,
    source: row.source,
    logItemId: row.logItemId,
    segmentId: row.segmentId,
    kind: row.kind,
    assetId: row.assetId,
    fileSha256: row.fileSha256,
    title: row.title,
    artist: row.artist,
    artists: row.artists,
    liveSessionId: row.liveSessionId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    outcome: row.outcome,
    plannedStart: row.plannedStart?.toISOString() ?? null,
    plannedDurationMs: row.plannedDurationMs,
    driftMs: row.plannedStart ? row.startedAt.getTime() - row.plannedStart.getTime() : null,
    bootId: row.bootId,
    seq: row.seq,
    recordedAt: row.recordedAt.toISOString(),
  };
}

/** Engine source -> as-run source. The feeder's queue is the log. */
export function asRunSourceOf(source: EngineSource | string): AsRunSource {
  switch (source) {
    case 'queue':
    case 'scheduled': // ADR 0003's engine-timed hard start, also pushed from the log
      return 'log';
    case 'safety':
    case 'emergency':
    case 'live':
      return source;
    default:
      return 'unknown';
  }
}

const SHA_IN_PATH = /(?:^|\/)([0-9a-f]{64})\.[A-Za-z0-9]+$/;

/** The content hash in a playout cache path (`media/ab/<sha256>.flac`, ADR 0004), if any. */
export function shaFromFilename(filename: string | null): string | null {
  return filename?.match(SHA_IN_PATH)?.[1] ?? null;
}

/** A log item id from the engine (any string) as a uuid, or null. */
const asUuid = (id: string | null) => (id && uuidSchema.safeParse(id).success ? id : null);

export async function stationScopeById(
  db: Executor,
  stationId: string,
): Promise<StationScope | null> {
  if (!uuidSchema.safeParse(stationId).success) return null;
  const [row] = await db
    .select({ orgId: station.orgId })
    .from(station)
    .where(eq(station.id, stationId));
  // The ids were just read from the station row.
  return row ? unsafeScope(row.orgId, stationId) : null;
}

export type StartInput = {
  eventId: string;
  bootId: string;
  seq: number;
  at: Date;
  itemId: string | null;
  segmentId: string | null;
  source: EngineSource | string;
  title: string | null;
  artist: string | null;
  filename: string | null;
  rid: string | null;
};

/** What the log, the library and the file name say about an item that just started. */
async function resolveItem(db: Executor, scope: StationScope, input: StartInput) {
  const logItemId = asUuid(input.itemId);
  const [item] = logItemId
    ? await db
        .select({
          kind: logItem.kind,
          plannedStart: logItem.plannedStart,
          plannedDurationMs: logItem.plannedDurationMs,
          assetId: logItem.assetId,
          segmentId: logItem.segmentId,
          title: logItem.title,
        })
        .from(logItem)
        .where(and(whereStation(logItem, scope), eq(logItem.id, logItemId)))
    : [];
  let fileSha256 = shaFromFilename(input.filename);
  let assetId = item?.assetId ?? null;
  if (!assetId && fileSha256) {
    const [file] = await db
      .select({ assetId: assetFile.assetId })
      .from(assetFile)
      .where(
        and(
          whereStation(assetFile, scope),
          eq(assetFile.sha256, fileSha256),
          eq(assetFile.role, 'playout'),
        ),
      )
      .limit(1);
    assetId = file?.assetId ?? null;
  }
  const [a] = assetId
    ? await db
        .select({ title: asset.title, artists: asset.artists, sha256: assetFile.sha256 })
        .from(asset)
        .leftJoin(assetFile, and(eq(assetFile.assetId, asset.id), eq(assetFile.role, 'playout')))
        .where(and(whereStation(asset, scope), eq(asset.id, assetId)))
    : [];
  if (!a) assetId = null;
  fileSha256 ??= a?.sha256 ?? null;
  const artists = a?.artists ?? (input.artist ? [input.artist] : []);
  return {
    // A log item of another station, or deleted since it was pushed: keep the engine's id.
    logItemId,
    segmentId: asUuid(input.segmentId) ?? item?.segmentId ?? null,
    kind: item?.kind ?? null,
    plannedStart: item?.plannedStart ?? null,
    plannedDurationMs: item?.plannedDurationMs ?? null,
    assetId,
    fileSha256,
    title: input.title ?? item?.title ?? a?.title ?? null,
    artist: input.artist ?? (a && a.artists.length > 0 ? a.artists.join(', ') : null),
    artists,
  };
}

/** Records an item going on air. Null when this event was recorded already (a redelivery). */
export async function recordStart(
  db: Executor,
  scope: StationScope,
  input: StartInput,
): Promise<AsRunEntry | null> {
  const resolved = await resolveItem(db, scope, input);
  const [row] = await db
    .insert(asRunEntry)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      eventId: input.eventId,
      bootId: input.bootId,
      seq: input.seq,
      rid: input.rid,
      source: asRunSourceOf(input.source),
      ...resolved,
      startedAt: input.at,
    })
    .onConflictDoNothing()
    .returning();
  return row ? toEntry(row) : null;
}

export type EndInput = {
  eventId: string;
  bootId: string;
  seq: number;
  /** When it left the air (the event's time). */
  at: Date;
  itemId: string | null;
  segmentId: string | null;
  source: EngineSource | string;
  startedAt: Date;
  playedMs: number;
};

/** A `track.ended` matches the open entry of its boot, item and source started within this. */
const START_MATCH_MS = 2000;

/**
 * Sets the end of the item that left the air. If its start was never recorded (lost before it
 * reached the queue), records the whole entry from the end event. Null when there was nothing
 * to do (a redelivery).
 */
export async function recordEnd(
  db: Executor,
  scope: StationScope,
  input: EndInput,
): Promise<AsRunEntry | null> {
  const source = asRunSourceOf(input.source);
  const logItemId = asUuid(input.itemId);
  const playedMs = Math.round(input.playedMs);
  const near = (d: Date, delta: number) => new Date(d.getTime() + delta);
  const [open] = await db
    .select({ id: asRunEntry.id, plannedDurationMs: asRunEntry.plannedDurationMs })
    .from(asRunEntry)
    .where(
      and(
        whereStation(asRunEntry, scope),
        eq(asRunEntry.bootId, input.bootId),
        isNull(asRunEntry.endedAt),
        eq(asRunEntry.source, source),
        logItemId ? eq(asRunEntry.logItemId, logItemId) : isNull(asRunEntry.logItemId),
        gte(asRunEntry.startedAt, near(input.startedAt, -START_MATCH_MS)),
        lt(asRunEntry.startedAt, near(input.startedAt, START_MATCH_MS)),
        lt(asRunEntry.seq, input.seq),
      ),
    )
    .orderBy(desc(asRunEntry.seq))
    .limit(1);
  if (open) {
    const [row] = await db
      .update(asRunEntry)
      .set({
        // The end is the start plus what the engine says it played: both on its clock.
        endedAt: sql`greatest(${asRunEntry.startedAt}, ${asRunEntry.startedAt} + ${playedMs} * interval '1 millisecond')`,
        endSeq: input.seq,
        durationMs: playedMs,
        outcome: asRunOutcome(playedMs, open.plannedDurationMs),
      })
      .where(and(eq(asRunEntry.id, open.id), isNull(asRunEntry.endedAt)))
      .returning();
    return row ? toEntry(row) : null;
  }
  // An end already applied leaves nothing open; only record a start we never saw.
  const [closed] = await db
    .select({ id: asRunEntry.id })
    .from(asRunEntry)
    .where(
      and(
        whereStation(asRunEntry, scope),
        eq(asRunEntry.bootId, input.bootId),
        eq(asRunEntry.endSeq, input.seq),
      ),
    )
    .limit(1);
  if (closed) return null;
  const resolved = await resolveItem(db, scope, {
    ...input,
    at: input.startedAt,
    title: null,
    artist: null,
    filename: null,
    rid: null,
  });
  const startedAt = input.startedAt;
  const [row] = await db
    .insert(asRunEntry)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      eventId: input.eventId,
      bootId: input.bootId,
      seq: input.seq,
      source,
      ...resolved,
      startedAt,
      endedAt: new Date(startedAt.getTime() + playedMs),
      endSeq: input.seq,
      durationMs: playedMs,
      outcome: asRunOutcome(playedMs, resolved.plannedDurationMs),
    })
    .onConflictDoNothing()
    .returning();
  return row ? toEntry(row) : null;
}

/**
 * The engine restarted (boot `bootId` at `at`): entries of earlier boots still on air never
 * got their `track.ended`. They end at `at` (an upper bound), `interrupted`.
 */
export async function closeInterrupted(
  db: Executor,
  scope: StationScope,
  bootId: string,
  at: Date,
): Promise<AsRunEntry[]> {
  const ts = sql`${at.toISOString()}::timestamptz`;
  const rows = await db
    .update(asRunEntry)
    .set({
      endedAt: sql`greatest(${asRunEntry.startedAt}, ${ts})`,
      durationMs: sql`greatest(0, round(extract(epoch from (${ts} - ${asRunEntry.startedAt})) * 1000))::int`,
      outcome: 'interrupted',
    })
    .where(
      and(
        whereStation(asRunEntry, scope),
        isNull(asRunEntry.endedAt),
        ne(asRunEntry.bootId, bootId),
        lt(asRunEntry.startedAt, at),
      ),
    )
    .returning();
  return rows.map(toEntry);
}

// --- Reads -------------------------------------------------------------------------------

type Cursor = { startedAt: string; id: string };

function encodeCursor(row: Row): string {
  return Buffer.from(JSON.stringify([row.startedAt.toISOString(), row.id])).toString('base64url');
}

function decodeCursor(cursor: string): Cursor {
  try {
    const [startedAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as unknown[];
    if (
      typeof startedAt === 'string' &&
      !Number.isNaN(Date.parse(startedAt)) &&
      typeof id === 'string' &&
      uuidSchema.safeParse(id).success
    ) {
      return { startedAt, id };
    }
  } catch {}
  throw new HttpError(400, 'invalid_cursor', 'invalid cursor');
}

/** The UTC range a query covers: `[from, to)`, or the station-local `date`. */
async function rangeOf(db: Executor, scope: StationScope, q: ReturnType<typeof parseQuery>) {
  if (q.from && q.to) return { from: new Date(q.from), to: new Date(q.to) };
  const [row] = await db
    .select({ timezone: station.timezone })
    .from(station)
    .where(eq(station.id, scope.stationId));
  const bounds = localDayBounds(q.date as string, row?.timezone ?? 'UTC');
  return { from: bounds.startsAt, to: bounds.endsAt };
}

const parseQuery = (query: ListAsRunQuery) => listAsRunQuerySchema.parse(query);

/** `GET …/asrun`: entries that started in the range, in air order (or newest first). */
export async function listAsRun(
  db: Executor,
  scope: StationScope,
  query: ListAsRunQuery,
): Promise<AsRunList> {
  const q = parseQuery(query);
  const { from, to } = await rangeOf(db, scope, q);
  const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
  const after = cursor
    ? q.order === 'asc'
      ? sql`(${asRunEntry.startedAt}, ${asRunEntry.id}) > (${cursor.startedAt}::timestamptz, ${cursor.id}::uuid)`
      : sql`(${asRunEntry.startedAt}, ${asRunEntry.id}) < (${cursor.startedAt}::timestamptz, ${cursor.id}::uuid)`
    : undefined;
  const dir = q.order === 'asc' ? asc : desc;
  const rows = await db
    .select()
    .from(asRunEntry)
    .where(
      and(
        whereStation(asRunEntry, scope),
        gte(asRunEntry.startedAt, from),
        lt(asRunEntry.startedAt, to),
        q.assetId ? eq(asRunEntry.assetId, q.assetId) : undefined,
        q.source ? eq(asRunEntry.source, q.source) : undefined,
        after,
      ),
    )
    .orderBy(dir(asRunEntry.startedAt), dir(asRunEntry.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    items: page.map(toEntry),
    nextCursor: rows.length > q.limit && last ? encodeCursor(last) : null,
  };
}

/** What is on air now: the latest entry, if it hasn't ended (now playing, #74). */
export async function getOnAir(db: Executor, scope: StationScope): Promise<AsRunEntry | null> {
  const [row] = await db
    .select()
    .from(asRunEntry)
    .where(whereStation(asRunEntry, scope))
    .orderBy(desc(asRunEntry.startedAt), desc(asRunEntry.id))
    .limit(1);
  return row && !row.endedAt ? toEntry(row) : null;
}

/** When each asset last started airing before `before` (rotation rules, #38). */
export async function lastAiredByAsset(
  db: Executor,
  scope: StationScope,
  assetIds: readonly string[],
  before = new Date(),
): Promise<Map<string, Date>> {
  if (assetIds.length === 0) return new Map();
  const rows = await db
    .select({ assetId: asRunEntry.assetId, at: sql<Date>`max(${asRunEntry.startedAt})` })
    .from(asRunEntry)
    .where(
      and(
        whereStation(asRunEntry, scope),
        inArray(asRunEntry.assetId, [...assetIds]),
        lt(asRunEntry.startedAt, before),
      ),
    )
    .groupBy(asRunEntry.assetId);
  return new Map(rows.map((r) => [r.assetId as string, new Date(r.at)]));
}

/**
 * When each of `artists` last started airing in `[since, before)` (artist separation, #38).
 * Artists that didn't air in the window are absent.
 */
export async function lastAiredByArtist(
  db: Executor,
  scope: StationScope,
  artists: readonly string[],
  since: Date,
  before = new Date(),
): Promise<Map<string, Date>> {
  if (artists.length === 0) return new Map();
  const rows = await db
    .select({ artist: sql<string>`a`, at: sql<Date>`max(${asRunEntry.startedAt})` })
    .from(sql`${asRunEntry} cross join lateral unnest(${asRunEntry.artists}) as a`)
    .where(
      and(
        whereStation(asRunEntry, scope),
        arrayOverlaps(asRunEntry.artists, [...artists]),
        gte(asRunEntry.startedAt, since),
        lt(asRunEntry.startedAt, before),
        sql`a = any(${sql.param([...artists])}::text[])`,
      ),
    )
    .groupBy(sql`a`);
  return new Map(rows.map((r) => [r.artist, new Date(r.at)]));
}
