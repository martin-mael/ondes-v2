import {
  asset,
  auditDiff,
  type Db,
  type Executor,
  logDay,
  logItem,
  type MutationContext,
  NotFoundError,
  type StationScope,
  station,
  type Tx,
  whereStation,
  withAudit,
} from '@ondes/db';
import {
  type Actor,
  type LocalDate,
  type LogAssetSummary,
  type LogDay,
  type LogDayStatus,
  type LogEditResult,
  type LogItem,
  type LogItemChange,
  type LogItemInput,
  type LogItemOrigin,
  type LogNowQuery,
  type LogNowResponse,
  type LogPlacement,
  type LogRangeQuery,
  type LogRangeResponse,
  type LogSegmentPart,
  type LogUpdateCause,
  logItemInputSchema,
  logNowQuerySchema,
  type ParsedLogItemInput,
  type RelaxedRule,
} from '@ondes/shared';
import { and, asc, eq, gt, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';
import { localDayBounds } from './time.ts';
import { retime } from './timing.ts';

// Log persistence (#100): range reads, manual edits and bulk day writes. Every function takes
// the station scope and filters on it; edits run in `withAudit`.
//
// An edit loads the whole day (a few hundred rows), applies the change in memory, retimes the
// day (timing.ts) and writes back only the rows whose position, day or timing changed. The
// position unique key is not deferrable, so changed rows go through negative positions first.

type Row = typeof logItem.$inferSelect;
type DayRow = typeof logDay.$inferSelect;
type NewRow = typeof logItem.$inferInsert;

export interface StationContext extends MutationContext {
  actor: Actor;
  scope: StationScope;
}

/** What an edit did, for the response and the events. */
export interface LogEditOutcome {
  result: LogEditResult;
  itemId: string;
  logDayId: string;
  change: LogItemChange;
  /** Planned range that changed (UTC); the item's own range when nothing moved. */
  range: { from: Date; to: Date };
}

/** A Date as a `timestamptz` parameter of a raw `sql` fragment. */
const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/** Max span of one top-level item, to bound range scans on `(station_id, planned_start)`. */
const MAX_ITEM_SPAN_MS = 25 * 3600 * 1000;

// --- Reads -------------------------------------------------------------------------------

export async function getLogRange(
  db: Executor,
  scope: StationScope,
  query: LogRangeQuery,
): Promise<LogRangeResponse> {
  const from = new Date(query.from);
  const to = new Date(query.to);
  const days = await db
    .select()
    .from(logDay)
    .where(and(whereStation(logDay, scope), lt(logDay.startsAt, to), gt(logDay.endsAt, from)))
    .orderBy(asc(logDay.startsAt));
  const rows = await topLevel(db)
    .where(
      and(
        whereStation(logItem, scope),
        isNull(logItem.segmentId),
        lt(logItem.plannedStart, to),
        gt(logItem.plannedStart, new Date(from.getTime() - MAX_ITEM_SPAN_MS)),
        or(
          gte(logItem.plannedStart, from),
          sql`${logItem.plannedStart} + ${logItem.plannedDurationMs} * interval '1 millisecond' > ${ts(from)}`,
        ),
      ),
    )
    .orderBy(asc(logDay.startsAt), asc(logItem.position));
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    days: days.map(toDayDto),
    items: await expand(
      db,
      scope,
      rows.map((r) => r.item),
    ),
  };
}

export async function getLogNow(
  db: Executor,
  scope: StationScope,
  input: LogNowQuery,
): Promise<LogNowResponse> {
  const query = logNowQuerySchema.parse(input);
  const at = query.at ? new Date(query.at) : new Date();
  const [current] = await topLevel(db)
    .where(
      and(
        whereStation(logItem, scope),
        isNull(logItem.segmentId),
        lt(logItem.plannedStart, new Date(at.getTime() + 1)),
        gt(logItem.plannedStart, new Date(at.getTime() - MAX_ITEM_SPAN_MS)),
        sql`${logItem.plannedStart} + ${logItem.plannedDurationMs} * interval '1 millisecond' > ${ts(at)}`,
      ),
    )
    .orderBy(sql`${logItem.plannedStart} desc`, sql`${logItem.position} desc`)
    .limit(1);
  const next =
    query.next === 0
      ? []
      : await topLevel(db)
          .where(
            and(
              whereStation(logItem, scope),
              isNull(logItem.segmentId),
              current
                ? sql`(${logItem.plannedStart}, ${logDay.startsAt}, ${logItem.position}) > (${ts(current.item.plannedStart)}, ${ts(current.dayStartsAt)}, ${current.item.position})`
                : gt(logItem.plannedStart, at),
            ),
          )
          .orderBy(asc(logItem.plannedStart), asc(logDay.startsAt), asc(logItem.position))
          .limit(query.next);
  const items = await expand(db, scope, [
    ...(current ? [current.item] : []),
    ...next.map((r) => r.item),
  ]);
  return {
    at: at.toISOString(),
    current: current ? (items[0] ?? null) : null,
    next: current ? items.slice(1) : items,
  };
}

/** Top-level items joined to their day (for play order across days). */
function topLevel(db: Executor) {
  return db
    .select({ item: logItem, dayStartsAt: logDay.startsAt })
    .from(logItem)
    .innerJoin(logDay, eq(logDay.id, logItem.logDayId))
    .$dynamic();
}

/** Turns top-level rows into DTOs: asset summaries, and segment parts. */
async function expand(db: Executor, scope: StationScope, rows: Row[]): Promise<LogItem[]> {
  const segmentIds = rows.filter((r) => r.kind === 'segment').map((r) => r.id);
  const parts = segmentIds.length
    ? await db
        .select()
        .from(logItem)
        .where(and(whereStation(logItem, scope), inArray(logItem.segmentId, segmentIds)))
        .orderBy(asc(logItem.position))
    : [];
  const assets = await assetSummaries(db, scope, [...rows, ...parts]);
  return rows.map((row) =>
    toItemDto(
      row,
      assets,
      parts.filter((p) => p.segmentId === row.id),
    ),
  );
}

async function assetSummaries(
  db: Executor,
  scope: StationScope,
  rows: Pick<Row, 'assetId'>[],
): Promise<Map<string, LogAssetSummary>> {
  const ids = [...new Set(rows.flatMap((r) => (r.assetId ? [r.assetId] : [])))];
  if (!ids.length) return new Map();
  const found = await db
    .select({
      id: asset.id,
      type: asset.type,
      title: asset.title,
      artists: asset.artists,
      durationMs: asset.durationMs,
    })
    .from(asset)
    .where(and(whereStation(asset, scope), inArray(asset.id, ids)));
  return new Map(found.map((a) => [a.id, a]));
}

function originOf(row: Row): LogItemOrigin {
  if (row.originType === 'clock') {
    return { type: 'clock', clockId: row.originClockId, slotIndex: row.originSlotIndex ?? 0 };
  }
  if (row.originType === 'show') return { type: 'show', showSlotId: row.originShowSlotId };
  return { type: 'manual' };
}

function toPartDto(row: Row, assets: Map<string, LogAssetSummary>): LogSegmentPart {
  return {
    id: row.id,
    logDayId: row.logDayId,
    position: row.position,
    kind: row.kind,
    plannedStart: row.plannedStart.toISOString(),
    plannedDurationMs: row.plannedDurationMs,
    assetId: row.assetId,
    asset: (row.assetId && assets.get(row.assetId)) || null,
    episodeId: row.episodeId,
    liveSlotId: row.liveSlotId,
    title: row.title,
    cueOverrides: row.cueOverrides ?? null,
    timing: row.timing,
    anchorAt: row.anchorAt?.toISOString() ?? null,
    capMs: row.capMs,
    origin: originOf(row),
    locked: row.locked,
    relaxedRules: row.relaxedRules,
    segmentId: row.segmentId,
  };
}

function toItemDto(row: Row, assets: Map<string, LogAssetSummary>, parts: Row[]): LogItem {
  return { ...toPartDto(row, assets), parts: parts.map((p) => toPartDto(p, assets)) };
}

export function toDayDto(day: DayRow): LogDay {
  return {
    id: day.id,
    stationId: day.stationId,
    localDate: day.localDate,
    startsAt: day.startsAt.toISOString(),
    endsAt: day.endsAt.toISOString(),
    status: day.status,
    version: day.version,
    generatedAt: day.generatedAt?.toISOString() ?? null,
    seed: day.seed,
    generatorVersion: day.generatorVersion,
  };
}

// --- Edits -------------------------------------------------------------------------------

/** `POST …/log/items`. */
export async function insertLogItem(
  db: Db,
  ctx: StationContext,
  placement: LogPlacement,
  input: LogItemInput,
): Promise<LogEditOutcome> {
  const parsed = logItemInputSchema.parse(input);
  return withAudit(db, ctx, async (tx, audit) => {
    await checkAssets(tx, ctx.scope, parsed);
    const target = await resolvePlacement(tx, ctx.scope, placement);
    const layout = await loadDays(tx, ctx.scope, [target.day]);
    const group = await newGroup(tx, ctx.scope, target.day.id, parsed, { type: 'manual' }, []);
    layout.groups(target.day.id).splice(target.index(layout), 0, group);
    const changed = await layout.persist(tx);
    const [head] = group;
    if (!head) throw new Error('empty group');
    await audit({
      action: 'log_item.insert',
      entity: { type: 'log_item', id: head.id },
      diff: auditDiff(null, auditable(layout.row(head.id))),
    });
    return outcome(tx, ctx.scope, layout, head.id, 'inserted', changed);
  });
}

/** `PUT …/log/items/:itemId`: new content, same place. The item becomes `manual`. */
export async function replaceLogItem(
  db: Db,
  ctx: StationContext,
  itemId: string,
  input: LogItemInput,
): Promise<LogEditOutcome> {
  const parsed = logItemInputSchema.parse(input);
  return withAudit(db, ctx, async (tx, audit) => {
    await checkAssets(tx, ctx.scope, parsed);
    const before = await editableItem(tx, ctx.scope, itemId, { unlocked: true });
    const day = await dayOf(tx, ctx.scope, before.logDayId);
    const layout = await loadDays(tx, ctx.scope, [day]);
    const groups = layout.groups(day.id);
    const index = groups.findIndex((g) => g[0]?.id === itemId);
    const oldParts = groups[index]?.slice(1) ?? [];
    if (oldParts.length) {
      await tx.delete(logItem).where(
        and(
          whereStation(logItem, ctx.scope),
          inArray(
            logItem.id,
            oldParts.map((p) => p.id),
          ),
        ),
      );
    }
    const replaced: Row = {
      ...before,
      ...columnsOf(parsed, { type: 'manual' }, []),
    };
    const parts = await newParts(tx, ctx.scope, day.id, replaced, parsed, { type: 'manual' });
    groups[index] = [replaced, ...parts];
    layout.markContentChanged(itemId);
    const changed = await layout.persist(tx, oldParts);
    await audit({
      action: 'log_item.replace',
      entity: { type: 'log_item', id: itemId },
      diff: auditDiff(auditable(before), auditable(layout.row(itemId))),
    });
    return outcome(tx, ctx.scope, layout, itemId, 'replaced', changed);
  });
}

/** `POST …/log/items/:itemId/move`. A segment moves with its parts. */
export async function moveLogItem(
  db: Db,
  ctx: StationContext,
  itemId: string,
  placement: LogPlacement,
): Promise<LogEditOutcome> {
  return withAudit(db, ctx, async (tx, audit) => {
    const before = await editableItem(tx, ctx.scope, itemId, { unlocked: true });
    if (
      ('after' in placement && placement.after === itemId) ||
      ('before' in placement && placement.before === itemId)
    ) {
      throw new HttpError(400, 'invalid_placement', 'an item cannot be placed next to itself');
    }
    const fromDay = await dayOf(tx, ctx.scope, before.logDayId);
    const target = await resolvePlacement(tx, ctx.scope, placement);
    const layout = await loadDays(tx, ctx.scope, [fromDay, target.day]);
    const source = layout.groups(fromDay.id);
    const [group] = source.splice(
      source.findIndex((g) => g[0]?.id === itemId),
      1,
    );
    if (!group) throw new NotFoundError('log_item', itemId);
    for (const row of group) row.logDayId = target.day.id;
    layout.groups(target.day.id).splice(target.index(layout), 0, group);
    const changed = await layout.persist(tx);
    await audit({
      action: 'log_item.move',
      entity: { type: 'log_item', id: itemId },
      diff: auditDiff(auditable(before), auditable(layout.row(itemId))),
    });
    return outcome(tx, ctx.scope, layout, itemId, 'moved', changed);
  });
}

/** `DELETE …/log/items/:itemId`. A segment goes with its parts. */
export async function deleteLogItem(
  db: Db,
  ctx: StationContext,
  itemId: string,
): Promise<LogEditOutcome> {
  return withAudit(db, ctx, async (tx, audit) => {
    const before = await editableItem(tx, ctx.scope, itemId, { unlocked: true });
    const day = await dayOf(tx, ctx.scope, before.logDayId);
    const layout = await loadDays(tx, ctx.scope, [day]);
    const groups = layout.groups(day.id);
    const [group] = groups.splice(
      groups.findIndex((g) => g[0]?.id === itemId),
      1,
    );
    if (!group) throw new NotFoundError('log_item', itemId);
    await tx.delete(logItem).where(
      and(
        whereStation(logItem, ctx.scope),
        inArray(
          logItem.id,
          group.map((r) => r.id),
        ),
      ),
    );
    const changed = await layout.persist(tx, group);
    await audit({
      action: 'log_item.delete',
      entity: { type: 'log_item', id: itemId },
      diff: auditDiff(auditable(before), null),
    });
    return outcome(tx, ctx.scope, layout, itemId, 'deleted', changed, before.logDayId);
  });
}

/** `PUT …/log/items/:itemId/lock`. Locking a segment locks the whole segment. */
export async function lockLogItem(
  db: Db,
  ctx: StationContext,
  itemId: string,
  locked: boolean,
): Promise<LogEditOutcome> {
  return withAudit(db, ctx, async (tx, audit) => {
    const before = await editableItem(tx, ctx.scope, itemId, { unlocked: false });
    const day = await dayOf(tx, ctx.scope, before.logDayId);
    const layout = await loadDays(tx, ctx.scope, [day]);
    const group = layout.groups(day.id).find((g) => g[0]?.id === itemId) ?? [];
    for (const row of group) {
      if (row.locked === locked) continue;
      row.locked = locked;
      layout.markContentChanged(row.id);
    }
    const changed = await layout.persist(tx);
    await audit({
      action: locked ? 'log_item.lock' : 'log_item.unlock',
      entity: { type: 'log_item', id: itemId },
      diff: auditDiff({ locked: before.locked }, { locked }),
    });
    return outcome(tx, ctx.scope, layout, itemId, locked ? 'locked' : 'unlocked', changed);
  });
}

// --- Bulk day writes (fixture, generator) ------------------------------------------------

/** One item of a bulk day write: an edit input plus where it came from. */
export type LogDayItemInput = LogItemInput & {
  origin: LogItemOrigin;
  relaxedRules?: RelaxedRule[];
};

export interface WriteLogDayInput {
  localDate: LocalDate;
  status: LogDayStatus;
  items: LogDayItemInput[];
  generatedAt?: Date | null;
  seed?: string | null;
  generatorVersion?: string | null;
  cause: LogUpdateCause;
}

export interface WriteLogDayOutcome {
  day: LogDay;
  /** Planned range of the day's items (or the day itself when empty). */
  range: { from: Date; to: Date };
  itemCount: number;
}

/**
 * Replaces a whole day: creates it if needed, deletes its items, writes `items` retimed from
 * the day's start, bumps its version. Locked items are not kept: the caller (generator) merges
 * them into `items` itself.
 */
export async function writeLogDay(
  db: Db,
  ctx: StationContext,
  input: WriteLogDayInput,
): Promise<WriteLogDayOutcome> {
  const items = input.items.map((item) => ({
    parsed: logItemInputSchema.parse(item),
    origin: item.origin,
    relaxedRules: item.relaxedRules ?? [],
  }));
  return withAudit(db, ctx, async (tx, audit) => {
    await checkAssets(tx, ctx.scope, ...items.map((i) => i.parsed));
    const existing = await findDay(tx, ctx.scope, input.localDate);
    const day = existing ?? (await createDay(tx, ctx.scope, input.localDate));
    await tx
      .delete(logItem)
      .where(and(whereStation(logItem, ctx.scope), eq(logItem.logDayId, day.id)));

    const groups: NewRow[][] = [];
    const ids = await newIds(
      tx,
      items.reduce((n, i) => n + 1 + (i.parsed.parts?.length ?? 0), 0),
    );
    for (const item of items) {
      const head: NewRow = {
        ...base(ctx.scope, day.id),
        id: ids.pop(),
        position: 0,
        ...columnsOf(item.parsed, item.origin, item.relaxedRules),
      };
      const parts = (item.parsed.parts ?? []).map((part) => ({
        ...base(ctx.scope, day.id),
        id: ids.pop(),
        position: 0,
        ...partColumns(head, part, item.origin),
      }));
      groups.push([head, ...parts]);
    }
    const rows = groups.flat();
    const timed = retime(rows as Row[], day.startsAt);
    rows.forEach((row, position) => {
      const t = timed[position];
      if (!t) return;
      Object.assign(row, { position, ...t });
    });
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(logItem).values(rows.slice(i, i + 500));
    }

    const [updated] = await tx
      .update(logDay)
      .set({
        status: input.status,
        version: existing ? sql`${logDay.version} + 1` : 1,
        generatedAt: input.generatedAt ?? null,
        seed: input.seed ?? null,
        generatorVersion: input.generatorVersion ?? null,
      })
      .where(and(whereStation(logDay, ctx.scope), eq(logDay.id, day.id)))
      .returning();
    if (!updated) throw new NotFoundError('log_day', day.id);
    await audit({
      action: 'log_day.write',
      entity: { type: 'log_day', id: day.id },
      diff: {
        cause: { from: null, to: input.cause },
        items: { from: null, to: rows.length },
        version: { from: existing?.version ?? null, to: updated.version },
      },
    });
    const first = timed[0];
    const ends = timed.map((t) => t.plannedStart.getTime() + t.plannedDurationMs);
    return {
      day: toDayDto(updated),
      itemCount: rows.length,
      range: {
        from: first ? first.plannedStart : updated.startsAt,
        to: new Date(Math.max(updated.endsAt.getTime(), ...ends)),
      },
    };
  });
}

/** Number of items in a local day's log (0 when the day doesn't exist). */
export async function logDayItemCount(
  db: Executor,
  scope: StationScope,
  localDate: LocalDate,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(logItem)
    .innerJoin(logDay, eq(logDay.id, logItem.logDayId))
    .where(and(whereStation(logDay, scope), eq(logDay.localDate, localDate)));
  return row?.n ?? 0;
}

// --- Helpers -----------------------------------------------------------------------------

function base(scope: StationScope, logDayId: string) {
  return { orgId: scope.orgId, stationId: scope.stationId, logDayId };
}

/** Columns of a top-level item from its input (timing is computed later). */
function columnsOf(parsed: ParsedLogItemInput, origin: LogItemOrigin, relaxedRules: RelaxedRule[]) {
  return {
    kind: parsed.kind,
    plannedDurationMs: parsed.kind === 'segment' ? 0 : parsed.plannedDurationMs,
    // The start is recomputed by retime(); a placeholder keeps the column non-null.
    plannedStart: new Date(0),
    assetId: parsed.assetId ?? null,
    episodeId: parsed.episodeId ?? null,
    liveSlotId: parsed.liveSlotId ?? null,
    title: parsed.title ?? null,
    cueOverrides: parsed.cueOverrides ?? null,
    timing: parsed.timing,
    anchorAt: parsed.anchorAt ? new Date(parsed.anchorAt) : null,
    capMs: parsed.capMs ?? null,
    locked: parsed.locked,
    relaxedRules,
    segmentId: null,
    ...originColumns(origin),
  };
}

function partColumns(
  head: Pick<NewRow, 'id' | 'locked'>,
  part: NonNullable<ParsedLogItemInput['parts']>[number],
  origin: LogItemOrigin,
) {
  return {
    kind: part.kind,
    plannedDurationMs: part.plannedDurationMs,
    plannedStart: new Date(0),
    assetId: part.assetId,
    episodeId: null,
    liveSlotId: null,
    title: part.title ?? null,
    cueOverrides: part.cueOverrides ?? null,
    timing: 'flow' as const,
    anchorAt: null,
    capMs: null,
    locked: head.locked ?? false,
    relaxedRules: [],
    segmentId: head.id ?? null,
    ...originColumns(origin),
  };
}

function originColumns(origin: LogItemOrigin) {
  return {
    originType: origin.type,
    originClockId: origin.type === 'clock' ? origin.clockId : null,
    originSlotIndex: origin.type === 'clock' ? origin.slotIndex : null,
    originShowSlotId: origin.type === 'show' ? origin.showSlotId : null,
  };
}

/** Ids for rows about to be inserted (uuidv7, like the column default). */
async function newIds(tx: Tx, count: number): Promise<string[]> {
  if (count === 0) return [];
  const rows = await tx.execute<{ id: string }>(
    sql`select uuidv7()::text as id from generate_series(1, ${count})`,
  );
  return [...rows].map((r) => r.id).reverse();
}

async function newGroup(
  tx: Tx,
  scope: StationScope,
  logDayId: string,
  parsed: ParsedLogItemInput,
  origin: LogItemOrigin,
  relaxedRules: RelaxedRule[],
): Promise<Row[]> {
  const [id] = await newIds(tx, 1);
  const head = {
    ...base(scope, logDayId),
    id,
    position: -1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...columnsOf(parsed, origin, relaxedRules),
  } as Row;
  return [head, ...(await newParts(tx, scope, logDayId, head, parsed, origin))];
}

async function newParts(
  tx: Tx,
  scope: StationScope,
  logDayId: string,
  head: Row,
  parsed: ParsedLogItemInput,
  origin: LogItemOrigin,
): Promise<Row[]> {
  const parts = parsed.parts ?? [];
  const ids = await newIds(tx, parts.length);
  return parts.map(
    (part) =>
      ({
        ...base(scope, logDayId),
        id: ids.pop(),
        position: -1,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...partColumns(head, part, origin),
      }) as Row,
  );
}

/** Refuses asset ids that are not this station's. */
async function checkAssets(tx: Tx, scope: StationScope, ...inputs: ParsedLogItemInput[]) {
  const ids = [
    ...new Set(
      inputs
        .flatMap((parsed) => [parsed.assetId, ...(parsed.parts ?? []).map((p) => p.assetId)])
        .filter((v) => !!v),
    ),
  ] as string[];
  if (!ids.length) return;
  const found = await tx
    .select({ id: asset.id })
    .from(asset)
    .where(and(whereStation(asset, scope), inArray(asset.id, ids)));
  if (found.length !== ids.length) {
    throw new HttpError(
      422,
      'unknown_asset',
      'an asset of this item is not in the station library',
    );
  }
}

async function findDay(tx: Executor, scope: StationScope, localDate: LocalDate) {
  const [day] = await tx
    .select()
    .from(logDay)
    .where(and(whereStation(logDay, scope), eq(logDay.localDate, localDate)))
    .for('update');
  return day;
}

async function createDay(tx: Tx, scope: StationScope, localDate: LocalDate): Promise<DayRow> {
  const [st] = await tx
    .select({ timezone: station.timezone })
    .from(station)
    .where(eq(station.id, scope.stationId));
  if (!st) throw new NotFoundError('station', scope.stationId);
  const bounds = localDayBounds(localDate, st.timezone);
  // A concurrent insert of the same day: take it.
  await tx
    .insert(logDay)
    .values({ orgId: scope.orgId, stationId: scope.stationId, localDate, ...bounds })
    .onConflictDoNothing({ target: [logDay.stationId, logDay.localDate] });
  const day = await findDay(tx, scope, localDate);
  if (!day) throw new NotFoundError('log_day', localDate);
  return day;
}

async function dayOf(tx: Tx, scope: StationScope, logDayId: string): Promise<DayRow> {
  const [day] = await tx
    .select()
    .from(logDay)
    .where(and(whereStation(logDay, scope), eq(logDay.id, logDayId)))
    .for('update');
  if (!day) throw new NotFoundError('log_day', logDayId);
  return day;
}

async function findItem(tx: Executor, scope: StationScope, itemId: string): Promise<Row> {
  const [row] = await tx
    .select()
    .from(logItem)
    .where(and(whereStation(logItem, scope), eq(logItem.id, itemId)));
  if (!row) throw new NotFoundError('log_item', itemId);
  return row;
}

/** An item that manual edits may target: not a segment part, and unlocked if asked. */
async function editableItem(
  tx: Tx,
  scope: StationScope,
  itemId: string,
  { unlocked }: { unlocked: boolean },
): Promise<Row> {
  const row = await findItem(tx, scope, itemId);
  if (row.segmentId) {
    throw new HttpError(409, 'segment_part', 'edit the segment this item is a part of');
  }
  if (unlocked && row.locked) {
    throw new HttpError(409, 'log_item_locked', 'the item is locked; unlock it first');
  }
  return row;
}

interface Target {
  day: DayRow;
  /** Index among the day's groups, once loaded (the anchor may move during a move). */
  index(layout: Layout): number;
}

async function resolvePlacement(
  tx: Tx,
  scope: StationScope,
  placement: LogPlacement,
): Promise<Target> {
  if ('localDate' in placement) {
    const day =
      (await findDay(tx, scope, placement.localDate)) ??
      (await createDay(tx, scope, placement.localDate));
    return { day, index: (layout) => layout.groups(day.id).length };
  }
  const anchorId = 'after' in placement ? placement.after : placement.before;
  const anchor = await findItem(tx, scope, anchorId).catch((error) => {
    if (error instanceof NotFoundError) {
      throw new HttpError(422, 'invalid_placement', 'the placement item does not exist');
    }
    throw error;
  });
  if (anchor.segmentId) {
    throw new HttpError(422, 'invalid_placement', 'place items next to a segment, not inside it');
  }
  const day = await dayOf(tx, scope, anchor.logDayId);
  const offset = 'after' in placement ? 1 : 0;
  return {
    day,
    index: (layout) => {
      const i = layout.groups(day.id).findIndex((g) => g[0]?.id === anchorId);
      if (i < 0) throw new HttpError(422, 'invalid_placement', 'the placement item moved');
      return i + offset;
    },
  };
}

/** Changed fields worth an audit diff. */
function auditable(row: Row) {
  return {
    logDayId: row.logDayId,
    position: row.position,
    kind: row.kind,
    plannedStart: row.plannedStart.toISOString(),
    plannedDurationMs: row.plannedDurationMs,
    assetId: row.assetId,
    episodeId: row.episodeId,
    liveSlotId: row.liveSlotId,
    title: row.title,
    cueOverrides: row.cueOverrides,
    timing: row.timing,
    anchorAt: row.anchorAt?.toISOString() ?? null,
    capMs: row.capMs,
    originType: row.originType,
    locked: row.locked,
  };
}

// --- Layout: a few days in memory, written back as a diff -------------------------------

interface Layout {
  groups(dayId: string): Row[][];
  row(id: string): Row;
  markContentChanged(id: string): void;
  /**
   * Retimes every loaded day, writes changed and new rows, bumps the days' versions. `removed`
   * rows (already deleted) count towards the changed range. Returns that range.
   */
  persist(tx: Tx, removed?: Row[]): Promise<{ from: Date; to: Date } | null>;
  days(): DayRow[];
}

async function loadDays(tx: Tx, scope: StationScope, days: DayRow[]): Promise<Layout> {
  const unique = [...new Map(days.map((d) => [d.id, d])).values()];
  const byDay = new Map<string, Row[][]>();
  const before = new Map<string, Row>();
  for (const day of unique) {
    const rows = await tx
      .select()
      .from(logItem)
      .where(and(whereStation(logItem, scope), eq(logItem.logDayId, day.id)))
      .orderBy(asc(logItem.position));
    const groups: Row[][] = [];
    for (const row of rows) {
      before.set(row.id, { ...row });
      if (row.segmentId && groups.at(-1)?.[0]?.id === row.segmentId) groups.at(-1)?.push(row);
      else groups.push([row]);
    }
    byDay.set(day.id, groups);
  }
  const contentChanged = new Set<string>();
  let current = unique;

  const all = () => [...byDay.values()].flat(2);
  return {
    groups: (dayId) => {
      const groups = byDay.get(dayId);
      if (!groups) throw new Error(`log day ${dayId} not loaded`);
      return groups;
    },
    row: (id) => {
      const row = all().find((r) => r.id === id);
      if (!row) throw new NotFoundError('log_item', id);
      return row;
    },
    markContentChanged: (id) => contentChanged.add(id),
    days: () => current,
    async persist(tx, removed = []) {
      const changed: Row[] = [];
      const inserted: Row[] = [];
      for (const day of unique) {
        const rows = (byDay.get(day.id) ?? []).flat();
        const timed = retime(rows, day.startsAt);
        rows.forEach((row, position) => {
          const t = timed[position];
          if (!t) return;
          row.position = position;
          row.logDayId = day.id;
          row.plannedStart = t.plannedStart;
          row.plannedDurationMs = t.plannedDurationMs;
          const old = before.get(row.id);
          if (!old) inserted.push(row);
          else if (
            contentChanged.has(row.id) ||
            old.position !== row.position ||
            old.logDayId !== row.logDayId ||
            old.plannedStart.getTime() !== row.plannedStart.getTime() ||
            old.plannedDurationMs !== row.plannedDurationMs
          ) {
            changed.push(row);
          }
        });
      }

      // Changed rows first go to negative positions, so no final position collides.
      const moved = changed.filter((r) => {
        const old = before.get(r.id);
        return old?.position !== r.position || old.logDayId !== r.logDayId;
      });
      for (const row of moved) {
        await tx
          .update(logItem)
          .set({ logDayId: row.logDayId, position: -1 - row.position })
          .where(and(whereStation(logItem, scope), eq(logItem.id, row.id)));
      }
      if (inserted.length) {
        await tx.insert(logItem).values(
          inserted.map((row) => {
            const { createdAt: _c, updatedAt: _u, ...values } = row;
            return values;
          }),
        );
      }
      for (const row of changed) {
        const { id, createdAt: _c, updatedAt: _u, orgId: _o, stationId: _s, ...values } = row;
        await tx
          .update(logItem)
          .set(values)
          .where(and(whereStation(logItem, scope), eq(logItem.id, id)));
      }

      const touched = [...changed, ...inserted];
      const span = [
        ...touched.map((r) => ({ start: r.plannedStart, ms: r.plannedDurationMs })),
        ...touched.flatMap((r) => {
          const old = before.get(r.id);
          return old ? [{ start: old.plannedStart, ms: old.plannedDurationMs }] : [];
        }),
        ...removed.map((r) => ({ start: r.plannedStart, ms: r.plannedDurationMs })),
      ];
      current = [];
      for (const day of unique) {
        const [updated] = await tx
          .update(logDay)
          .set({ version: sql`${logDay.version} + 1` })
          .where(and(whereStation(logDay, scope), eq(logDay.id, day.id)))
          .returning();
        if (updated) current.push(updated);
      }
      if (!span.length) return null;
      return {
        from: new Date(Math.min(...span.map((s) => s.start.getTime()))),
        to: new Date(Math.max(...span.map((s) => s.start.getTime() + s.ms))),
      };
    },
  };
}

async function outcome(
  tx: Tx,
  scope: StationScope,
  layout: Layout,
  itemId: string,
  change: LogItemChange,
  changed: { from: Date; to: Date } | null,
  deletedFromDay?: string,
): Promise<LogEditOutcome> {
  const days = layout.days();
  if (change === 'deleted') {
    const logDayId = deletedFromDay ?? days[0]?.id ?? '';
    const range = changed ?? { from: new Date(), to: new Date() };
    return { result: { item: null, days: days.map(toDayDto) }, itemId, logDayId, change, range };
  }
  const row = layout.row(itemId);
  const [item] = await expand(tx, scope, [row]);
  if (!item) throw new NotFoundError('log_item', itemId);
  const own = {
    from: row.plannedStart,
    to: new Date(row.plannedStart.getTime() + row.plannedDurationMs),
  };
  return {
    result: { item, days: days.map(toDayDto) },
    itemId,
    logDayId: row.logDayId,
    change,
    range: changed ?? own,
  };
}
