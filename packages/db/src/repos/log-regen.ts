import { REGEN_DEBOUNCE_MS, REGEN_MAX_WAIT_MS, regenDueAt } from '@ondes/scheduling';
import {
  LOG_REGEN_DEFAULT_SETTINGS,
  type LocalDate,
  type LogRegenSettings,
  logRegenSettingsSchema,
  type ScheduleArea,
} from '@ondes/shared';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { type MutationContext, withAudit } from '../audit.ts';
import type { Db, Executor } from '../client.ts';
import { logDay } from '../schema/log.ts';
import { logRegenCursor, logRegenRequest, logRegenSetting } from '../schema/regen.ts';
import { station } from '../schema/tenancy.ts';
import { resolveStationScope, type StationScope, whereStation } from '../tenant.ts';

// Log regeneration (#101, ADR 0030) queries: a station's horizon settings, the debounced
// regeneration requests schedule changes leave, and the horizon sweep. The regeneration itself
// goes through the generator's snapshot and writer (`log-generate.ts`).

/** The station's IANA timezone; null when the station is gone. */
export async function stationTimezone(db: Executor, scope: StationScope): Promise<string | null> {
  const [row] = await db
    .select({ timezone: station.timezone })
    .from(station)
    .where(and(eq(station.id, scope.stationId), eq(station.orgId, scope.orgId)));
  return row?.timezone ?? null;
}

export async function getRegenSettings(
  db: Executor,
  scope: StationScope,
): Promise<LogRegenSettings> {
  const [row] = await db
    .select({
      horizonDays: logRegenSetting.horizonDays,
      newDayStatus: logRegenSetting.newDayStatus,
    })
    .from(logRegenSetting)
    .where(whereStation(logRegenSetting, scope));
  return row ?? { ...LOG_REGEN_DEFAULT_SETTINGS };
}

/** Saves a station's horizon settings. Audited `log_regen_setting.update`. */
export async function setRegenSettings(
  db: Db,
  ctx: MutationContext & { scope: StationScope },
  input: LogRegenSettings,
): Promise<LogRegenSettings> {
  const settings = logRegenSettingsSchema.parse(input);
  return withAudit(db, ctx, async (tx, audit) => {
    const before = await getRegenSettings(tx, ctx.scope);
    await tx
      .insert(logRegenSetting)
      .values({ stationId: ctx.scope.stationId, orgId: ctx.scope.orgId, ...settings })
      .onConflictDoUpdate({ target: logRegenSetting.stationId, set: settings });
    await audit({
      action: 'log_regen_setting.update',
      entity: { type: 'station', id: ctx.scope.stationId },
      diff: {
        horizonDays: { from: before.horizonDays, to: settings.horizonDays },
        newDayStatus: { from: before.newDayStatus, to: settings.newDayStatus },
      },
    });
    return settings;
  });
}

export interface RegenRequest {
  fromDate: LocalDate | null;
  areas: ScheduleArea[];
  firstRequestedAt: Date;
  lastRequestedAt: Date;
  dueAt: Date;
}

/**
 * Records a schedule change: creates the station's pending request, or pushes it back
 * (debounced, capped: `regenDueAt`'s rule, in SQL) and widens it (areas, the earliest from date,
 * null meaning today). One upsert, so concurrent first changes merge instead of overwriting
 * each other. Changes arriving out of order keep the latest `lastRequestedAt`.
 */
export async function recordRegenRequest(
  db: Executor,
  scope: StationScope,
  change: { at: Date; firstAt?: Date; areas: readonly ScheduleArea[]; from: LocalDate | null },
): Promise<RegenRequest> {
  const first = change.firstAt ?? change.at;
  const values = {
    stationId: scope.stationId,
    orgId: scope.orgId,
    fromDate: change.from,
    areas: [...new Set(change.areas)].sort(),
    firstRequestedAt: first,
    lastRequestedAt: change.at,
    dueAt: regenDueAt({ firstRequestedAt: first, lastRequestedAt: change.at }),
  };
  const t = logRegenRequest;
  const firstAt = sql`least(${t.firstRequestedAt}, excluded.first_requested_at)`;
  const lastAt = sql`greatest(${t.lastRequestedAt}, excluded.last_requested_at)`;
  const [row] = await db
    .insert(t)
    .values(values)
    .onConflictDoUpdate({
      target: t.stationId,
      set: {
        fromDate: sql`case when ${t.fromDate} is null or excluded.from_date is null then null
          else least(${t.fromDate}, excluded.from_date) end`,
        areas: sql`array(select distinct a from unnest(${t.areas} || excluded.areas) a order by a)`,
        firstRequestedAt: firstAt,
        lastRequestedAt: lastAt,
        dueAt: sql`least(${lastAt} + make_interval(secs => ${REGEN_DEBOUNCE_MS / 1000}),
          ${firstAt} + make_interval(secs => ${REGEN_MAX_WAIT_MS / 1000}))`,
      },
    })
    .returning();
  if (!row) throw new Error('regen request upsert returned nothing');
  return {
    fromDate: row.fromDate,
    areas: row.areas,
    firstRequestedAt: row.firstRequestedAt,
    lastRequestedAt: row.lastRequestedAt,
    dueAt: row.dueAt,
  };
}

/**
 * Audit actions that change what the generator plans (ADR 0030). Every api mutation writes its
 * audit row in its own transaction, so a change found here can't be lost to a failed publish
 * or a crash after the commit, deletes included. Library edits count: category membership
 * follows tags and asset fields (ADR 0013), and the rules read titles and artists.
 */
export const SCHEDULE_ACTIONS: Readonly<Record<string, ScheduleArea>> = {
  'clock.update': 'clocks',
  'clock.delete': 'clocks',
  'clock_grid.update': 'grid',
  'clock_grid_override.create': 'grid',
  'clock_grid_override.update': 'grid',
  'clock_grid_override.delete': 'grid',
  'daypart.create': 'grid',
  'daypart.update': 'grid',
  'daypart.delete': 'grid',
  'category.update': 'categories',
  'category.delete': 'categories',
  'rotation_rules.update': 'rules',
  'show.update': 'shows',
  'show.delete': 'shows',
  'show_slot.create': 'shows',
  'show_slot.update': 'shows',
  'show_slot.delete': 'shows',
  'show_slot.exception.put': 'shows',
  'show_slot.exception.delete': 'shows',
  'episode.create': 'shows',
  'episode.update': 'shows',
  'episode.delete': 'shows',
  'asset.create': 'library',
  'asset.update': 'library',
  'asset.delete': 'library',
  'asset.tag': 'library',
};

/** How far back a station without a cursor (or a long-idle one) looks for changes. */
const CHANGE_LOOKBACK = '1 day';

/**
 * The schedule changes recorded in the audit log since each station's last handled change
 * (`log_regen_cursor`, moved on by `clearRegenRequest`), turned into regeneration requests.
 * Stations whose pending request already covers their latest change are skipped. A system
 * sweep across tenants (the api's horizon sweep); each station is recorded in its own scope.
 */
export async function recordScheduleChanges(db: Db, now: Date): Promise<StationScope[]> {
  const at = now.toISOString();
  const actions = sql.join(
    Object.keys(SCHEDULE_ACTIONS).map((x) => sql`${x}`),
    sql`, `,
  );
  const rows = await db.execute<{
    org_id: string;
    station_id: string;
    first_at: string;
    last_at: string;
    actions: string[];
  }>(sql`
    select a.org_id, a.station_id, min(a.ms)::text as first_at, max(a.ms)::text as last_at,
      array_agg(distinct a.action) as actions
    -- Milliseconds, like the request and cursor times (JS dates): a change is never seen twice.
    from (
      select org_id, station_id, action, date_trunc('milliseconds', at) as ms
      from audit_log
      where action in (${actions})
        and at > ${at}::timestamptz - ${CHANGE_LOOKBACK}::interval
        and at <= ${at}::timestamptz
    ) a
    join station s on s.id = a.station_id and s.org_id = a.org_id
    left join log_regen_cursor c on c.station_id = a.station_id
    left join log_regen_request q on q.station_id = a.station_id
    where a.ms > coalesce(q.last_requested_at, c.seen_until, '-infinity'::timestamptz)
    group by a.org_id, a.station_id
  `);
  const recorded: StationScope[] = [];
  for (const r of rows) {
    const scope = await resolveStationScope(db, r.org_id, r.station_id);
    await recordRegenRequest(db, scope, {
      at: new Date(r.last_at),
      firstAt: new Date(r.first_at),
      areas: r.actions.flatMap((a) => (SCHEDULE_ACTIONS[a] ? [SCHEDULE_ACTIONS[a]] : [])),
      from: null,
    });
    recorded.push(scope);
  }
  return recorded;
}

/** The station's pending request, if any (due or not). */
export async function getRegenRequest(
  db: Executor,
  scope: StationScope,
): Promise<RegenRequest | null> {
  const [row] = await db.select().from(logRegenRequest).where(whereStation(logRegenRequest, scope));
  if (!row) return null;
  return {
    fromDate: row.fromDate,
    areas: row.areas,
    firstRequestedAt: row.firstRequestedAt,
    lastRequestedAt: row.lastRequestedAt,
    dueAt: row.dueAt,
  };
}

/**
 * Clears a request once it was acted on, unless a change came in meanwhile (its
 * `lastRequestedAt` moved): that one waits for its own turn.
 */
export async function clearRegenRequest(
  db: Db,
  scope: StationScope,
  lastRequestedAt: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(logRegenRequest)
      .where(
        and(
          whereStation(logRegenRequest, scope),
          eq(logRegenRequest.lastRequestedAt, lastRequestedAt),
        ),
      )
      .returning({ stationId: logRegenRequest.stationId });
    // Changes up to it are handled: the change sweep looks past it from now on.
    await tx
      .insert(logRegenCursor)
      .values({ stationId: scope.stationId, orgId: scope.orgId, seenUntil: lastRequestedAt })
      .onConflictDoUpdate({
        target: logRegenCursor.stationId,
        set: { seenUntil: sql`greatest(${logRegenCursor.seenUntil}, excluded.seen_until)` },
      });
    return deleted.length > 0;
  });
}

/** The dates among `dates` that have a log day. */
export async function existingLogDays(
  db: Executor,
  scope: StationScope,
  dates: readonly LocalDate[],
): Promise<Map<LocalDate, { id: string; version: number }>> {
  if (dates.length === 0) return new Map();
  const rows = await db
    .select({ id: logDay.id, localDate: logDay.localDate, version: logDay.version })
    .from(logDay)
    .where(and(whereStation(logDay, scope), inArray(logDay.localDate, [...dates])));
  return new Map(rows.map((r) => [r.localDate, { id: r.id, version: r.version }]));
}

/**
 * Stations whose horizon needs a pass at `now`: a due regeneration request, or a day of the
 * horizon without a log (a new day at local midnight: the nightly extension). Only stations
 * with a clock grid (#40): a station that has planned nothing yet gets no empty days. A system
 * sweep across tenants; each station is then handled in its own scope.
 */
export async function stationsDueForHorizon(
  db: Executor,
  now: Date,
): Promise<{ orgId: string; stationId: string }[]> {
  const at = now.toISOString();
  const rows = await db.execute<{ org_id: string; station_id: string }>(sql`
    select s.org_id, s.id as station_id
    from station s
    left join log_regen_setting r on r.station_id = s.id
    where exists (select 1 from clock_grid g where g.station_id = s.id)
      and (
        exists (
          select 1 from log_regen_request q
          where q.station_id = s.id and q.due_at <= ${at}::timestamptz
        )
        or (
          select count(*) from log_day d
          where d.station_id = s.id
            and d.local_date >= (${at}::timestamptz at time zone s.timezone)::date
            and d.local_date < (${at}::timestamptz at time zone s.timezone)::date
              + coalesce(r.horizon_days, ${LOG_REGEN_DEFAULT_SETTINGS.horizonDays})
        ) < coalesce(r.horizon_days, ${LOG_REGEN_DEFAULT_SETTINGS.horizonDays})
      )
    order by s.id
  `);
  return rows.map((r) => ({ orgId: r.org_id, stationId: r.station_id }));
}

/** Requests due at `now`, oldest first (tests and the sweep's log). */
export async function dueRegenRequests(db: Executor, now: Date) {
  return db
    .select({ orgId: logRegenRequest.orgId, stationId: logRegenRequest.stationId })
    .from(logRegenRequest)
    .where(lte(logRegenRequest.dueAt, now))
    .orderBy(logRegenRequest.dueAt);
}
