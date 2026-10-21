import {
  type ListenerSample,
  type ListenerStat,
  type ListListenerStatsQuery,
  listenerSampleSchema,
  listListenerStatsQuerySchema,
} from '@ondes/shared';
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Db, Executor } from '../client.ts';
import { streamListenerStat } from '../schema/streams.ts';
import { type StationScope, whereStation } from '../tenant.ts';

// Listener statistics (#32). The api's Icecast stats poller records one sample per mount per
// poll; each sample folds into its mount's one-minute bucket (one upsert, so concurrent or
// repeated pollers never lose a sample's count and a restart mid-minute just keeps adding).
// After `minuteDays` the minute buckets are folded into hour buckets, and hour buckets older
// than `hourDays` are deleted (`downsampleListenerStats`, run by the poller service hourly).

const MINUTE = 60;
const HOUR = 3600;

/** Truncates to the start of the minute (UTC). */
export function minuteOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000);
}

/**
 * Folds poll samples into their minute buckets. Not station-scoped on purpose: the poller is a
 * system process that reads every station's mounts from the `station` table, and each sample
 * carries the station id it was read with.
 */
export async function recordListenerSamples(db: Executor, samples: ListenerSample[]) {
  if (samples.length === 0) return;
  // One row per key: an upsert can't touch the same row twice in one statement.
  const byKey = new Map<string, typeof streamListenerStat.$inferInsert>();
  for (const input of samples) {
    const s = listenerSampleSchema.parse(input);
    const bucketStart = minuteOf(s.at);
    const key = `${s.stationId}\0${s.mount}\0${bucketStart.getTime()}`;
    const row = byKey.get(key);
    const source = s.sourceConnected ? 1 : 0;
    if (row) {
      row.samples += 1;
      row.listenersSum += s.listeners;
      row.listenersMax = Math.max(row.listenersMax, s.listeners);
      row.listenersMin = Math.min(row.listenersMin, s.listeners);
      row.sourceSamples += source;
    } else {
      byKey.set(key, {
        stationId: s.stationId,
        mount: s.mount,
        bucketStart,
        bucketSeconds: MINUTE,
        samples: 1,
        listenersSum: s.listeners,
        listenersMax: s.listeners,
        listenersMin: s.listeners,
        sourceSamples: source,
      });
    }
  }
  const t = streamListenerStat;
  const ex = (column: string) => sql.raw(`excluded.${column}`);
  await db
    .insert(t)
    .values([...byKey.values()])
    .onConflictDoUpdate({
      target: [t.stationId, t.mount, t.bucketSeconds, t.bucketStart],
      set: {
        samples: sql`${t.samples} + ${ex('samples')}`,
        listenersSum: sql`${t.listenersSum} + ${ex('listeners_sum')}`,
        listenersMax: sql`greatest(${t.listenersMax}, ${ex('listeners_max')})`,
        listenersMin: sql`least(${t.listenersMin}, ${ex('listeners_min')})`,
        sourceSamples: sql`${t.sourceSamples} + ${ex('source_samples')}`,
      },
    });
}

/**
 * A station's listener buckets in `[from, to)`, oldest first: minutes for recent data, hours
 * for downsampled data.
 */
export async function listListenerStats(
  db: Executor,
  scope: StationScope,
  query: ListListenerStatsQuery,
): Promise<ListenerStat[]> {
  const q = listListenerStatsQuerySchema.parse(query);
  const t = streamListenerStat;
  const rows = await db
    .select()
    .from(t)
    .where(
      and(
        whereStation(t, scope),
        gte(t.bucketStart, q.from),
        lt(t.bucketStart, q.to),
        q.mount === undefined ? undefined : eq(t.mount, q.mount),
      ),
    )
    .orderBy(asc(t.bucketStart), asc(t.mount), asc(t.bucketSeconds));
  return rows.map((r) => ({
    mount: r.mount,
    bucketStart: r.bucketStart,
    bucketSeconds: r.bucketSeconds === HOUR ? HOUR : MINUTE,
    samples: r.samples,
    listenersAvg: r.listenersSum / r.samples,
    listenersMax: r.listenersMax,
    listenersMin: r.listenersMin,
    sourceUptime: r.sourceSamples / r.samples,
  }));
}

export type ListenerStatsRetention = {
  /** Minute buckets older than this become hour buckets. Default 30. */
  minuteDays?: number;
  /** Hour buckets older than this are deleted. Default 730 (two years). */
  hourDays?: number;
};

/**
 * Folds minute buckets older than `minuteDays` (cut on a whole UTC hour) into hour buckets
 * and deletes hour buckets older than `hourDays`. Idempotent; safe to run from several
 * processes at once (one transaction, the folded rows are deleted as they are read).
 * Resolves with the number of minute buckets folded and hour buckets deleted.
 */
export async function downsampleListenerStats(
  db: Db,
  retention: ListenerStatsRetention = {},
  now = new Date(),
): Promise<{ folded: number; deleted: number }> {
  const minuteDays = retention.minuteDays ?? 30;
  const hourDays = retention.hourDays ?? 730;
  const hourMs = HOUR * 1000;
  const cut = (days: number) =>
    new Date(Math.floor((now.getTime() - days * 86_400_000) / hourMs) * hourMs);
  const minuteCutoff = cut(minuteDays);
  const hourCutoff = cut(hourDays);

  return db.transaction(async (tx) => {
    const folded = await tx.execute<{ n: string }>(sql`
      with old as (
        delete from stream_listener_stat
        where bucket_seconds = ${MINUTE} and bucket_start < ${minuteCutoff.toISOString()}::timestamptz
        returning *
      ), hours as (
        insert into stream_listener_stat as t (
          station_id, mount, bucket_start, bucket_seconds,
          samples, listeners_sum, listeners_max, listeners_min, source_samples
        )
        select station_id, mount, date_trunc('hour', bucket_start, 'UTC'), ${HOUR},
          sum(samples), sum(listeners_sum), max(listeners_max), min(listeners_min),
          sum(source_samples)
        from old
        group by station_id, mount, date_trunc('hour', bucket_start, 'UTC')
        on conflict (station_id, mount, bucket_seconds, bucket_start) do update set
          samples = t.samples + excluded.samples,
          listeners_sum = t.listeners_sum + excluded.listeners_sum,
          listeners_max = greatest(t.listeners_max, excluded.listeners_max),
          listeners_min = least(t.listeners_min, excluded.listeners_min),
          source_samples = t.source_samples + excluded.source_samples
      )
      select count(*) as n from old`);
    const deleted = await tx
      .delete(streamListenerStat)
      .where(
        and(
          eq(streamListenerStat.bucketSeconds, HOUR),
          lt(streamListenerStat.bucketStart, hourCutoff),
        ),
      )
      .returning({ id: streamListenerStat.id });
    return { folded: Number(folded[0]?.n ?? 0), deleted: deleted.length };
  });
}
