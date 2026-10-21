import {
  type ListenerMinute,
  type ListenerSample,
  type ListListenerMinutesQuery,
  listenerSampleSchema,
  listListenerMinutesQuerySchema,
} from '@ondes/shared';
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Executor } from '../client.ts';
import { streamListenerMinute } from '../schema/streams.ts';
import { type StationScope, whereStation } from '../tenant.ts';

// Listener statistics (#32). The api's Icecast stats poller records one sample per mount per
// poll; each sample folds into its mount's row for that minute (one upsert, so concurrent or
// repeated pollers never lose a sample's count and a restart mid-minute just keeps adding).

/** Truncates to the start of the minute (UTC). */
export function minuteOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000);
}

/**
 * Folds poll samples into their minute rows. Not station-scoped on purpose: the poller is a
 * system process that reads every station's mounts from the `station` table, and each sample
 * carries the station id it was read with.
 */
export async function recordListenerSamples(db: Executor, samples: ListenerSample[]) {
  if (samples.length === 0) return;
  // One row per key: an upsert can't touch the same row twice in one statement.
  const byKey = new Map<string, typeof streamListenerMinute.$inferInsert>();
  for (const input of samples) {
    const s = listenerSampleSchema.parse(input);
    const minute = minuteOf(s.at);
    const key = `${s.stationId}\0${s.mount}\0${minute.getTime()}`;
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
        minute,
        samples: 1,
        listenersSum: s.listeners,
        listenersMax: s.listeners,
        listenersMin: s.listeners,
        sourceSamples: source,
      });
    }
  }
  const rows = [...byKey.values()];
  const t = streamListenerMinute;
  const ex = (column: string) => sql.raw(`excluded.${column}`);
  await db
    .insert(t)
    .values(rows)
    .onConflictDoUpdate({
      target: [t.stationId, t.mount, t.minute],
      set: {
        samples: sql`${t.samples} + ${ex('samples')}`,
        listenersSum: sql`${t.listenersSum} + ${ex('listeners_sum')}`,
        listenersMax: sql`greatest(${t.listenersMax}, ${ex('listeners_max')})`,
        listenersMin: sql`least(${t.listenersMin}, ${ex('listeners_min')})`,
        sourceSamples: sql`${t.sourceSamples} + ${ex('source_samples')}`,
      },
    });
}

/** A station's per-minute listener counts in `[from, to)`, oldest first. */
export async function listListenerMinutes(
  db: Executor,
  scope: StationScope,
  query: ListListenerMinutesQuery,
): Promise<ListenerMinute[]> {
  const q = listListenerMinutesQuerySchema.parse(query);
  const t = streamListenerMinute;
  const rows = await db
    .select()
    .from(t)
    .where(
      and(
        whereStation(t, scope),
        gte(t.minute, q.from),
        lt(t.minute, q.to),
        q.mount === undefined ? undefined : eq(t.mount, q.mount),
      ),
    )
    .orderBy(asc(t.minute), asc(t.mount));
  return rows.map((r) => ({
    mount: r.mount,
    minute: r.minute,
    samples: r.samples,
    listenersAvg: r.listenersSum / r.samples,
    listenersMax: r.listenersMax,
    listenersMin: r.listenersMin,
    sourceUptime: r.sourceSamples / r.samples,
  }));
}
