import {
  type CurrentDay,
  type CurrentItem,
  type ExpandableSlot,
  expandSlots,
  type GeneratedDay,
  type GeneratorAsset,
  type GeneratorCategory,
  type GeneratorClock,
  type GeneratorEpisode,
  type GeneratorOccurrence,
  type GeneratorSnapshot,
  itemLengthMs,
  type KeepPolicy,
  type KeptItem,
  type KeptPin,
  type KeptReason,
  keepReasons,
  keptStart,
  type PlayedItem,
  planClockMusic,
  resolveCategory,
  retime,
  type SlotException,
  sameDay,
} from '@ondes/scheduling';
import {
  type AssetType,
  addDays,
  assetTypeSchema,
  type Category,
  type CategoryRule,
  type ClockSlot,
  clockSlotSchema,
  DEFAULT_ROTATION_RULES,
  type LocalDate,
  type LogDayStatus,
  type LogItemInput,
  type LogItemOrigin,
  type LogTimingConflict,
  localDateOf,
  localDayBounds,
  logDayItemInputSchema,
  type RotationRule,
  rotationRulesSchema,
  type TagKey,
} from '@ondes/shared';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { type MutationContext, withAudit, writeAudit } from '../audit.ts';
import type { Db, Executor, Tx } from '../client.ts';
import { asRunEntry } from '../schema/asrun.ts';
import { clock, clockGrid, clockGridCell, clockGridOverride, clockSlot } from '../schema/clocks.ts';
import { logItemFallback } from '../schema/episode-check.ts';
import { asset, assetAnalysis, assetCues, assetTag, tag } from '../schema/library.ts';
import { logDay, logItem } from '../schema/log.ts';
import { logItemPin } from '../schema/regen.ts';
import { category, categoryMember, rotationRules } from '../schema/rotation.ts';
import { segue } from '../schema/segues.ts';
import { episode, show, showSlot, showSlotException } from '../schema/shows.ts';
import { station } from '../schema/tenancy.ts';
import { type StationScope, whereStation } from '../tenant.ts';
import { resolveRerun } from './reruns.ts';

// Log generator (#50, ADR 0026) queries, for the worker's `log-generate` job and the api's
// clock-music fallback: everything a station's days depend on, loaded into the pure
// generator's snapshot (`@ondes/scheduling`), and the generated day written back. The api's
// own log edits live in apps/api/src/modules/log; this writer follows the same rules (retime,
// the following day's first item, version bump, audit), and keeps kept items' ids.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** History around the days: a week for weekly caps, a day for "same hour yesterday". */
const HISTORY_MS = 8 * DAY;
/** Older airings: the longest rest or separation plus this (like the api's picker). */
const OLDER_MARGIN_MS = 30 * DAY;

// --- Snapshot ------------------------------------------------------------------------------

/**
 * The episode a rerun occurrence plays again (#48). The default, `slotRerun`, follows the
 * slot's `rerun_strategy` / `rerun_episode_id` through #48's `resolveRerun`.
 */
export type RerunResolver = (
  db: Executor,
  scope: StationScope,
  occurrence: { slotId: string; showId: string; date: LocalDate; startsAt: Date },
) => Promise<{ episodeId: string } | null>;

export interface GeneratorLoadOptions {
  /** Consecutive station-local dates. */
  dates: readonly LocalDate[];
  /** What already aired is before `now`; what is planned is after. Default: the clock. */
  now?: Date;
  /**
   * `regenerate` (the job): the days' current items are replaced, so they're left out of the
   * history, and those that must survive are returned as kept items. `around` (clock music):
   * the days stay, their items count as history.
   */
  mode?: 'regenerate' | 'around';
  /** Items left out of the history (`around`: the empty item clock music replaces). */
  ignoreItemIds?: readonly string[];
  rerun?: RerunResolver;
  /**
   * `regenerate` only: what else is kept beyond locked items, segue ends and fallback marks
   * (#101's policy: items before the freeze point, manual edits, `regenPolicy`).
   */
  keep?: KeepPolicy;
}

export interface LoadedSnapshot {
  snapshot: GeneratorSnapshot;
  /** The existing log days among `dates`. */
  days: Map<LocalDate, { id: string; status: LogDayStatus; version: number }>;
  /** `regenerate` only: the existing days as they are (items in position order), for diffs. */
  current: Map<LocalDate, CurrentDay>;
  /** `regenerate` only: why each kept item stays. */
  keptReasons: Map<string, KeptReason[]>;
}

/** Loads the generator's snapshot for `dates`. Null when the station is gone. */
export async function loadGeneratorSnapshot(
  db: Db,
  scope: StationScope,
  options: GeneratorLoadOptions,
): Promise<LoadedSnapshot | null> {
  const dates = options.dates;
  const first = dates[0];
  const last = dates.at(-1);
  if (!first || !last) throw new Error('no dates to generate');
  const now = options.now ?? new Date();
  const mode = options.mode ?? 'regenerate';
  const [st] = await db
    .select({ timezone: station.timezone })
    .from(station)
    .where(and(eq(station.id, scope.stationId), eq(station.orgId, scope.orgId)));
  if (!st) return null;
  const timeZone = st.timezone;
  const from = localDayBounds(first, timeZone).startsAt;
  const to = localDayBounds(last, timeZone).endsAt;

  const [library, rules, clocks, grid, dayRows] = await Promise.all([
    loadLibrary(db, scope),
    loadRules(db, scope),
    loadClocks(db, scope),
    loadGrid(db, scope),
    db
      .select({
        id: logDay.id,
        localDate: logDay.localDate,
        status: logDay.status,
        version: logDay.version,
        startsAt: logDay.startsAt,
        seed: logDay.seed,
        generatorVersion: logDay.generatorVersion,
      })
      .from(logDay)
      .where(and(whereStation(logDay, scope), inArray(logDay.localDate, [...dates])))
      .orderBy(asc(logDay.localDate)),
  ]);
  const byId = new Map(library.map((a) => [a.id, a]));
  const categories = await loadCategories(db, scope, library, from);
  const occurrences = await loadOccurrences(db, scope, byId, timeZone, { from, to }, options);
  const days = new Map(
    dayRows.map((d) => [d.localDate, { id: d.id, status: d.status, version: d.version }]),
  );
  const dayIds = dayRows.map((d) => d.id);

  const span = Math.max(HISTORY_MS, longestRuleMs(rules, categories));
  const historyFrom = new Date(from.getTime() - span);
  const historyTo = new Date(to.getTime() + span);
  const excluded = mode === 'regenerate' ? dayIds : [];
  const [history, kept, lastPlayedAt, previousDayEnd] = await Promise.all([
    loadHistory(
      db,
      scope,
      byId,
      historyFrom,
      historyTo,
      now,
      excluded,
      options.ignoreItemIds ?? [],
    ),
    mode === 'regenerate'
      ? loadKept(db, scope, byId, dayRows, options.keep)
      : { kept: new Map<LocalDate, KeptItem[]>(), current: new Map(), reasons: new Map() },
    olderAirings(db, scope, historyFrom, span + OLDER_MARGIN_MS),
    previousEnd(db, scope, from),
  ]);

  return {
    snapshot: {
      stationId: scope.stationId,
      timeZone,
      grid,
      clocks,
      categories,
      assets: byId,
      rules,
      history,
      lastPlayedAt,
      occurrences,
      kept: kept.kept,
      previousDayEnd,
    },
    days,
    current: kept.current,
    keptReasons: kept.reasons,
  };
}

const assetTypes = new Set<string>(assetTypeSchema.options);
const typeOf = (kind: string | null): AssetType | null =>
  kind && assetTypes.has(kind) ? (kind as AssetType) : null;

/** The station's assets as the generator sees them, in library order. */
async function loadLibrary(db: Executor, scope: StationScope): Promise<GeneratorAsset[]> {
  const [base, extra] = await Promise.all([
    db
      .select({
        id: asset.id,
        type: asset.type,
        title: asset.title,
        artists: asset.artists,
        year: asset.year,
        explicit: asset.explicit,
        durationMs: asset.durationMs,
        startAt: asset.startAt,
        killAt: asset.killAt,
        addedAt: asset.createdAt,
        tags: sql<{ key: TagKey; value: string }[]>`coalesce(
          json_agg(json_build_object('key', ${tag.key}, 'value', ${tag.value}))
            filter (where ${tag.id} is not null),
          '[]'::json)`,
      })
      .from(asset)
      .leftJoin(assetTag, eq(assetTag.assetId, asset.id))
      .leftJoin(tag, eq(tag.id, assetTag.tagId))
      .where(whereStation(asset, scope))
      .groupBy(asset.id)
      .orderBy(
        sql`lower(coalesce(${asset.artists}[1], ''))`,
        sql`lower(${asset.title})`,
        asc(asset.id),
      ),
    db
      .select({
        id: asset.id,
        album: asset.album,
        bpm: assetAnalysis.bpm,
        energy: assetAnalysis.energy,
        sampleRate: assetCues.sampleRate,
        cueIn: assetCues.cueIn,
        cueOut: assetCues.cueOut,
        crossStartNext: assetCues.crossStartNext,
      })
      .from(asset)
      .leftJoin(assetAnalysis, eq(assetAnalysis.assetId, asset.id))
      .leftJoin(assetCues, eq(assetCues.assetId, asset.id))
      .where(whereStation(asset, scope)),
  ]);
  const extras = new Map(extra.map((e) => [e.id, e]));
  return base.map((a) => {
    const e = extras.get(a.id);
    return {
      ...a,
      album: e?.album ?? null,
      bpm: e?.bpm ?? null,
      energy: e?.energy ?? null,
      ...playRange({
        sampleRate: e?.sampleRate ?? null,
        cueIn: e?.cueIn ?? null,
        cueOut: e?.cueOut ?? null,
        crossStartNext: e?.crossStartNext ?? null,
      }),
    };
  });
}

async function loadRules(db: Executor, scope: StationScope): Promise<RotationRule[]> {
  const [row] = await db.select().from(rotationRules).where(whereStation(rotationRules, scope));
  return row ? rotationRulesSchema.parse(row.rules) : DEFAULT_ROTATION_RULES;
}

/** Categories with their members resolved at `at` (membership is never stored, ADR 0013). */
async function loadCategories(
  db: Executor,
  scope: StationScope,
  library: GeneratorAsset[],
  at: Date,
): Promise<Map<string, GeneratorCategory>> {
  const [rows, entries] = await Promise.all([
    db.select().from(category).where(whereStation(category, scope)).orderBy(asc(category.id)),
    db
      .select({
        categoryId: categoryMember.categoryId,
        assetId: categoryMember.assetId,
        mode: categoryMember.mode,
      })
      .from(categoryMember)
      .where(whereStation(categoryMember, scope))
      .orderBy(asc(categoryMember.createdAt), asc(categoryMember.assetId)),
  ]);
  const out = new Map<string, GeneratorCategory>();
  for (const row of rows) {
    const members = entries
      .filter((e) => e.categoryId === row.id)
      .map((e) => ({ assetId: e.assetId, mode: e.mode }));
    const resolved = resolveCategory(
      { assetType: row.assetType, rule: (row.rule ?? null) as CategoryRule | null, members },
      library,
      at,
    );
    out.set(row.id, {
      id: row.id,
      assetType: row.assetType,
      rotationOrder: row.rotationOrder as Category['rotationOrder'],
      searchDepthPercent: row.searchDepthPercent,
      restMinutes: row.restMinutes,
      maxPlaysPerDay: row.maxPlaysPerDay,
      maxPlaysPerWeek: row.maxPlaysPerWeek,
      members: resolved.members.map((m) => m.asset),
    });
  }
  return out;
}

function toSlot(row: typeof clockSlot.$inferSelect): ClockSlot {
  // Like the clocks module's: checked against the contract, columns by kind.
  return clockSlotSchema.parse({
    kind: row.kind,
    label: row.label,
    durationMs: row.durationMs,
    ...(row.kind === 'asset' ? { assetId: row.assetId } : {}),
    ...(['category', 'jingle', 'fill', 'vt'].includes(row.kind)
      ? { categoryId: row.categoryId }
      : {}),
    ...(row.kind === 'vt' ? { mode: row.vtMode } : {}),
    ...(row.kind === 'marker'
      ? { timing: row.timing, offsetMs: row.offsetMs, capMs: row.capMs }
      : {}),
  });
}

async function loadClocks(db: Executor, scope: StationScope): Promise<Map<string, GeneratorClock>> {
  const [clocks, slots] = await Promise.all([
    db
      .select({ id: clock.id, targetDurationMs: clock.targetDurationMs })
      .from(clock)
      .where(whereStation(clock, scope))
      .orderBy(asc(clock.id)),
    db
      .select()
      .from(clockSlot)
      .where(whereStation(clockSlot, scope))
      .orderBy(asc(clockSlot.clockId), asc(clockSlot.position)),
  ]);
  return new Map(
    clocks.map((c) => [c.id, { ...c, slots: slots.filter((s) => s.clockId === c.id).map(toSlot) }]),
  );
}

/** The weekly grid (#40), as `expandGrid` reads it. */
async function loadGrid(db: Executor, scope: StationScope) {
  const [[header], cells, overrides] = await Promise.all([
    db
      .select({ defaultClockId: clockGrid.defaultClockId })
      .from(clockGrid)
      .where(whereStation(clockGrid, scope)),
    db
      .select({
        weekday: clockGridCell.weekday,
        hour: clockGridCell.hour,
        clockId: clockGridCell.clockId,
      })
      .from(clockGridCell)
      .where(whereStation(clockGridCell, scope))
      .orderBy(asc(clockGridCell.weekday), asc(clockGridCell.hour)),
    db
      .select({
        id: clockGridOverride.id,
        startsOn: clockGridOverride.startsOn,
        endsOn: clockGridOverride.endsOn,
        startHour: clockGridOverride.startHour,
        endHour: clockGridOverride.endHour,
        clockId: clockGridOverride.clockId,
      })
      .from(clockGridOverride)
      .where(whereStation(clockGridOverride, scope))
      .orderBy(asc(clockGridOverride.startsOn), asc(clockGridOverride.id)),
  ]);
  return { defaultClockId: header?.defaultClockId ?? null, cells, overrides };
}

type SlotRow = ExpandableSlot & {
  showId: string;
  showName: string;
  type: GeneratorOccurrence['type'];
};

/** Show occurrences overlapping `range`, with the episode each airs (#44, #48). */
async function loadOccurrences(
  db: Executor,
  scope: StationScope,
  library: Map<string, GeneratorAsset>,
  timeZone: string,
  range: { from: Date; to: Date },
  options: GeneratorLoadOptions,
): Promise<GeneratorOccurrence[]> {
  // Slots whose dates can reach the range (moves are at most a week, slots at most a day).
  const firstDate = addDays(options.dates[0] as LocalDate, -9);
  const lastDate = addDays(options.dates.at(-1) as LocalDate, 8);
  const rows = await db
    .select({
      id: showSlot.id,
      showId: showSlot.showId,
      showName: show.name,
      type: showSlot.type,
      rule: showSlot.rule,
      durationMs: showSlot.durationMs,
    })
    .from(showSlot)
    .innerJoin(show, eq(show.id, showSlot.showId))
    .where(
      and(
        whereStation(showSlot, scope),
        sql`${showSlot.startsOn} <= ${lastDate}`,
        or(isNull(showSlot.endsOn), gte(showSlot.endsOn, firstDate)),
      ),
    )
    .orderBy(asc(showSlot.id));
  if (rows.length === 0) return [];
  const exceptions = await db
    .select()
    .from(showSlotException)
    .where(
      and(
        whereStation(showSlotException, scope),
        inArray(
          showSlotException.slotId,
          rows.map((r) => r.id),
        ),
      ),
    );
  const slots: SlotRow[] = rows.map((r) => ({
    ...r,
    exceptions: exceptions
      .filter((e) => e.slotId === r.id)
      .map(
        (e): SlotException =>
          e.kind === 'cancelled'
            ? { date: e.date, kind: 'cancelled' }
            : {
                date: e.date,
                kind: 'moved',
                startDate: e.startDate as LocalDate,
                startTime: e.startTime as string,
                durationMs: e.durationMs,
              },
      ),
  }));
  const expanded = expandSlots(slots, range, timeZone);
  const premieres = await premieresOf(db, scope, expanded);
  const rerun = options.rerun ?? slotRerun;
  const out: GeneratorOccurrence[] = [];
  for (const o of expanded) {
    let episodeRow: EpisodeRow | null = null;
    if (o.slot.type === 'prerecorded') {
      episodeRow = premieres.get(`${o.slot.id}:${o.date}`) ?? null;
    } else if (o.slot.type === 'rerun') {
      const found = await rerun(db, scope, {
        slotId: o.slot.id,
        showId: o.slot.showId,
        date: o.date,
        startsAt: o.startsAt,
      });
      episodeRow = found ? await episodeById(db, scope, found.episodeId) : null;
    }
    const episodeOf = (row: EpisodeRow): GeneratorEpisode => ({
      id: row.id,
      title: row.title,
      asset: row.assetId ? (library.get(row.assetId) ?? null) : null,
    });
    out.push({
      slotId: o.slot.id,
      showId: o.slot.showId,
      showName: o.slot.showName,
      type: o.slot.type,
      date: o.date,
      startsAt: o.startsAt,
      durationMs: o.durationMs,
      special: o.moved || o.slot.rule.freq === 'once',
      episode: episodeRow ? episodeOf(episodeRow) : null,
    });
  }
  return out;
}

type EpisodeRow = { id: string; title: string | null; assetId: string | null };

async function premieresOf(
  db: Executor,
  scope: StationScope,
  occurrences: { slot: { id: string }; date: LocalDate }[],
): Promise<Map<string, EpisodeRow>> {
  const out = new Map<string, EpisodeRow>();
  if (occurrences.length === 0) return out;
  const rows = await db
    .select({
      id: episode.id,
      title: episode.title,
      assetId: episode.assetId,
      slotId: episode.slotId,
      occurrenceDate: episode.occurrenceDate,
    })
    .from(episode)
    .where(
      and(
        whereStation(episode, scope),
        inArray(episode.slotId, [...new Set(occurrences.map((o) => o.slot.id))]),
        inArray(episode.occurrenceDate, [...new Set(occurrences.map((o) => o.date))]),
      ),
    );
  for (const r of rows) out.set(`${r.slotId}:${r.occurrenceDate}`, r);
  return out;
}

async function episodeById(db: Executor, scope: StationScope, id: string) {
  const [row] = await db
    .select({ id: episode.id, title: episode.title, assetId: episode.assetId })
    .from(episode)
    .where(and(whereStation(episode, scope), eq(episode.id, id)));
  return row ?? null;
}

/** The default rerun: the slot's own strategy (#48, `packages/db/src/repos/reruns.ts`). */
export const slotRerun: RerunResolver = (db, scope, o) =>
  resolveRerun(db, scope, { slotId: o.slotId, occurrenceDate: o.date, startsAt: o.startsAt });

function longestRuleMs(rules: RotationRule[], categories: Map<string, GeneratorCategory>): number {
  let max = 0;
  for (const r of rules) {
    if ('unit' in r && r.unit === 'minutes') max = Math.max(max, r.value * MINUTE);
  }
  for (const c of categories.values()) max = Math.max(max, c.restMinutes * MINUTE);
  return max;
}

function played(
  library: Map<string, GeneratorAsset>,
  row: { assetId: string | null; kind: string | null; title: string | null; at: Date },
  artists: readonly string[] | null,
): PlayedItem {
  const known = row.assetId ? library.get(row.assetId) : undefined;
  return {
    assetId: row.assetId,
    type: known?.type ?? typeOf(row.kind),
    title: row.title ?? known?.title ?? null,
    artists: artists && artists.length > 0 ? artists : (known?.artists ?? []),
    album: known?.album ?? null,
    tags: known?.tags ?? [],
    bpm: known?.bpm ?? null,
    energy: known?.energy ?? null,
    at: row.at,
  };
}

/**
 * What aired in `[from, now)` (as-run) and what is planned in `[now, to)` (log items with an
 * asset, outside the excluded days), as the rules see it (like the api's picker).
 */
async function loadHistory(
  db: Executor,
  scope: StationScope,
  library: Map<string, GeneratorAsset>,
  from: Date,
  to: Date,
  now: Date,
  excludedDayIds: readonly string[],
  ignoreItemIds: readonly string[],
): Promise<PlayedItem[]> {
  const [aired, planned] = await Promise.all([
    from < now
      ? db
          .select({
            assetId: asRunEntry.assetId,
            kind: asRunEntry.kind,
            title: asRunEntry.title,
            artists: asRunEntry.artists,
            at: asRunEntry.startedAt,
          })
          .from(asRunEntry)
          .where(
            and(
              whereStation(asRunEntry, scope),
              gte(asRunEntry.startedAt, from),
              lt(asRunEntry.startedAt, now < to ? now : to),
            ),
          )
          .orderBy(asc(asRunEntry.startedAt), asc(asRunEntry.id))
      : [],
    to > now
      ? db
          .select({
            assetId: logItem.assetId,
            kind: logItem.kind,
            title: logItem.title,
            at: logItem.plannedStart,
          })
          .from(logItem)
          .where(
            and(
              whereStation(logItem, scope),
              isNotNull(logItem.assetId),
              excludedDayIds.length ? notInArray(logItem.logDayId, [...excludedDayIds]) : undefined,
              ignoreItemIds.length ? notInArray(logItem.id, [...ignoreItemIds]) : undefined,
              gte(logItem.plannedStart, from > now ? from : now),
              lt(logItem.plannedStart, to),
            ),
          )
          .orderBy(asc(logItem.plannedStart), asc(logItem.id))
      : [],
  ]);
  return [
    ...aired.map((r) => played(library, r, r.artists)),
    ...planned.map((r) => played(library, r, null)),
  ];
}

/** Each asset's last airing before `before`, within `lookbackMs`. */
async function olderAirings(
  db: Executor,
  scope: StationScope,
  before: Date,
  lookbackMs: number,
): Promise<Map<string, Date>> {
  const rows = await db
    .select({ assetId: asRunEntry.assetId, at: sql<string>`max(${asRunEntry.startedAt})::text` })
    .from(asRunEntry)
    .where(
      and(
        whereStation(asRunEntry, scope),
        isNotNull(asRunEntry.assetId),
        lt(asRunEntry.startedAt, before),
        gte(asRunEntry.startedAt, new Date(before.getTime() - lookbackMs)),
      ),
    )
    .groupBy(asRunEntry.assetId);
  return new Map(rows.map((r) => [r.assetId as string, new Date(r.at)]));
}

const endOf = sql`${logItem.plannedStart} + make_interval(secs => ${logItem.plannedDurationMs} / 1000.0)`;

/** Where the day ending at `dayStart` ends: its last top-level item's planned end. */
async function previousEnd(db: Executor, scope: StationScope, dayStart: Date) {
  const [row] = await db
    .select({ end: sql<string>`(${endOf})::text` })
    .from(logItem)
    .innerJoin(logDay, eq(logDay.id, logItem.logDayId))
    .where(and(whereStation(logDay, scope), eq(logDay.endsAt, dayStart), isNull(logItem.segmentId)))
    .orderBy(desc(logItem.position))
    .limit(1);
  return row ? new Date(row.end) : null;
}

/**
 * The items of the days being regenerated that survive with their ids: locked ones, both ends
 * of every segue (new ids would detach it, ADR 0017), those with a fallback mark (ADR 0022),
 * and what `policy` adds (#101). A kept segment keeps its parts. Kept items are planned around
 * their pin while they haven't moved since the last regeneration (`keptStart`). Also returns
 * the days as they are, for the dry-run's diff.
 */
async function loadKept(
  db: Executor,
  scope: StationScope,
  library: Map<string, GeneratorAsset>,
  days: {
    id: string;
    localDate: LocalDate;
    seed: string | null;
    generatorVersion: string | null;
  }[],
  policy: KeepPolicy = {},
) {
  const kept = new Map<LocalDate, KeptItem[]>();
  const current = new Map<LocalDate, CurrentDay>();
  const reasons = new Map<string, KeptReason[]>();
  const out = { kept, current, reasons };
  if (days.length === 0) return out;
  const dayIds = days.map((d) => d.id);
  const items = await db
    .select()
    .from(logItem)
    .where(and(whereStation(logItem, scope), inArray(logItem.logDayId, dayIds)))
    .orderBy(asc(logItem.logDayId), asc(logItem.position));
  const dateOf = new Map(days.map((d) => [d.id, d.localDate]));
  const currentItems = new Map<LocalDate, CurrentItem[]>(days.map((d) => [d.localDate, []]));
  for (const item of items)
    currentItems.get(dateOf.get(item.logDayId) as LocalDate)?.push(currentItemOf(item));
  for (const d of days) {
    current.set(d.localDate, {
      seed: d.seed,
      generatorVersion: d.generatorVersion,
      items: currentItems.get(d.localDate) ?? [],
    });
  }
  if (items.length === 0) return out;
  const { reasonsOf, markSlot } = await keepMarks(db, scope, items, policy);
  const heads = items.filter((item) => item.segmentId === null && reasonsOf(item).length > 0);
  const headIds = new Set(heads.map((h) => h.id));
  const keptRows = items.filter(
    (i) => headIds.has(i.id) || (i.segmentId !== null && headIds.has(i.segmentId)),
  );
  const pins = await loadPins(
    db,
    scope,
    keptRows.map((r) => r.id),
  );
  for (const item of heads) {
    const why = reasonsOf(item);
    const date = dateOf.get(item.logDayId) as LocalDate;
    const list = kept.get(date) ?? [];
    reasons.set(item.id, why);
    list.push(keptOf(item, why, markSlot.get(item.id) ?? null, library, pins.get(item.id)));
    // Its parts follow it.
    for (const part of items.filter((p) => p.segmentId === item.id)) {
      reasons.set(part.id, why);
      list.push(keptOf(part, why, null, library, pins.get(part.id)));
    }
    kept.set(date, list);
  }
  return out;
}

async function loadPins(db: Executor, scope: StationScope, ids: string[]) {
  if (ids.length === 0) return new Map<string, KeptPin>();
  const rows = await db
    .select()
    .from(logItemPin)
    .where(and(whereStation(logItemPin, scope), inArray(logItemPin.logItemId, ids)));
  return new Map(rows.map((r) => [r.logItemId, { start: r.start, settledStart: r.settledStart }]));
}

/** Why each of these items must survive a regeneration (none: it may be rewritten). */
async function keepMarks(
  db: Executor,
  scope: StationScope,
  items: { id: string; locked: boolean; plannedStart: Date; originType: LogItemOrigin['type'] }[],
  policy: KeepPolicy = {},
) {
  const ids = items.map((i) => i.id);
  const [segueEnds, marks] = ids.length
    ? await Promise.all([
        db
          .select({ from: segue.fromItemId, to: segue.toItemId })
          .from(segue)
          .where(
            and(
              whereStation(segue, scope),
              or(inArray(segue.fromItemId, ids), inArray(segue.toItemId, ids)),
            ),
          ),
        db
          .select({ itemId: logItemFallback.logItemId, slotId: logItemFallback.slotId })
          .from(logItemFallback)
          .where(
            and(whereStation(logItemFallback, scope), inArray(logItemFallback.logItemId, ids)),
          ),
      ])
    : [[], []];
  const inSegue = new Set(segueEnds.flatMap((s) => [s.from, s.to]).filter((x) => x !== null));
  const markSlot = new Map(marks.map((m) => [m.itemId, m.slotId]));
  const reasonsOf = (item: (typeof items)[number]): KeptReason[] =>
    keepReasons(
      {
        plannedStart: item.plannedStart,
        originType: item.originType,
        locked: item.locked,
        inSegue: inSegue.has(item.id),
        hasFallbackMark: markSlot.has(item.id),
      },
      policy,
    );
  return { reasonsOf, markSlot };
}

function originOf(row: typeof logItem.$inferSelect): LogItemOrigin {
  if (row.originType === 'clock') {
    return { type: 'clock', clockId: row.originClockId, slotIndex: row.originSlotIndex ?? 0 };
  }
  if (row.originType === 'show') return { type: 'show', showSlotId: row.originShowSlotId };
  return { type: 'manual' };
}

/** A stored item as `@ondes/scheduling`'s diff compares it. */
function currentItemOf(row: typeof logItem.$inferSelect): CurrentItem {
  return {
    id: row.id,
    position: row.position,
    kind: row.kind,
    plannedStart: row.plannedStart,
    plannedDurationMs: row.plannedDurationMs,
    assetId: row.assetId,
    episodeId: row.episodeId,
    liveSlotId: row.liveSlotId,
    title: row.title,
    cueOverrides: row.cueOverrides,
    timing: row.timing,
    anchorAt: row.anchorAt,
    capMs: row.capMs,
    origin: originOf(row),
    locked: row.locked,
    relaxedRules: row.relaxedRules,
    segmentId: row.segmentId,
    conflict:
      row.conflictKind && row.conflictMs ? { kind: row.conflictKind, ms: row.conflictMs } : null,
  };
}

/**
 * The day changed since its snapshot was loaded: an item became kept (locked, a segue end, a
 * fallback mark) or a kept one went away. Thrown before anything is written; the job's retry
 * loads a fresh snapshot.
 */
export class StaleGeneratorSnapshotError extends Error {
  constructor(localDate: LocalDate, ids: string[]) {
    super(`log day ${localDate} changed since its snapshot was loaded (items ${ids.join(', ')})`);
    this.name = 'StaleGeneratorSnapshotError';
  }
}

function keptOf(
  row: typeof logItem.$inferSelect,
  reasons: KeptReason[],
  fallbackSlot: string | null,
  library: Map<string, GeneratorAsset>,
  pin?: KeptPin,
): KeptItem {
  const plannedStart = keptStart(row.plannedStart, pin);
  return {
    id: row.id,
    kind: row.kind,
    plannedStart,
    plannedDurationMs: row.plannedDurationMs,
    timing: row.timing,
    anchorAt: row.anchorAt,
    segmentId: row.segmentId,
    crossOutMs: row.cueOverrides?.crossOutMs ?? null,
    showSlotId: fallbackSlot ?? row.originShowSlotId,
    reasons,
    played: row.assetId
      ? played(
          library,
          { assetId: row.assetId, kind: row.kind, title: row.title, at: row.plannedStart },
          null,
        )
      : null,
  };
}

// --- Writing a generated day ---------------------------------------------------------------

export interface WriteGeneratedDayOptions {
  /** Status of a day the write creates. An existing day keeps its own. Default `draft`. */
  status?: LogDayStatus;
  /** The keep policy the snapshot was loaded with (#101): the stale check applies it too. */
  keep?: KeepPolicy;
}

export interface WrittenDay {
  logDayId: string;
  localDate: LocalDate;
  version: number;
  itemCount: number;
  keptCount: number;
  /**
   * False when the generated day equals the day as it is (#101): nothing was written, no new
   * version, no audit row. Regenerating with the same seed and inputs is a no-op.
   */
  changed: boolean;
  /** Planned range of the day's items (the day itself when empty). */
  range: { from: Date; to: Date };
  /** The following day, when its first item's conflict changed (its version was bumped). */
  following: { logDayId: string; localDate: LocalDate; version: number } | null;
}

/**
 * Writes a generated day: creates the day if needed, deletes the items that aren't kept, keeps
 * the kept ones (same ids, new positions and times), inserts the new ones, bumps the version and
 * records the seed and generator version. The items are checked against the log contract. One
 * transaction, audited `log_day.generate`. A day that would come out the same isn't written
 * (`changed: false`). Kept items get a pin (`log_item_pin`): where they were planned around.
 */
export async function writeGeneratedDay(
  db: Db,
  ctx: MutationContext & { scope: StationScope },
  generated: GeneratedDay,
  options: WriteGeneratedDayOptions = {},
): Promise<WrittenDay> {
  const { scope } = ctx;
  const rows = generated.items.map((item) => {
    if (item.keptId !== null) return null;
    // The log contract for bulk day writes (ADR 0026: the output validates against it).
    const parsed = logDayItemInputSchema.parse({
      kind: item.kind,
      plannedDurationMs: item.plannedDurationMs,
      assetId: item.assetId,
      episodeId: item.episodeId,
      liveSlotId: item.liveSlotId,
      title: item.title,
      timing: item.timing,
      anchorAt: item.anchorAt?.toISOString() ?? null,
      capMs: item.capMs,
      origin: item.origin,
      relaxedRules: item.relaxedRules,
    });
    return { parsed, origin: parsed.origin };
  });
  // Not `withAudit`: an unchanged day writes nothing, not even an audit row.
  return db.transaction(async (tx) => {
    const audit = (entry: Parameters<typeof writeAudit>[2]) => writeAudit(tx, ctx, entry);
    const day = await lockOrCreateDay(tx, scope, generated, options.status ?? 'draft');
    if (day.startsAt.getTime() !== generated.startsAt.getTime()) {
      throw new Error(`log day ${generated.localDate} doesn't start where the generator planned`);
    }
    const keptIds = generated.items.flatMap((i) => (i.keptId ? [i.keptId] : []));
    // Lock the day's items, then check the kept set is still the snapshot's. The row locks hold
    // off a concurrent lock, segue or fallback mark on them (their writes, and foreign keys to
    // them, wait for this transaction), so nothing can become kept between the check and the
    // delete.
    const current = await tx
      .select()
      .from(logItem)
      .where(and(whereStation(logItem, scope), eq(logItem.logDayId, day.id)))
      .orderBy(asc(logItem.position))
      .for('update');
    const { reasonsOf } = await keepMarks(tx, scope, current, options.keep);
    const wanted = new Set(keptIds);
    const heads = new Set(
      current.filter((r) => r.segmentId === null && reasonsOf(r).length > 0).map((r) => r.id),
    );
    const nowKept = current.filter(
      (r) => heads.has(r.id) || (r.segmentId !== null && heads.has(r.segmentId)),
    );
    const present = new Set(current.map((r) => r.id));
    const stale = [
      ...nowKept.filter((r) => !wanted.has(r.id)).map((r) => r.id),
      ...keptIds.filter((id) => !present.has(id)),
    ];
    if (stale.length) throw new StaleGeneratorSnapshotError(generated.localDate, stale);
    const top = generated.items.filter((i) => i.segmentId === null);
    const ends = generated.items.map((i) => i.plannedStart.getTime() + i.plannedDurationMs);
    const range = (dayStart: Date, dayEnd: Date) => ({
      from: top[0]?.plannedStart ?? dayStart,
      to: new Date(Math.max(dayEnd.getTime(), ...ends)),
    });
    const unchanged =
      !day.created &&
      sameDay(
        {
          seed: day.seed,
          generatorVersion: day.generatorVersion,
          items: current.map(currentItemOf),
        },
        generated,
      );
    if (unchanged) {
      return {
        logDayId: day.id,
        localDate: generated.localDate,
        version: day.version,
        itemCount: generated.items.length,
        keptCount: keptIds.length,
        changed: false,
        range: range(day.startsAt, day.endsAt),
        following: null,
      };
    }
    await tx
      .delete(logItem)
      .where(
        and(
          whereStation(logItem, scope),
          eq(logItem.logDayId, day.id),
          keptIds.length ? notInArray(logItem.id, keptIds) : undefined,
        ),
      );
    // Positions are unique and not deferrable: park the kept items below zero first.
    if (keptIds.length) {
      await tx
        .update(logItem)
        .set({ position: sql`-1 - ${logItem.position}` })
        .where(and(whereStation(logItem, scope), inArray(logItem.id, keptIds)));
    }
    const inserts: (typeof logItem.$inferInsert)[] = [];
    for (const [i, item] of generated.items.entries()) {
      const timing = {
        position: item.position,
        plannedStart: item.plannedStart,
        plannedDurationMs: item.plannedDurationMs,
        conflictKind: item.conflict?.kind ?? null,
        conflictMs: item.conflict?.ms ?? null,
      };
      if (item.keptId !== null) {
        await tx
          .update(logItem)
          .set(timing)
          .where(and(whereStation(logItem, scope), eq(logItem.id, item.keptId)));
        continue;
      }
      const row = rows[i] as NonNullable<(typeof rows)[number]>;
      inserts.push({
        orgId: scope.orgId,
        stationId: scope.stationId,
        logDayId: day.id,
        ...timing,
        kind: row.parsed.kind,
        assetId: row.parsed.assetId ?? null,
        episodeId: row.parsed.episodeId ?? null,
        liveSlotId: row.parsed.liveSlotId ?? null,
        title: row.parsed.title ?? null,
        cueOverrides: null,
        timing: row.parsed.timing,
        anchorAt: row.parsed.anchorAt ? new Date(row.parsed.anchorAt) : null,
        capMs: row.parsed.capMs ?? null,
        locked: false,
        relaxedRules: row.parsed.relaxedRules,
        segmentId: null,
        ...originColumns(row.origin),
      });
    }
    for (let i = 0; i < inserts.length; i += 500) {
      await tx.insert(logItem).values(inserts.slice(i, i + 500));
    }
    // Where each kept item was planned around, and where it landed (`keptStart`, #101).
    const pins = generated.items.flatMap((item) =>
      item.keptId === null
        ? []
        : [
            {
              logItemId: item.keptId,
              orgId: scope.orgId,
              stationId: scope.stationId,
              start: item.start,
              settledStart: item.plannedStart,
            },
          ],
    );
    if (pins.length) {
      await tx
        .insert(logItemPin)
        .values(pins)
        .onConflictDoUpdate({
          target: logItemPin.logItemId,
          set: {
            start: sql`excluded.start`,
            settledStart: sql`excluded.settled_start`,
          },
        });
    }
    const [updated] = await tx
      .update(logDay)
      .set({
        version: day.created ? 1 : sql`${logDay.version} + 1`,
        generatedAt: new Date(),
        seed: generated.seed,
        generatorVersion: generated.generatorVersion,
      })
      .where(and(whereStation(logDay, scope), eq(logDay.id, day.id)))
      .returning();
    if (!updated) throw new Error(`log day ${generated.localDate} vanished`);
    const last = top.at(-1);
    const end = last ? new Date(last.plannedStart.getTime() + last.plannedDurationMs) : null;
    const following = await refreshFollowing(tx, scope, updated.endsAt, end);
    await audit({
      action: 'log_day.generate',
      entity: { type: 'log_day', id: day.id },
      diff: {
        cause: { from: null, to: 'generate' },
        items: { from: null, to: generated.items.length },
        kept: { from: null, to: keptIds.length },
        seed: { from: day.seed, to: generated.seed },
        generatorVersion: { from: day.generatorVersion, to: generated.generatorVersion },
        version: { from: day.created ? null : day.version, to: updated.version },
      },
    });
    return {
      logDayId: day.id,
      localDate: generated.localDate,
      version: updated.version,
      itemCount: generated.items.length,
      keptCount: keptIds.length,
      changed: true,
      range: range(updated.startsAt, updated.endsAt),
      following,
    };
  });
}

function originColumns(origin: LogItemOrigin) {
  return {
    originType: origin.type,
    originClockId: origin.type === 'clock' ? origin.clockId : null,
    originSlotIndex: origin.type === 'clock' ? origin.slotIndex : null,
    originShowSlotId: origin.type === 'show' ? origin.showSlotId : null,
  };
}

async function lockOrCreateDay(
  tx: Tx,
  scope: StationScope,
  generated: GeneratedDay,
  status: LogDayStatus,
) {
  const find = () =>
    tx
      .select()
      .from(logDay)
      .where(and(whereStation(logDay, scope), eq(logDay.localDate, generated.localDate)))
      .for('update');
  const [existing] = await find();
  if (existing) return { ...existing, created: false };
  const inserted = await tx
    .insert(logDay)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      localDate: generated.localDate,
      startsAt: generated.startsAt,
      endsAt: generated.endsAt,
      status,
    })
    .onConflictDoNothing({ target: [logDay.stationId, logDay.localDate] })
    .returning({ id: logDay.id });
  // Nothing inserted: a concurrent insert of the same day won, so it's an existing day.
  const [day] = await find();
  if (!day) throw new Error(`log day ${generated.localDate} could not be created`);
  return { ...day, created: inserted.length > 0 };
}

/** The next day's first item measures its conflict against this day's end (like the api). */
async function refreshFollowing(tx: Tx, scope: StationScope, dayEnd: Date, end: Date | null) {
  const [next] = await tx
    .select()
    .from(logDay)
    .where(and(whereStation(logDay, scope), eq(logDay.startsAt, dayEnd)))
    .for('update');
  if (!next) return null;
  const [first] = await tx
    .select()
    .from(logItem)
    .where(
      and(whereStation(logItem, scope), eq(logItem.logDayId, next.id), isNull(logItem.segmentId)),
    )
    .orderBy(asc(logItem.position))
    .limit(1);
  if (!first) return null;
  const [t] = retime(
    [
      {
        id: first.id,
        kind: first.kind,
        plannedDurationMs: first.plannedDurationMs,
        timing: first.timing,
        anchorAt: first.anchorAt,
        segmentId: null,
        crossOutMs: first.cueOverrides?.crossOutMs ?? null,
      },
    ],
    next.startsAt,
    end,
  );
  const conflict: LogTimingConflict | null = t?.conflict ?? null;
  if (
    (conflict?.kind ?? null) === first.conflictKind &&
    (conflict?.ms ?? null) === first.conflictMs
  ) {
    return null;
  }
  await tx
    .update(logItem)
    .set({ conflictKind: conflict?.kind ?? null, conflictMs: conflict?.ms ?? null })
    .where(and(whereStation(logItem, scope), eq(logItem.id, first.id)));
  const [updated] = await tx
    .update(logDay)
    .set({ version: sql`${logDay.version} + 1` })
    .where(and(whereStation(logDay, scope), eq(logDay.id, next.id)))
    .returning();
  return updated
    ? { logDayId: updated.id, localDate: updated.localDate, version: updated.version }
    : null;
}

// --- Episode audio arriving after generation -----------------------------------------------

/**
 * Puts an episode's audio into the items planned for it without one (the empty `episode`
 * items the generator plans while the audio is missing), for items that haven't started yet.
 * Call it when an episode gets its asset. Returns the days it touched, at their new version.
 */
export async function attachEpisodeAudio(
  db: Db,
  ctx: MutationContext & { scope: StationScope },
  episodeId: string,
  now = new Date(),
): Promise<{ logDayId: string; localDate: LocalDate; version: number }[]> {
  const { scope } = ctx;
  return withAudit(db, ctx, async (tx, audit) => {
    const [ep] = await tx
      .select({ assetId: episode.assetId })
      .from(episode)
      .where(and(whereStation(episode, scope), eq(episode.id, episodeId)));
    if (!ep?.assetId) {
      await audit({
        action: 'log_item.attach_episode',
        entity: { type: 'episode', id: episodeId },
      });
      return [];
    }
    // The item takes the episode's own length (like the generator's), then the day is retimed.
    const length = await episodeLengthMs(tx, scope, ep.assetId);
    const updated = await tx
      .update(logItem)
      .set({ assetId: ep.assetId, ...(length !== null ? { plannedDurationMs: length } : {}) })
      .where(
        and(
          whereStation(logItem, scope),
          eq(logItem.kind, 'episode'),
          eq(logItem.episodeId, episodeId),
          isNull(logItem.assetId),
          gte(logItem.plannedStart, now),
        ),
      )
      .returning({ id: logItem.id, logDayId: logItem.logDayId });
    const dayIds = [...new Set(updated.map((u) => u.logDayId))];
    const touched = new Map<string, { logDayId: string; localDate: LocalDate; version: number }>();
    for (const dayId of dayIds) {
      const following = await retimeDay(tx, scope, dayId);
      if (following) touched.set(following.logDayId, following);
    }
    const days = dayIds.length
      ? await tx
          .update(logDay)
          .set({ version: sql`${logDay.version} + 1` })
          .where(and(whereStation(logDay, scope), inArray(logDay.id, dayIds)))
          .returning({ logDayId: logDay.id, localDate: logDay.localDate, version: logDay.version })
      : [];
    for (const d of days) touched.set(d.logDayId, d);
    await audit({
      action: 'log_item.attach_episode',
      entity: { type: 'episode', id: episodeId },
      diff: {
        items: { from: null, to: updated.map((u) => u.id) },
        assetId: { from: null, to: ep.assetId },
      },
    });
    return [...touched.values()];
  });
}

/** An episode asset's log length (`itemLengthMs`, from its cues or file length), or null. */
async function episodeLengthMs(tx: Tx, scope: StationScope, assetId: string) {
  const [row] = await tx
    .select({
      durationMs: asset.durationMs,
      sampleRate: assetCues.sampleRate,
      cueIn: assetCues.cueIn,
      cueOut: assetCues.cueOut,
      crossStartNext: assetCues.crossStartNext,
    })
    .from(asset)
    .leftJoin(assetCues, eq(assetCues.assetId, asset.id))
    .where(and(whereStation(asset, scope), eq(asset.id, assetId)));
  if (!row) return null;
  const { playMs, overlapMs } = playRange(row);
  if (playMs === null && row.durationMs === null) return null;
  return itemLengthMs({ playMs, overlapMs, durationMs: row.durationMs } as GeneratorAsset);
}

/** The effective play range and natural overlap from cues, like the feeder (ADR 0002). */
function playRange(c: {
  sampleRate: number | null;
  cueIn: number | null;
  cueOut: number | null;
  crossStartNext: number | null;
}) {
  const ms = (samples: number | null) =>
    c.sampleRate && samples != null ? Math.round((samples * 1000) / c.sampleRate) : null;
  const cueIn = ms(c.cueIn) ?? 0;
  const cueOut = ms(c.cueOut);
  const crossStart = ms(c.crossStartNext);
  return {
    playMs: cueOut !== null && cueOut > cueIn ? cueOut - cueIn : null,
    overlapMs: cueOut !== null && crossStart !== null ? Math.max(0, cueOut - crossStart) : 0,
  };
}

/**
 * Recomputes a day's planned starts and conflicts after an edit (`retime`, like the log
 * repository after every write), then the following day's first-item conflict. Returns the
 * following day if it changed.
 */
async function retimeDay(tx: Tx, scope: StationScope, logDayId: string) {
  const [day] = await tx
    .select()
    .from(logDay)
    .where(and(whereStation(logDay, scope), eq(logDay.id, logDayId)))
    .for('update');
  if (!day) return null;
  const rows = await tx
    .select()
    .from(logItem)
    .where(and(whereStation(logItem, scope), eq(logItem.logDayId, logDayId)))
    .orderBy(asc(logItem.position));
  const timed = retime(
    rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      plannedDurationMs: r.plannedDurationMs,
      timing: r.timing,
      anchorAt: r.anchorAt,
      segmentId: r.segmentId,
      crossOutMs: r.cueOverrides?.crossOutMs ?? null,
    })),
    day.startsAt,
    await previousEnd(tx, scope, day.startsAt),
  );
  let end: Date | null = null;
  for (const [i, row] of rows.entries()) {
    const t = timed[i];
    if (!t) continue;
    if (row.segmentId === null) end = new Date(t.plannedStart.getTime() + t.plannedDurationMs);
    const changed =
      t.plannedStart.getTime() !== row.plannedStart.getTime() ||
      t.plannedDurationMs !== row.plannedDurationMs ||
      (t.conflict?.kind ?? null) !== row.conflictKind ||
      (t.conflict?.ms ?? null) !== row.conflictMs;
    if (!changed) continue;
    await tx
      .update(logItem)
      .set({
        plannedStart: t.plannedStart,
        plannedDurationMs: t.plannedDurationMs,
        conflictKind: t.conflict?.kind ?? null,
        conflictMs: t.conflict?.ms ?? null,
      })
      .where(and(whereStation(logItem, scope), eq(logItem.id, row.id)));
  }
  return refreshFollowing(tx, scope, day.endsAt, end);
}

// --- Clock music (missing-episode fallback) ------------------------------------------------

/**
 * Music from a clock for `[startsAt, startsAt + durationMs)`, planned by the generator against
 * the station's history and log around it: what #47's `clock_music` fallback airs in place of a
 * missing episode (ADR 0022's `ClockMusicSource.fill`). Items in air order, as log inputs; null
 * when the clock plans nothing.
 */
export async function fillWithClockMusic(
  db: Db,
  scope: StationScope,
  request: { clockId: string; startsAt: Date; durationMs: number },
  now = new Date(),
): Promise<LogItemInput[] | null> {
  const [st] = await db
    .select({ timezone: station.timezone })
    .from(station)
    .where(and(eq(station.id, scope.stationId), eq(station.orgId, scope.orgId)));
  if (!st) return null;
  const end = new Date(request.startsAt.getTime() + Math.max(0, request.durationMs - 1));
  const first = localDateOf(request.startsAt, st.timezone);
  const last = localDateOf(end, st.timezone);
  const dates = [first];
  while ((dates.at(-1) as LocalDate) < last) dates.push(addDays(dates.at(-1) as LocalDate, 1));
  const loaded = await loadGeneratorSnapshot(db, scope, { dates, now, mode: 'around' });
  if (!loaded) return null;
  const { items } = planClockMusic(loaded.snapshot, request);
  if (items.length === 0) return null;
  return items.map((item) => ({
    kind: item.kind,
    plannedDurationMs: item.plannedDurationMs,
    assetId: item.assetId,
    title: item.title,
    timing: item.timing,
    anchorAt: item.anchorAt?.toISOString() ?? null,
    capMs: item.capMs,
  }));
}
