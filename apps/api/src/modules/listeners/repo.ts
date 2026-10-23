import { type Executor, type StationScope, streamListenerStat, whereStation } from '@ondes/db';
import type { CurrentListeners, ListenerHistory } from '@ondes/shared';
import { and, gte, lt, sql } from 'drizzle-orm';

// Reads of the listener buckets the Icecast poller records (#32, `stream_listener_stat`), for
// the dashboard (#71). Station-scoped; counts only.

/** Mounts with no bucket this recent aren't "now" any more (the poller samples every 15 s). */
export const CURRENT_WINDOW_MS = 3 * 60_000;
/** Steps of the history graph. */
export const HISTORY_POINTS = 288;

export async function currentListeners(
  db: Executor,
  scope: StationScope,
  now = new Date(),
): Promise<CurrentListeners> {
  const t = streamListenerStat;
  const rows = await db
    .selectDistinctOn([t.mount], {
      mount: t.mount,
      at: t.bucketStart,
      samples: t.samples,
      listenersSum: t.listenersSum,
      listenersMax: t.listenersMax,
      sourceSamples: t.sourceSamples,
    })
    .from(t)
    .where(
      and(
        whereStation(t, scope),
        sql`${t.bucketSeconds} = 60`,
        gte(t.bucketStart, new Date(now.getTime() - CURRENT_WINDOW_MS)),
      ),
    )
    .orderBy(t.mount, sql`${t.bucketStart} desc`);
  const mounts = rows.map((r) => ({
    mount: r.mount,
    listeners: Math.round(r.listenersSum / r.samples),
    listenersMax: r.listenersMax,
    sourceConnected: r.sourceSamples * 2 > r.samples,
    sampledAt: r.at,
  }));
  const sampledAt = mounts.reduce<Date | null>(
    (max, m) => (max && max >= m.sampledAt ? max : m.sampledAt),
    null,
  );
  return { sampledAt, total: mounts.reduce((sum, m) => sum + m.listeners, 0), mounts };
}

/** Step for `hours` of history: whole minutes, {@link HISTORY_POINTS} steps at most. */
export function historyStepSeconds(hours: number): number {
  return Math.max(60, Math.ceil((hours * 3600) / HISTORY_POINTS / 60) * 60);
}

export async function listenerHistory(
  db: Executor,
  scope: StationScope,
  hours: number,
  now = new Date(),
): Promise<ListenerHistory> {
  const stepSeconds = historyStepSeconds(hours);
  const stepMs = stepSeconds * 1000;
  // Steps aligned on the step size (UTC), so a refetch keeps the same points.
  const to = new Date(Math.ceil(now.getTime() / stepMs) * stepMs);
  const from = new Date(to.getTime() - Math.ceil((hours * 3600) / stepSeconds) * stepMs);
  const t = streamListenerStat;
  const bin = sql<Date>`date_bin(make_interval(secs => ${stepSeconds}), ${t.bucketStart}, ${from.toISOString()}::timestamptz)`;
  const rows = await db
    .select({
      at: bin,
      mount: t.mount,
      avg: sql<number>`sum(${t.listenersSum})::float8 / sum(${t.samples})`,
    })
    .from(t)
    .where(and(whereStation(t, scope), gte(t.bucketStart, from), lt(t.bucketStart, to)))
    // By position: the bin's parameters would differ from the select's to Postgres.
    .groupBy(sql`1`, sql`2`);

  const byStep = new Map<number, Record<string, number>>();
  const mounts = new Set<string>();
  for (const r of rows) {
    const key = new Date(r.at).getTime();
    const step = byStep.get(key) ?? {};
    step[r.mount] = Math.round(Number(r.avg) * 10) / 10;
    byStep.set(key, step);
    mounts.add(r.mount);
  }
  const points: ListenerHistory['points'] = [];
  for (let at = from.getTime(); at < to.getTime(); at += stepMs) {
    const byMount = byStep.get(at);
    points.push({
      startsAt: new Date(at),
      total: byMount
        ? Math.round(Object.values(byMount).reduce((sum, n) => sum + n, 0) * 10) / 10
        : null,
      byMount: byMount ?? {},
    });
  }
  return { startsAt: from, endsAt: to, stepSeconds, mounts: [...mounts].sort(), points };
}
