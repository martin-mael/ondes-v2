import {
  type ClockSlot,
  clockSlotSchema,
  type LocalDate,
  localDayBounds,
  logDayItemInputSchema,
} from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { backTiming } from '../backtiming/backtime.ts';
import { BEDS_CATEGORY_ID, hardStartSnapshot } from '../backtiming/fixture.ts';
import { CATEGORY_IDS, FIXTURE_TZ, HOUR_CLOCK_ID } from '../generator/fixture.ts';
import { generateDay } from '../generator/generate.ts';
import type {
  GeneratedDay,
  GeneratedItem,
  GeneratorSnapshot,
  KeptItem,
} from '../generator/types.ts';
import { keepReasons, regenPolicy } from '../regen/policy.ts';
import { resolveMarkers } from './resolve.ts';

// Fixed-time markers through the generator (#52, ADR 0036): a clock with a hard top of the
// hour, soft news at :30 (30 s cap) and a not-before ID at :45, each followed by a jingle,
// planned with back-timing as the `log-generate` job does. The feeder's side (planning and the
// engine) is in apps/api's feeder tests and engine/tests/markers.

const HOUR = 3_600_000;
const MINUTE = 60_000;
/** Last Sunday of March and of October 2026, Europe/Paris: 23 and 25 hours. */
const SPRING = '2026-03-29';
const AUTUMN = '2026-10-25';
const DATE = '2026-06-10';

const slot = (input: Record<string, unknown>): ClockSlot => clockSlotSchema.parse(input);
const music = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    slot({
      kind: 'category',
      categoryId: [CATEGORY_IDS.current, CATEGORY_IDS.gold, CATEGORY_IDS.recurrent][i % 3],
    }),
  );
const jingle = () => slot({ kind: 'jingle', categoryId: CATEGORY_IDS.jingles });

const MARKERS = [
  { offsetMs: 0, timing: 'hard', label: 'Top of hour' },
  { offsetMs: 30 * MINUTE, timing: 'soft', capMs: 30_000, label: 'News' },
  { offsetMs: 45 * MINUTE, timing: 'not_before', label: 'ID at :45' },
] as const;

/** The hour: each marker, its jingle, music up to the next marker; beds fill (back-timing). */
function markerSnapshot(dates: readonly LocalDate[]): GeneratorSnapshot {
  const base = hardStartSnapshot(dates, { shows: [] });
  const slots = [
    slot({ kind: 'marker', ...MARKERS[0] }),
    jingle(),
    ...music(9),
    slot({ kind: 'marker', ...MARKERS[1] }),
    jingle(),
    ...music(5),
    slot({ kind: 'marker', ...MARKERS[2] }),
    jingle(),
    ...music(5),
    slot({ kind: 'fill', categoryId: BEDS_CATEGORY_ID }),
  ];
  return {
    ...base,
    clocks: new Map([[HOUR_CLOCK_ID, { id: HOUR_CLOCK_ID, targetDurationMs: HOUR, slots }]]),
  };
}

const top = (day: GeneratedDay) => day.items.filter((i) => i.segmentId === null);
const end = (i: GeneratedItem) => i.plannedStart.getTime() + i.plannedDurationMs;
const markersOf = (day: GeneratedDay) => top(day).filter((i) => i.kind === 'marker');
const generate = (snapshot: GeneratorSnapshot, date: LocalDate) =>
  generateDay(snapshot, date, { extensions: backTiming(snapshot) });

/** Each marker's run ends at its time, the jingle after it starts there. */
function expectOnTime(day: GeneratedDay) {
  const items = top(day);
  for (const marker of markersOf(day)) {
    const i = items.indexOf(marker);
    const at = marker.anchorAt?.getTime();
    expect(marker.conflict).toBeNull();
    expect(marker.plannedStart.getTime()).toBe(at);
    const before = items[i - 1];
    if (before) expect(end(before)).toBe(at);
    expect(items[i + 1]).toMatchObject({ kind: 'jingle', timing: 'flow' });
    expect(items[i + 1]?.plannedStart.getTime()).toBe(at);
  }
}

describe('markers in the generator', () => {
  it('plans every marker of every hour with its timing, label and cap', () => {
    const day = generate(markerSnapshot([DATE]), DATE);
    const markers = markersOf(day);
    expect(markers).toHaveLength(24 * 3);
    const { startsAt } = localDayBounds(DATE, FIXTURE_TZ);
    markers.forEach((m, n) => {
      const spec = MARKERS[n % 3] as (typeof MARKERS)[number];
      expect(m).toMatchObject({
        timing: spec.timing,
        title: spec.label,
        capMs: spec.timing === 'soft' ? 30_000 : null,
        plannedDurationMs: 0,
      });
      expect(m.anchorAt?.getTime()).toBe(
        startsAt.getTime() + Math.floor(n / 3) * HOUR + spec.offsetMs,
      );
    });
    for (const m of markers) {
      const parsed = logDayItemInputSchema.safeParse({
        kind: m.kind,
        plannedDurationMs: m.plannedDurationMs,
        title: m.title,
        timing: m.timing,
        anchorAt: m.anchorAt?.toISOString() ?? null,
        capMs: m.capMs,
        origin: m.origin,
      });
      expect(parsed.error?.issues ?? []).toEqual([]);
    }
  });

  it('back-times the music to every marker, not-before included', () => {
    const snapshot = markerSnapshot([DATE]);
    const day = generate(snapshot, DATE);
    expectOnTime(day);
    // Before each marker, a sized bed takes what the songs leave.
    const items = top(day);
    for (const marker of markersOf(day)) {
      const before = items[items.indexOf(marker) - 1];
      if (before) expect(before.kind).toBe('fill');
    }
    // Without back-timing, the not-before ID waits for its time: the gap back-timing closes.
    const raw = generateDay(snapshot, DATE);
    const ids = markersOf(raw).filter((m) => m.timing === 'not_before');
    expect(ids.some((m) => m.conflict?.kind === 'gap')).toBe(true);
  });

  it.each([
    [SPRING, 23],
    [AUTUMN, 25],
  ])('anchors the markers of every real hour on %s (%i hours)', (date, hours) => {
    const day = generate(markerSnapshot([date]), date);
    const markers = markersOf(day);
    expect(markers).toHaveLength(hours * 3);
    const { startsAt, endsAt } = localDayBounds(date, FIXTURE_TZ);
    expect(endsAt.getTime() - startsAt.getTime()).toBe(hours * HOUR);
    // Paris offsets are whole hours: each real hour starts a whole number of hours after
    // midnight, the repeated 02:00 (October) and the missing one (March) included.
    const anchors = markers.map((m) => m.anchorAt?.getTime());
    const expected = Array.from({ length: hours }, (_, h) =>
      MARKERS.map((s) => startsAt.getTime() + h * HOUR + s.offsetMs),
    ).flat();
    expect(anchors).toEqual(expected);
    expect(new Set(anchors).size).toBe(anchors.length);
    expectOnTime(day);
  });

  it('times the item after each marker in the feeder view, across the DST hour', () => {
    const day = generate(markerSnapshot([AUTUMN]), AUTUMN);
    const entries = top(day).map((i, n) => ({
      id: String(n),
      kind: i.kind,
      timing: i.timing,
      anchorAtMs: i.anchorAt?.getTime() ?? null,
      capMs: i.capMs,
    }));
    const resolved = resolveMarkers(entries);
    const timed = resolved.filter((e) => e.markerId !== undefined);
    expect(timed).toHaveLength(25 * 3);
    for (const e of timed) {
      const marker = entries[Number(e.markerId)];
      expect(e.kind).toBe('jingle');
      expect([e.timing, e.anchorAtMs, e.capMs]).toEqual([
        marker?.timing,
        marker?.anchorAtMs,
        marker?.capMs,
      ]);
    }
    expect(resolved.filter((e) => e.kind === 'marker').every((e) => e.timing === 'flow')).toBe(
      true,
    );
  });
});

describe('markers through regeneration', () => {
  const snapshot = markerSnapshot([DATE]);
  const { startsAt } = localDayBounds(DATE, FIXTURE_TZ);
  const kept = (item: GeneratedItem, id: string, reasons: KeptItem['reasons']): KeptItem => ({
    id,
    kind: item.kind,
    plannedStart: item.plannedStart,
    plannedDurationMs: item.plannedDurationMs,
    timing: item.timing,
    anchorAt: item.anchorAt,
    segmentId: null,
    crossOutMs: null,
    showSlotId: null,
    reasons,
    played: null,
  });

  it('keeps the markers before the freeze point and plans the same ones after it', () => {
    const first = generate(snapshot, DATE);
    const now = new Date(startsAt.getTime() + 9.5 * HOUR);
    const policy = regenPolicy(now);
    const keep: KeptItem[] = [];
    top(first).forEach((item, n) => {
      const reasons = keepReasons(
        {
          plannedStart: item.plannedStart,
          originType: item.origin.type,
          locked: false,
          inSegue: false,
          hasFallbackMark: false,
        },
        policy,
      );
      if (reasons.length) keep.push(kept(item, `kept-${n}`, reasons));
    });
    const again = generate(
      { ...snapshot, rules: [], frozenUntil: policy.frozenUntil, kept: new Map([[DATE, keep]]) },
      DATE,
    );
    const frozen = policy.frozenUntil.getTime();
    const before = markersOf(again).filter((m) => (m.anchorAt?.getTime() ?? 0) < frozen);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((m) => m.keptId?.startsWith('kept-'))).toBe(true);
    // Every marker of the day is still there, at the same times.
    expect(markersOf(again).map((m) => [m.timing, m.anchorAt?.getTime()])).toEqual(
      markersOf(first).map((m) => [m.timing, m.anchorAt?.getTime()]),
    );
    // Nothing new is planned before the freeze point.
    for (const item of top(again)) {
      if (item.keptId === null) expect(item.plannedStart.getTime()).toBeGreaterThanOrEqual(frozen);
    }
    for (const m of markersOf(again).filter((x) => (x.anchorAt?.getTime() ?? 0) >= frozen + HOUR)) {
      expect(m.conflict).toBeNull();
    }
  });

  it('keeps a marker added by hand, and back-times the music to it', () => {
    const at = new Date(startsAt.getTime() + 14 * HOUR + 20 * MINUTE);
    const manual: KeptItem = {
      id: 'manual-marker',
      kind: 'marker',
      plannedStart: at,
      plannedDurationMs: 0,
      timing: 'not_before',
      anchorAt: at,
      segmentId: null,
      crossOutMs: null,
      showSlotId: null,
      reasons: keepReasons(
        {
          plannedStart: at,
          originType: 'manual',
          locked: false,
          inSegue: false,
          hasFallbackMark: false,
        },
        { manual: true },
      ),
      played: null,
    };
    expect(manual.reasons).toEqual(['manual']);
    const day = generate({ ...snapshot, kept: new Map([[DATE, [manual]]]) }, DATE);
    const items = top(day);
    const i = items.findIndex((x) => x.keptId === 'manual-marker');
    const marker = items[i] as GeneratedItem;
    expect(marker.plannedStart).toEqual(at);
    expect(marker.conflict).toBeNull();
    expect(end(items[i - 1] as GeneratedItem)).toBe(at.getTime());
    // The clock's own markers are all still planned around it.
    expect(markersOf(day)).toHaveLength(24 * 3 + 1);
  });
});
