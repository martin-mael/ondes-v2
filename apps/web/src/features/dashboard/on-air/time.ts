import type { OnAir, OnAirHardEvent, OnAirNextItem } from '@ondes/shared';

// Time arithmetic of the on-air widget (#70, ADR 0034). Pure, so the 1 s budget is tested
// without rendering. Every instant is in ms on the api's clock, which is the engine's.

/**
 * When the display next changes: the soonest whole second after `now` counted from any of
 * `anchors` (0 for the wall clock, an item's start for its elapsed time, an event for its
 * countdown). Waking exactly then keeps every counter within a few ms of the engine instead of
 * up to a second behind with a plain 1 s interval.
 */
export function nextTickAt(now: number, anchors: readonly number[]): number {
  let next = Number.POSITIVE_INFINITY;
  for (const anchor of anchors) {
    const into = (((now - anchor) % 1000) + 1000) % 1000;
    next = Math.min(next, now + (1000 - into));
  }
  return next;
}

/** Whole seconds from `from` to `to` (floored), never negative. */
export const secondsBetween = (from: number, to: number) =>
  Math.max(0, Math.floor((to - from) / 1000));

/** `m:ss`, or `h:mm:ss` from an hour. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export interface Progress {
  elapsed: number;
  /** Null without an expected length. */
  remaining: number | null;
  /** 0–100, null without an expected length. */
  percent: number | null;
}

/**
 * Elapsed and remaining seconds of an item that started at `startedAt` and should last
 * `durationMs`. Remaining counts down to the expected end (ceil), so elapsed + remaining is the
 * length whatever the millisecond phase; it stays at 0 while the item overruns.
 */
export function progressOf(startedAt: number, durationMs: number | null, now: number): Progress {
  const elapsed = secondsBetween(startedAt, now);
  if (durationMs == null || durationMs <= 0) return { elapsed, remaining: null, percent: null };
  const end = startedAt + durationMs;
  const remaining = Math.max(0, Math.ceil((end - now) / 1000));
  const percent = Math.min(100, Math.max(0, ((now - startedAt) / durationMs) * 100));
  return { elapsed, remaining, percent };
}

/** Seconds left until `at` (ceil: `0:01` shows during the last second), never negative. */
export const countdown = (at: number, now: number) => Math.max(0, Math.ceil((at - now) / 1000));

/**
 * The soonest instant after the snapshot was taken at which it changes with no event to say
 * so: the show block ends, or the next fixed event is due. Null when neither comes.
 */
export function nextBoundary(s: OnAir): number | null {
  const at = Date.parse(s.at);
  const instants = [s.show?.endsAt, s.nextHardEvent?.at]
    .filter((v): v is string => typeof v === 'string')
    .map(Date.parse)
    .filter((t) => t > at);
  return instants.length ? Math.min(...instants) : null;
}

/**
 * The snapshot's next items, still right while the item on air overruns. The api chained them
 * from the later of the item's expected end and its own time; every second past both pushes
 * the `flow` items further, up to the first anchored one (it keeps its time, ADR 0003). A
 * marker among them moves with them, and with it the next event.
 */
export function withOverrun(
  s: OnAir,
  now: number,
): { next: OnAirNextItem[]; nextHardEvent: OnAirHardEvent | null } {
  const unchanged = { next: s.next, nextHardEvent: s.nextHardEvent };
  const current = s.current;
  if (current?.source !== 'log' || current.durationMs == null) return unchanged;
  const expectedEnd = Date.parse(current.startedAt) + current.durationMs;
  const lag = now - Math.max(expectedEnd, Date.parse(s.at));
  if (lag <= 0) return unchanged;
  let anchored = false;
  const next = s.next.map((item) => {
    anchored ||= item.timing !== 'flow';
    if (anchored) return item;
    return {
      ...item,
      estimatedStart: new Date(Date.parse(item.estimatedStart) + lag).toISOString(),
    };
  });
  const event = s.nextHardEvent;
  const moved = event?.logItemId ? next.find((i) => i.logItemId === event.logItemId) : undefined;
  return {
    next,
    nextHardEvent: event && moved ? { ...event, at: moved.estimatedStart } : event,
  };
}
