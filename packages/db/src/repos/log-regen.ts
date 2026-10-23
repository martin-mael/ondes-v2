import { earlierFrom, regenDueAt } from '@ondes/scheduling';
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
import { logRegenRequest, logRegenSetting } from '../schema/regen.ts';
import { station } from '../schema/tenancy.ts';
import { type StationScope, whereStation } from '../tenant.ts';

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
 * (`regenDueAt`: debounced, capped) and widens it. Changes arriving out of order keep the
 * latest `lastRequestedAt`. Returns the request as it now stands.
 */
export async function recordRegenRequest(
  db: Db,
  scope: StationScope,
  change: { at: Date; areas: readonly ScheduleArea[]; from: LocalDate | null },
): Promise<RegenRequest> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(logRegenRequest)
      .where(whereStation(logRegenRequest, scope))
      .for('update');
    const first = existing
      ? new Date(Math.min(existing.firstRequestedAt.getTime(), change.at.getTime()))
      : change.at;
    const last = existing
      ? new Date(Math.max(existing.lastRequestedAt.getTime(), change.at.getTime()))
      : change.at;
    const next = {
      fromDate: existing ? earlierFrom(existing.fromDate, change.from) : change.from,
      areas: [...new Set([...(existing?.areas ?? []), ...change.areas])].sort(),
      firstRequestedAt: first,
      lastRequestedAt: last,
      dueAt: regenDueAt({ firstRequestedAt: first, lastRequestedAt: last }),
    };
    await tx
      .insert(logRegenRequest)
      .values({ stationId: scope.stationId, orgId: scope.orgId, ...next })
      .onConflictDoUpdate({ target: logRegenRequest.stationId, set: next });
    return next;
  });
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
  db: Executor,
  scope: StationScope,
  lastRequestedAt: Date,
): Promise<boolean> {
  const deleted = await db
    .delete(logRegenRequest)
    .where(
      and(
        whereStation(logRegenRequest, scope),
        eq(logRegenRequest.lastRequestedAt, lastRequestedAt),
      ),
    )
    .returning({ stationId: logRegenRequest.stationId });
  return deleted.length > 0;
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
