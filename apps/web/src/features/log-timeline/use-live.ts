import type { AsRunEntry, FeederItemPassedOverEvent, LocalDate } from '@ondes/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useServerClock, useSseEvent } from '../../app/sse/sse.tsx';
import { asRunDayQuery, logKey } from './api.ts';
import { dayBounds } from './time.ts';

// Keeps the timeline current (#51) from the station's real-time events:
// - `log.updated`: refetch the log days it touched (events carry no full state, by contract);
// - `asrun.started` / `asrun.ended`: patch the day's as-run, which moves the on-air highlight;
// - `feeder.item.passed_over`: remembered for the page's lifetime (the event is transient and
//   as-run doesn't record it).

export type PassedOver = FeederItemPassedOverEvent['data'];

export function useTimelineLive(stationId: string, date: LocalDate, timeZone: string) {
  const bounds = dayBounds(date, timeZone);
  const queryClient = useQueryClient();
  const [passedOver, setPassedOver] = useState<ReadonlyMap<string, PassedOver>>(new Map());

  useSseEvent('log.updated', (event) => {
    for (const day of event.data.days) {
      void queryClient.invalidateQueries({ queryKey: [...logKey(stationId), day.localDate] });
    }
    // A day created by the edit isn't loaded under its date yet when the event names none.
    if (event.data.days.length === 0) {
      void queryClient.invalidateQueries({ queryKey: logKey(stationId) });
    }
  });

  const upsert = (entry: AsRunEntry) => {
    const key = asRunDayQuery(stationId, date).queryKey;
    const current = queryClient.getQueryData<AsRunEntry[]>(key);
    if (!current) return;
    // An entry of another day stays out (it shows when that day is open).
    const at = Date.parse(entry.startedAt);
    if (at < bounds.start || at >= bounds.end) return;
    queryClient.setQueryData<AsRunEntry[]>(key, [
      ...current.filter((e) => e.id !== entry.id),
      entry,
    ]);
  };
  useSseEvent('asrun.started', (event) => {
    upsert(event.data);
    // A new start also closes the previous entry server-side; its `ended` may come later.
    void queryClient.invalidateQueries({ queryKey: asRunDayQuery(stationId, date).queryKey });
  });
  useSseEvent('asrun.ended', (event) => upsert(event.data));

  useSseEvent('feeder.item.passed_over', (event) => {
    setPassedOver((map) => new Map(map).set(event.data.itemId, event.data));
  });

  return { passedOver };
}

/** The api's clock when the stream gave it, else the browser's; ticks every second. */
export function useNow(): number {
  const server = useServerClock();
  const [local, setLocal] = useState(() => Date.now());
  useEffect(() => {
    if (server) return;
    const timer = setInterval(() => setLocal(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [server]);
  return server?.getTime() ?? local;
}
