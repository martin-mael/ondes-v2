import { describe, expect, it } from 'vitest';
import { type FeedEntry, planFeed } from '../engine/feeder/plan.ts';

// The log's side of "back from live" (#64, ADR 0027): what the feeder (ADR 0012) keeps queued
// while a DJ is on air, and so what the engine plays once the gate closes. The engine side
// (the interrupted track is dropped, the queue plays next) is the recorded engine test.
// While live is on air the engine reports `on_air.source = live`: the log isn't on air.

const MIN = 60_000;
const T0 = Date.parse('2026-11-05T19:00:00Z');

function song(id: string, plannedStartMs: number, slotMs = 3 * MIN): FeedEntry {
  return {
    id,
    kind: 'song',
    plannedStartMs,
    slotMs,
    timing: 'flow',
    anchorAtMs: null,
    capMs: null,
    parts: [],
    unplayable: null,
    flexMs: slotMs - 30_000,
  };
}

/** Ten 3-minute songs from 19:00. */
const log = Array.from({ length: 10 }, (_, i) => song(`s${i}`, T0 + i * 3 * MIN));
const live = (elapsedMs: number) => ({
  itemId: null,
  segmentId: null,
  source: 'live' as const,
  elapsedMs,
});

describe('resuming the log after a live show', () => {
  it('resumes at the current time: what was planned during the show is passed over', () => {
    // s1 was on air when the DJ took over at 19:04; it's 19:13 now.
    const nowMs = T0 + 13 * MIN;
    const plan = planFeed({
      nowMs,
      onAir: live(9 * MIN),
      entries: log,
      aired: new Set(['s0', 's1']),
    });
    // s4 was planned at 19:12, a minute ago: it starts now. s2 and s3 are gone.
    expect(plan.onAirIndex).toBeNull();
    expect(plan.wanted.map((w) => w.entry.id).slice(0, 3)).toEqual(['s4', 's5', 's6']);
    expect(plan.wanted[0]?.startMs).toBe(nowMs);
  });

  it('never replays the track the DJ interrupted, even if it is still within the join window', () => {
    // s1 started at 19:03 and aired; the DJ took over at 19:03:30 and left at 19:03:50.
    const nowMs = T0 + 3 * MIN + 50_000;
    const plan = planFeed({
      nowMs,
      onAir: live(20_000),
      entries: log,
      aired: new Set(['s0', 's1']),
    });
    expect(plan.wanted[0]?.entry.id).toBe('s2');
  });

  it('keeps the log in order: a later re-plan only drops from the head, never reorders', () => {
    const aired = new Set(['s0', 's1']);
    const at = (min: number) =>
      planFeed({ nowMs: T0 + min * MIN, onAir: live(min * MIN), entries: log, aired }).wanted.map(
        (w) => w.entry.id,
      );
    const early = at(7);
    const late = at(13);
    expect(early.slice(0, 2)).toEqual(['s2', 's3']);
    // Every entry still wanted later is in the same relative order as before.
    const common = late.filter((id) => early.includes(id));
    expect(common).toEqual(early.filter((id) => common.includes(id)));
    expect(late[0]).toBe('s4');
  });
});
