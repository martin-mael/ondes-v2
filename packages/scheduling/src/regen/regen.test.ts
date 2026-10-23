import { type LocalDate, localDayBounds } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { FIXTURE_TZ, fixtureSnapshot } from '../generator/fixture.ts';
import { generateDay } from '../generator/generate.ts';
import type {
  GeneratedDay,
  GeneratorSnapshot,
  KeptItem,
  KeptReason,
} from '../generator/types.ts';
import { type CurrentDay, type CurrentItem, diffDay, sameDay } from './diff.ts';
import {
  consecutiveChunks,
  dateRange,
  earlierFrom,
  horizonDates,
  horizonWork,
  regenDueAt,
} from './horizon.ts';
import { alertedIssues, generationAlertKey, issueCounts } from './issues.ts';
import {
  type KeepPolicy,
  type KeptPin,
  keepReasons,
  keptStart,
  REGEN_FREEZE_MS,
  regenPolicy,
} from './policy.ts';

// Regeneration end to end on the pure side (#101, ADR 0030): a day is generated, "written"
// (ids given, as `writeGeneratedDay` does), then regenerated with the kept items the policy
// picks from it. The db and worker tests cover the same loop on a real database.

const DATE = '2026-06-10';
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** Last Sunday of March and of October 2026, Europe/Paris: 23 and 25 hours. */
const SPRING = '2026-03-29';
const AUTUMN = '2026-10-25';

const snapshot = fixtureSnapshot({ songs: 600 });

let nextId = 0;
const newId = () => `00000000-0000-7000-8ab0-${(++nextId).toString(16).padStart(12, '0')}`;

/** Pins the writer records for kept items, by id. */
const pins = new Map<string, KeptPin>();

/** What the writer leaves in the database for a generated day. */
function write(day: GeneratedDay, locked: ReadonlySet<string> = new Set()): CurrentDay {
  for (const g of day.items) {
    if (g.keptId) pins.set(g.keptId, { start: g.start, settledStart: g.plannedStart });
  }
  return {
    seed: day.seed,
    generatorVersion: day.generatorVersion,
    items: day.items.map(
      (g): CurrentItem => ({
        id: g.keptId ?? newId(),
        position: g.position,
        kind: g.kind,
        plannedStart: g.plannedStart,
        plannedDurationMs: g.plannedDurationMs,
        assetId: g.assetId,
        episodeId: g.episodeId,
        liveSlotId: g.liveSlotId,
        title: g.title,
        cueOverrides: null,
        timing: g.timing,
        anchorAt: g.anchorAt,
        capMs: g.capMs,
        origin: g.origin,
        locked: g.keptId !== null && locked.has(g.keptId),
        relaxedRules: g.relaxedRules,
        segmentId: g.segmentId,
        conflict: g.conflict,
      }),
    ),
  };
}

/** The kept items the loader would hand the generator for `current` under `policy`. */
function keptOf(current: CurrentDay, policy: KeepPolicy) {
  const reasons = new Map<string, KeptReason[]>();
  const kept: KeptItem[] = [];
  for (const item of current.items) {
    const r = keepReasons(
      {
        plannedStart: item.plannedStart,
        originType: item.origin.type,
        locked: item.locked,
        inSegue: false,
        hasFallbackMark: false,
      },
      policy,
    );
    if (r.length === 0) continue;
    reasons.set(item.id, r);
    const asset = item.assetId ? snapshot.assets.get(item.assetId) : undefined;
    const category = [...snapshot.categories.values()].find((c) =>
      c.members.some((m) => m.id === item.assetId),
    );
    const member = category?.members.find((m) => m.id === item.assetId) ?? asset;
    kept.push({
      id: item.id,
      kind: item.kind,
      plannedStart: keptStart(item.plannedStart, pins.get(item.id)),
      plannedDurationMs: item.plannedDurationMs,
      timing: item.timing,
      anchorAt: item.anchorAt,
      segmentId: item.segmentId,
      crossOutMs: null,
      showSlotId: item.origin.type === 'show' ? item.origin.showSlotId : null,
      reasons: r,
      played: member
        ? {
            assetId: member.id,
            type: member.type,
            title: member.title,
            artists: member.artists,
            album: member.album,
            tags: member.tags,
            at: item.plannedStart,
          }
        : null,
    });
  }
  return { kept, reasons };
}

function regenerate(
  base: GeneratorSnapshot,
  date: LocalDate,
  current: CurrentDay,
  policy: KeepPolicy,
) {
  const { kept, reasons } = keptOf(current, policy);
  const day = generateDay({ ...base, kept: new Map([[date, kept]]) }, date);
  return { day, reasons };
}

describe('keepReasons', () => {
  const at = new Date('2026-06-10T10:00:00Z');
  const item = {
    plannedStart: at,
    originType: 'clock' as const,
    locked: false,
    inSegue: false,
    hasFallbackMark: false,
  };

  it('keeps what starts before the freeze point, locked items, segue ends, marks, manual edits', () => {
    expect(keepReasons(item)).toEqual([]);
    expect(keepReasons(item, { frozenUntil: new Date(at.getTime() + 1) })).toEqual(['past']);
    expect(keepReasons(item, { frozenUntil: at })).toEqual([]);
    expect(keepReasons({ ...item, locked: true, inSegue: true, hasFallbackMark: true })).toEqual([
      'locked',
      'segue',
      'fallback',
    ]);
    expect(keepReasons({ ...item, originType: 'manual' })).toEqual([]);
    expect(keepReasons({ ...item, originType: 'manual' }, { manual: true })).toEqual(['manual']);
  });

  it('plans a kept item around its pin while it sits where the pin says', () => {
    const pin = { start: at, settledStart: new Date(at.getTime() + 5_000) };
    expect(keptStart(pin.settledStart, pin)).toBe(at);
    expect(keptStart(new Date(at.getTime() + 9_000), pin).getTime()).toBe(at.getTime() + 9_000);
    expect(keptStart(at, null)).toBe(at);
  });

  it('freezes the next hour', () => {
    expect(regenPolicy(at)).toEqual({
      frozenUntil: new Date(at.getTime() + REGEN_FREEZE_MS),
      manual: true,
    });
  });
});

describe('regenerating a day', () => {
  const before = new Date('2026-06-01T00:00:00Z');

  it('twice with the same seed and inputs is a no-op', () => {
    const first = generateDay(snapshot, DATE);
    const current = write(first);
    const { day, reasons } = regenerate(snapshot, DATE, current, regenPolicy(before));
    expect(sameDay(current, day)).toBe(true);
    const diff = diffDay(current, day, reasons);
    expect(diff.change).toBe('unchanged');
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.moved).toEqual([]);
    expect(diff.unchangedCount).toBe(current.items.length);
  });

  it('keeps locked items with their ids through any regeneration, and settles', () => {
    const current = write(generateDay(snapshot, DATE));
    const songs = current.items.filter((i) => i.kind === 'song');
    const locks = [songs[10], songs[11], songs[60]].map((s) => s?.id as string);
    const locked: CurrentDay = {
      ...current,
      items: current.items.map((i) => (locks.includes(i.id) ? { ...i, locked: true } : i)),
    };
    for (const seed of ['a', 'b', 'c']) {
      const { kept } = keptOf(locked, regenPolicy(before));
      const day = generateDay({ ...snapshot, kept: new Map([[DATE, kept]]) }, DATE, { seed });
      const ids = day.items.flatMap((i) => (i.keptId ? [i.keptId] : []));
      expect(ids).toEqual(locks);
      // Written, then regenerated with the same seed: nothing changes.
      const written = write(day, new Set(locks));
      const again = keptOf(written, regenPolicy(before));
      const twice = generateDay({ ...snapshot, kept: new Map([[DATE, again.kept]]) }, DATE, {
        seed,
      });
      expect(sameDay(written, twice)).toBe(true);
    }
  });

  it('keeps every item starting before the freeze point and plans after it', () => {
    const current = write(generateDay(snapshot, DATE));
    const now = new Date(localDayBounds(DATE, FIXTURE_TZ).startsAt.getTime() + 9.5 * HOUR);
    const policy = regenPolicy(now);
    const frozen = policy.frozenUntil.getTime();
    const changed = { ...snapshot, rules: [] };
    const { day, reasons } = regenerate(changed, DATE, current, policy);
    const kept = current.items.filter((i) => i.plannedStart.getTime() < frozen);
    expect(kept.length).toBeGreaterThan(0);
    expect(day.items.slice(0, kept.length).map((i) => i.keptId)).toEqual(kept.map((i) => i.id));
    for (const item of day.items.slice(kept.length)) {
      expect(item.keptId).toBeNull();
      expect(item.plannedStart.getTime()).toBeGreaterThanOrEqual(frozen - 10 * MINUTE);
    }
    const diff = diffDay(current, day, reasons);
    expect(diff.kept.past).toBe(kept.length);
    for (const removed of diff.removed) {
      expect(removed.plannedStart.getTime()).toBeGreaterThanOrEqual(frozen);
    }
  });

  it('keeps manual edits', () => {
    const current = write(generateDay(snapshot, DATE));
    const target = current.items.filter((i) => i.kind === 'song')[30] as CurrentItem;
    const edited: CurrentDay = {
      ...current,
      items: current.items.map((i) =>
        i.id === target.id ? { ...i, origin: { type: 'manual' as const }, relaxedRules: [] } : i,
      ),
    };
    const { day, reasons } = regenerate(snapshot, DATE, edited, regenPolicy(before));
    expect(day.items.some((i) => i.keptId === target.id)).toBe(true);
    expect(diffDay(edited, day, reasons).kept.manual).toBe(1);
  });

  it.each([
    [SPRING, 23],
    [AUTUMN, 25],
  ])('regenerating the DST day %s (%i h) twice is a no-op', (date, hours) => {
    const first = generateDay(snapshot, date);
    expect(first.endsAt.getTime() - first.startsAt.getTime()).toBe(hours * HOUR);
    const current = write(first);
    // Frozen mid-day, past the change of time: kept items stay, the rest comes back the same.
    const now = new Date(first.startsAt.getTime() + 4 * HOUR);
    const { day } = regenerate(snapshot, date, current, regenPolicy(now));
    const settled = write(day);
    const { day: again } = regenerate(snapshot, date, settled, regenPolicy(now));
    expect(sameDay(settled, again)).toBe(true);
    const last = again.items.filter((i) => i.segmentId === null).at(-1);
    expect(last?.plannedStart.getTime()).toBeLessThan(again.endsAt.getTime());
  });
});

describe('diffDay', () => {
  it('reports added, removed, moved and relaxed items against the current day', () => {
    const current = write(generateDay(snapshot, DATE));
    const day = generateDay(snapshot, DATE, { seed: 'another' });
    const diff = diffDay(current, day);
    expect(diff.change).toBe('changed');
    expect(diff.added.length).toBeGreaterThan(0);
    expect(diff.removed.length).toBeGreaterThan(0);
    const top = current.items.filter((i) => i.segmentId === null).length;
    // Every current item is accounted for once: unchanged, moved or removed.
    expect(diff.unchangedCount + diff.moved.length + diff.removed.length).toBe(top);
    const newTop = day.items.filter((i) => i.segmentId === null).length;
    expect(diff.unchangedCount + diff.moved.length + diff.added.length).toBe(newTop);
    for (const m of diff.moved) expect(m.shiftMs).not.toBe(0);
    for (const r of diff.relaxed) expect(r.item.relaxedRules.length).toBeGreaterThan(0);
  });

  it('marks a day without a log as new, everything added', () => {
    const day = generateDay(snapshot, DATE);
    const diff = diffDay(null, day);
    expect(diff.change).toBe('new');
    expect(diff.added.length).toBe(day.items.filter((i) => i.segmentId === null).length);
  });

  it('flags a relaxed rule as new only when the current item had none', () => {
    const day = generateDay({ ...snapshot }, DATE);
    const current = write(day);
    const song = day.items.findIndex((i) => i.kind === 'song');
    const relaxedDay: GeneratedDay = {
      ...day,
      items: day.items.map((i, n) =>
        n === song ? { ...i, relaxedRules: [{ rule: 'artist_separation' }] } : i,
      ),
    };
    const diff = diffDay(current, relaxedDay);
    expect(diff.change).toBe('changed');
    expect(diff.relaxed).toHaveLength(1);
    expect(diff.relaxed[0]?.new).toBe(true);
  });

  it('sees a changed seed as a change even with the same items', () => {
    const day = generateDay(snapshot, DATE);
    const current = write(day);
    expect(sameDay({ ...current, seed: 'other' }, day)).toBe(false);
    expect(sameDay({ ...current, generatorVersion: '0' }, day)).toBe(false);
  });
});

describe('horizon', () => {
  it('counts station-local dates from today, across the DST changes', () => {
    // 23:30 UTC on 28 March is already 29 March in Paris (UTC+1, then +2 from 02:00).
    const now = new Date('2026-03-28T23:30:00Z');
    expect(horizonDates(now, 'Europe/Paris', 3)).toEqual([SPRING, '2026-03-30', '2026-03-31']);
    // 22:30 UTC on 24 October is 00:30 on 25 October in Paris (UTC+2 until 03:00).
    const autumn = new Date('2026-10-24T22:30:00Z');
    expect(horizonDates(autumn, 'Europe/Paris', 2)).toEqual([AUTUMN, '2026-10-26']);
    expect(horizonDates(new Date('2026-10-24T21:59:00Z'), 'Europe/Paris', 1)).toEqual([
      '2026-10-24',
    ]);
    expect(horizonDates(now, 'Europe/Paris', 0)).toEqual([]);
  });

  it('splits dates into runs of consecutive days for the jobs', () => {
    expect(dateRange('2026-03-28', '2026-03-31')).toHaveLength(4);
    expect(dateRange('2026-03-31', '2026-03-28')).toEqual([]);
    const dates = [...dateRange('2026-03-20', '2026-04-05'), '2026-04-10', '2026-04-11'];
    const chunks = consecutiveChunks(dates, 14);
    expect(chunks.map((c) => c.length)).toEqual([14, 3, 2]);
    expect(chunks[1]?.[0]).toBe('2026-04-03');
    expect(consecutiveChunks(['2026-01-03', '2026-01-01', '2026-01-02', '2026-01-02'], 14)).toEqual(
      [['2026-01-01', '2026-01-02', '2026-01-03']],
    );
  });

  it('generates missing days, and regenerates from a due change on', () => {
    const horizon = dateRange('2026-10-24', '2026-10-28');
    const existing = new Set(['2026-10-24', '2026-10-25', '2026-10-26']);
    expect(horizonWork({ horizon, existing })).toEqual({
      missing: ['2026-10-27', '2026-10-28'],
      regenerate: [],
    });
    expect(horizonWork({ horizon, existing, dueFrom: AUTUMN }).regenerate).toEqual([
      '2026-10-25',
      '2026-10-26',
    ]);
    expect(horizonWork({ horizon, existing, dueFrom: null }).regenerate).toEqual([
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
    ]);
    expect(horizonWork({ horizon, existing, dueFrom: '2026-01-01' }).regenerate).toHaveLength(3);
  });

  it('debounces changes, capped by the longest wait', () => {
    const first = new Date('2026-10-25T10:00:00Z');
    expect(regenDueAt({ firstRequestedAt: first, lastRequestedAt: first }).toISOString()).toBe(
      '2026-10-25T10:00:30.000Z',
    );
    const late = new Date('2026-10-25T10:04:50Z');
    expect(regenDueAt({ firstRequestedAt: first, lastRequestedAt: late }).toISOString()).toBe(
      '2026-10-25T10:05:00.000Z',
    );
    expect(earlierFrom('2026-10-25', '2026-10-24')).toBe('2026-10-24');
    expect(earlierFrom('2026-10-25', null)).toBeNull();
  });
});

describe('issues', () => {
  it('alerts on what needs a person, one key per day', () => {
    const at = new Date();
    const issues = [
      { code: 'no_clock' as const, at },
      { code: 'unfilled_slot' as const, at },
      { code: 'unfilled_slot' as const, at },
      { code: 'episode_missing' as const, at },
      { code: 'vt_placeholder' as const, at },
    ];
    const alerted = alertedIssues(issues);
    expect(issueCounts(alerted)).toEqual({ no_clock: 1, unfilled_slot: 2 });
    expect(generationAlertKey(DATE)).toBe('log.generation_issues:2026-06-10');
  });
});
