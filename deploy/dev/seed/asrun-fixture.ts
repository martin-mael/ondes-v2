// Fixture as-run (#53): what "aired" yesterday (station-local) for the demo station, laid over
// the fixture log, so the log vs as-run view has something to show without an engine running.
// Called from index.ts (`pnpm dev:seed`) after the log fixture. Written only when yesterday has
// no as-run at all, so real entries recorded by a running dev engine are never mixed with it.
//
// A deterministic mix: most items aired on time (a few seconds of drift), and a handful of
// every case the view shows: late, cut, skipped, not aired, replaced by the safety playlist,
// an engine restart (interrupted, then aired again), an episode fallback, live slots.

import { randomUUID } from 'node:crypto';
import { getLogRange } from '../../../apps/api/src/modules/log/repo.ts';
import { addDays, localDateOf, localDayBounds } from '../../../apps/api/src/modules/log/time.ts';
import { asRunEntry, type Db, type StationScope } from '../../../packages/db/src/index.ts';
import {
  type AsRunOutcome,
  asRunOutcome,
  type LogItem,
  type LogSegmentPart,
} from '../../../packages/shared/src/index.ts';

type NewEntry = typeof asRunEntry.$inferInsert;

export async function seedAsRunFixture(
  db: Db,
  scope: StationScope,
  timezone: string,
  options: { now?: Date } = {},
): Promise<string> {
  const date = addDays(localDateOf(options.now ?? new Date(), timezone), -1);
  const { startsAt, endsAt } = localDayBounds(date, timezone);
  const any = await db.query.asRunEntry.findFirst({
    where: (t, { and, eq, gte, lt }) =>
      and(eq(t.stationId, scope.stationId), gte(t.startedAt, startsAt), lt(t.startedAt, endsAt)),
    columns: { id: true },
  });
  if (any) return `as-run fixture: ${date} has entries`;

  const log = await getLogRange(db, scope, {
    from: startsAt.toISOString(),
    to: endsAt.toISOString(),
  });
  const items = log.items.filter(
    (i) => Date.parse(i.plannedStart) >= startsAt.getTime() && i.kind !== 'marker',
  );
  if (items.length === 0) return `as-run fixture: no log on ${date}`;

  const bootId = `fixture-${date}`;
  let seq = 0;
  const rows: NewEntry[] = [];
  const add = (
    item: LogItem | LogSegmentPart | null,
    startedAt: Date,
    playedMs: number,
    more: Partial<NewEntry> = {},
  ) => {
    seq++;
    const outcome: AsRunOutcome = item
      ? asRunOutcome(playedMs, item.plannedDurationMs)
      : 'complete';
    rows.push({
      orgId: scope.orgId,
      stationId: scope.stationId,
      eventId: randomUUID(),
      bootId,
      seq,
      endSeq: seq,
      source: 'log',
      engineItemId: item?.id ?? null,
      logItemId: item?.id ?? null,
      segmentId: item?.segmentId ?? null,
      kind: item?.kind ?? null,
      assetId: item?.assetId ?? null,
      title: item?.title ?? item?.asset?.title ?? null,
      artist: item?.asset?.artists.join(', ') || null,
      artists: item?.asset?.artists ?? [],
      startedAt,
      endedAt: new Date(startedAt.getTime() + playedMs),
      durationMs: playedMs,
      outcome,
      plannedStart: item ? new Date(item.plannedStart) : null,
      plannedDurationMs: item?.plannedDurationMs ?? null,
      ...more,
    });
  };

  for (const [i, item] of items.entries()) {
    const planned = Date.parse(item.plannedStart);
    const len = item.plannedDurationMs;
    // A few seconds either way, the usual crossfade jitter.
    const jitter = (((i * 7919) % 9) - 3) * 1000;
    const at = (offset: number) => new Date(planned + offset);
    if (item.kind === 'live_slot') {
      add(null, at(40_000), Math.max(0, len - 90_000), {
        source: 'live',
        title: 'Live',
        engineItemId: null,
      });
      continue;
    }
    if (item.kind === 'segment') {
      let offset = jitter;
      for (const part of item.parts) {
        add(part, at(offset), part.plannedDurationMs);
        offset += part.plannedDurationMs;
      }
      continue;
    }
    if (item.kind === 'episode' && i % 2 === 0) {
      add(item, at(jitter), len, { fallback: 'latest_episode', title: 'Latest episode' });
      continue;
    }
    if (i % 17 === 5) continue; // passed over: not aired
    if (i % 19 === 7) {
      // The log ran dry here: the safety playlist held the slot.
      add(null, at(1_000), len + 4_000, {
        source: 'safety',
        title: 'Safety playlist',
        engineItemId: null,
      });
      continue;
    }
    if (i % 13 === 3) {
      add(item, at(jitter), Math.round(len * 0.6)); // cut
      continue;
    }
    if (i % 29 === 11) {
      add(item, at(jitter), 3_000); // skipped
      continue;
    }
    if (i % 31 === 13) {
      add(item, at(45_000), len); // late
      continue;
    }
    if (i % 37 === 17) {
      // The engine restarted mid-item; it aired again after the reboot.
      const first = Math.round(len / 3);
      add(item, at(jitter), first, { outcome: 'interrupted', endSeq: null });
      add(item, at(jitter + first + 20_000), len);
      continue;
    }
    add(item, at(jitter), len);
  }

  await db.insert(asRunEntry).values(rows);
  return `as-run fixture written: ${date} (${rows.length} entries)`;
}
