import type { OnAir, StreamEventType } from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useSse, useSseEvent, useSseStatus } from '../../../app/sse/sse.tsx';
import { onAirKey, onAirQuery } from './api.ts';
import { nextTickAt } from './time.ts';

// Keeps the on-air snapshot current and the counters on the engine's time (#70, ADR 0034).
// No polling: the snapshot is refetched on the events that change it, on a reconnect (events
// were missed), and once at the instants it said something changes (a show ends, the next
// fixed event is due), where no event may come.

/** The events after which the snapshot is stale. */
const REFRESH_ON: ReadonlySet<StreamEventType> = new Set<StreamEventType>([
  'asrun.started',
  'asrun.ended',
  'engine.track.started',
  'engine.up',
  'engine.down',
  'engine.booted',
  'log.updated',
  'log.item.changed',
  'live.session.started',
  'live.session.ended',
  'feeder.item.passed_over',
]);

/** Past the instants the snapshot names, so the api sees the change too. */
const BOUNDARY_SLACK_MS = 1_500;

export function useOnAir(stationId: string) {
  const query = useQuery(onAirQuery(stationId));
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: onAirKey(stationId) });

  useSse((event) => {
    if (REFRESH_ON.has(event.type)) refresh();
  });

  const status = useSseStatus();
  const opened = useRef(false);
  const previous = useRef(status);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` is stable in effect.
  useEffect(() => {
    if (status === 'open' && previous.current !== 'open' && opened.current) refresh();
    if (status === 'open') opened.current = true;
    previous.current = status;
  }, [status]);

  const snapshot = query.data;
  const boundary = snapshot ? nextBoundary(snapshot) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` is stable in effect.
  useEffect(() => {
    if (boundary === null || !snapshot) return;
    const sinceFetch = Date.now() - query.dataUpdatedAt;
    const delay = boundary - Date.parse(snapshot.at) - sinceFetch + BOUNDARY_SLACK_MS;
    // Timers clamp past 24.8 days; nothing here is that far.
    const timer = setTimeout(refresh, Math.max(0, delay));
    return () => clearTimeout(timer);
  }, [boundary, snapshot?.at, query.dataUpdatedAt]);

  return query;
}

/** The soonest instant after the snapshot's own at which it changes without an event. */
function nextBoundary(s: OnAir): number | null {
  const at = Date.parse(s.at);
  const instants = [s.show?.endsAt, s.nextHardEvent?.at]
    .filter((v): v is string => typeof v === 'string')
    .map(Date.parse)
    .filter((t) => t > at);
  return instants.length ? Math.min(...instants) : null;
}

/**
 * The api's time in ms (the engine's: same host clock, ADR 0034), from the offset of the last
 * `server.clock` event, re-rendered at the next whole second of any of `anchors`. `null` until
 * the stream gave the first `server.clock`.
 */
export function useEngineNow(anchors: readonly number[]): number | null {
  const [offset, setOffset] = useState<number | null>(null);
  useSseEvent('server.clock', (event) => setOffset(Date.parse(event.at) - Date.now()));
  const [now, setNow] = useState<number | null>(null);
  const key = anchors.join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `anchors`.
  useEffect(() => {
    if (offset === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const current = Date.now() + offset;
      setNow(current);
      // A couple of ms past the boundary, so the floor lands on the new second.
      timer = setTimeout(tick, nextTickAt(current, [0, ...anchors]) - current + 2);
    };
    tick();
    return () => clearTimeout(timer);
  }, [offset, key]);
  return offset === null ? null : now;
}
