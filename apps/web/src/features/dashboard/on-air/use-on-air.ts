import type { StreamEventType } from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useClockOffset, useSse, useSseStatus } from '../../../app/sse/sse.tsx';
import { onAirKey, onAirQuery } from './api.ts';
import { nextBoundary, nextTickAt } from './time.ts';

// Keeps the on-air snapshot current and the counters on the engine's time (#70, ADR 0034).
// No polling: the snapshot is refetched on the events that change it, whenever the stream
// (re)opens (events may have been missed), and once at the instants it said something changes
// (a show ends, the next fixed event is due), where no event may come.

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
  // Cue edits (intro/outro markers) and the station's own settings (its timezone).
  'asset.updated',
  'station.updated',
]);

/** Events come in bursts (`log.item.changed` per item of an edit): one refetch per burst. */
export const REFRESH_DEBOUNCE_MS = 250;

/** Past the instants the snapshot names, so the api sees the change too. */
const BOUNDARY_SLACK_MS = 1_500;

export function useOnAir(stationId: string) {
  const query = useQuery(onAirQuery(stationId));
  const queryClient = useQueryClient();
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = () => {
    clearTimeout(pending.current);
    pending.current = setTimeout(
      () => void queryClient.invalidateQueries({ queryKey: onAirKey(stationId) }),
      REFRESH_DEBOUNCE_MS,
    );
  };
  useEffect(() => () => clearTimeout(pending.current), []);

  useSse((event) => {
    if (REFRESH_ON.has(event.type)) refresh();
  });

  // Every time the stream opens, the first included: an event that came before it (a cold load
  // racing the snapshot) or during a drop was missed.
  const status = useSseStatus();
  const previous = useRef(status);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` is stable in effect.
  useEffect(() => {
    if (status === 'open' && previous.current !== 'open') refresh();
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

/**
 * The api's time in ms (the engine's: same host clock, ADR 0034), from the open stream's
 * `server.clock` offset, re-rendered at the next whole second of any of `anchors`. `null`
 * until the stream has given its first `server.clock`.
 */
export function useEngineNow(anchors: readonly number[]): number | null {
  const offset = useClockOffset();
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
  // The first render after mount: no tick yet, but the offset is known.
  return offset === null ? null : (now ?? Date.now() + offset);
}
