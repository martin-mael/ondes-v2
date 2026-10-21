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
  liveSessionId?: string | null;
};

/**
 * A write and whether it changed anything: `fresh` is false for a redelivered event, whose
 * entry is returned as it was recorded (so its event can be published again).
 */
export type Recorded = { entry: AsRunEntry; fresh: boolean };

/**
 * What the log, the library and the file name say about an item that just started. Ids that
 * aren't this station's (another tenant's log item, a deleted one) are dropped: the raw
 * engine id stays in `engine_item_id`.
 */
async function resolveItem(
  db: Executor,
  scope: StationScope,
  input: Pick<StartInput, 'itemId' | 'title' | 'artist' | 'filename'>,
) {
  const itemId = asUuid(input.itemId);
  const [item] = itemId
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
        .where(and(whereStation(logItem, scope), eq(logItem.id, itemId)))
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
    engineItemId: input.itemId,
    logItemId: item ? itemId : null,
    // The log item's own segment: the engine's `segment_id` is never trusted on its own.
    segmentId: item?.segmentId ?? null,
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

async function byEventId(db: Executor, scope: StationScope, eventId: string) {
  const [row] = await db
    .select()
    .from(asRunEntry)
    .where(and(whereStation(asRunEntry, scope), eq(asRunEntry.eventId, eventId)));
  return row;
}

/** Records an item going on air (a redelivery returns the entry recorded the first time). */
export async function recordStart(
  db: Executor,
  scope: StationScope,
  input: StartInput,
): Promise<Recorded | null> {
  const resolved = await resolveItem(db, scope, input);
  const source = asRunSourceOf(input.source);
  const [row] = await db
    .insert(asRunEntry)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      eventId: input.eventId,
      bootId: input.bootId,
      seq: input.seq,
      rid: input.rid,
      source,
      ...resolved,
      liveSessionId: source === 'live' ? asUuid(input.liveSessionId ?? null) : null,
      startedAt: input.at,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { entry: toEntry(row), fresh: true };
  const existing = await byEventId(db, scope, input.eventId);
  return existing ? { entry: toEntry(existing), fresh: false } : null;
}

export type EndInput = {
  eventId: string;
  bootId: string;
  seq: number;
  itemId: string | null;
  source: EngineSource | string;
  /** When it went on air, on the engine's clock (`track.ended.started_at`). */
  startedAt: Date;
  playedMs: number;
};

/** A `track.ended` matches the open entry of its boot, item and source started within this. */
const START_MATCH_MS = 2000;

/**
 * Sets the end of the item that left the air: `ended_at` = the engine's `started_at` +
 * `played`, both from the end event (the engine's clock). If its start was never recorded
 * (lost before it reached the queue), records the whole entry from the end event.
 */
export async function recordEnd(
  db: Executor,
  scope: StationScope,
  input: EndInput,
): Promise<Recorded | null> {
  const source = asRunSourceOf(input.source);
  const playedMs = Math.round(input.playedMs);
  const endedAt = new Date(input.startedAt.getTime() + playedMs);
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
        input.itemId === null
          ? isNull(asRunEntry.engineItemId)
          : eq(asRunEntry.engineItemId, input.itemId),
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
        endedAt: sql`greatest(${asRunEntry.startedAt}, ${endedAt.toISOString()}::timestamptz)`,
        endSeq: input.seq,
        durationMs: playedMs,
        outcome: asRunOutcome(playedMs, open.plannedDurationMs),
      })
      .where(and(eq(asRunEntry.id, open.id), isNull(asRunEntry.endedAt)))
      .returning();
    if (row) return { entry: toEntry(row), fresh: true };
  }
  // Already applied (a redelivery): the entry this end closed.
  const [closed] = await db
    .select()
    .from(asRunEntry)
    .where(
      and(
        whereStation(asRunEntry, scope),
        eq(asRunEntry.bootId, input.bootId),
        eq(asRunEntry.endSeq, input.seq),
      ),
    )
    .limit(1);
  if (closed) return { entry: toEntry(closed), fresh: false };
  // A start we never saw: the whole entry, from the end event.
  const resolved = await resolveItem(db, scope, {
    itemId: input.itemId,
    title: null,
    artist: null,
    filename: null,
  });
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
      startedAt: input.startedAt,
      endedAt,
      endSeq: input.seq,
      durationMs: playedMs,
      outcome: asRunOutcome(playedMs, resolved.plannedDurationMs),
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { entry: toEntry(row), fresh: true };
  const existing = await byEventId(db, scope, input.eventId);
  return existing ? { entry: toEntry(existing), fresh: false } : null;
}

/**
 * The engine restarted (boot `bootId` at `at`): entries of other boots still on air never got
 * their `track.ended`. They end at `at` (an upper bound; never before their start, even if the
 * engine clock stepped back), `interrupted`.
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

/**
 * When each asset last started airing before `before` (rotation rules, #38). With `since`, only
 * airings from then on count (assets without one are absent).
 */
export async function lastAiredByAsset(
  db: Executor,
  scope: StationScope,
  assetIds: readonly string[],
  before = new Date(),
  since?: Date,
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
        since ? gte(asRunEntry.startedAt, since) : undefined,
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
