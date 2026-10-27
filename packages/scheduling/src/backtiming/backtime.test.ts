import { type LocalDate, logDayItemInputSchema } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { generateDay, generateDays, itemLengthMs } from '../generator/generate.ts';
import type {
  GeneratedDay,
  GeneratedItem,
  GeneratorSnapshot,
  KeptItem,
} from '../generator/types.ts';
import { backTiming, DEFAULT_BACK_TIMING } from './backtime.ts';
import { BEDS_CATEGORY_ID, datesFrom, HARD_START_SHOWS, hardStartSnapshot } from './fixture.ts';

const top = (day: GeneratedDay) => day.items.filter((i) => i.segmentId === null);
const shows = (day: GeneratedDay) => top(day).filter((i) => i.origin.type === 'show');
const end = (i: GeneratedItem) => i.plannedStart.getTime() + i.plannedDurationMs;

function assetLength(snapshot: GeneratorSnapshot, id: string | null): number {
  for (const c of snapshot.categories.values()) {
    const found = c.members.find((m) => m.id === id);
    if (found) return itemLengthMs(found);
  }
  throw new Error(`asset ${id} not in the snapshot`);
}

/** The items before each show, back to the previous anchored item. */
function tailBefore(day: GeneratedDay, show: GeneratedItem): GeneratedItem[] {
  const items = top(day);
  const at = items.indexOf(show);
  const out: GeneratedItem[] = [];
  for (let i = at - 1; i >= 0 && (items[i] as GeneratedItem).timing === 'flow'; i--) {
    out.unshift(items[i] as GeneratedItem);
  }
  return out;
}

describe('back-timing', () => {
  const dates = datesFrom('2026-06-08', 3);
  const snapshot = hardStartSnapshot(dates);

  it('ends the music on time before every show, with a sized fill', () => {
    for (const day of generateDays(snapshot, dates, { extensions: backTiming(snapshot) })) {
      expect(shows(day)).toHaveLength(HARD_START_SHOWS.length);
      for (const show of shows(day)) {
        const tail = tailBefore(day, show);
        const last = tail.at(-1) as GeneratedItem;
        // The run before ends exactly at the anchor: no gap, no overrun.
        expect(show.conflict).toBeNull();
        expect(end(last)).toBe(show.anchorAt?.getTime());
        expect(last.kind).toBe('fill');
        expect(last.origin).toMatchObject({ type: 'clock' });
        expect(last.plannedDurationMs).toBeGreaterThanOrEqual(DEFAULT_BACK_TIMING.minFillMs);
        expect(last.plannedDurationMs).toBeLessThanOrEqual(assetLength(snapshot, last.assetId));
      }
    }
  });

  it('only shortens songs within bounds, and leaves one fill per run', () => {
    const o = DEFAULT_BACK_TIMING;
    for (const day of generateDays(snapshot, dates, { extensions: backTiming(snapshot) })) {
      for (const show of shows(day)) {
        const tail = tailBefore(day, show);
        expect(tail.filter((i) => i.kind === 'fill')).toHaveLength(1);
        for (const item of tail.filter((i) => i.kind === 'song')) {
          const natural = assetLength(snapshot, item.assetId);
          const cut = natural - item.plannedDurationMs;
          expect(cut).toBeGreaterThanOrEqual(0);
          expect(cut).toBeLessThanOrEqual(o.maxSongCutMs);
          if (cut > 0) expect(item.plannedDurationMs).toBeGreaterThanOrEqual(o.minSongMs);
        }
      }
    }
  });

  it('leaves most fills room to stretch at runtime', () => {
    let fills = 0;
    let roomy = 0;
    for (const day of generateDays(snapshot, dates, { extensions: backTiming(snapshot) })) {
      for (const show of shows(day)) {
        const fill = tailBefore(day, show).at(-1) as GeneratedItem;
        fills++;
        const room = assetLength(snapshot, fill.assetId) - fill.plannedDurationMs;
        if (room >= DEFAULT_BACK_TIMING.fillHeadroomMs) roomy++;
      }
    }
    expect(roomy / fills).toBeGreaterThan(0.8);
  });

  it('writes items the bulk-write contract accepts', () => {
    const day = generateDay(snapshot, dates[0] as LocalDate, { extensions: backTiming(snapshot) });
    for (const item of top(day)) {
      const parsed = logDayItemInputSchema.safeParse({
        kind: item.kind,
        plannedDurationMs: item.plannedDurationMs,
        assetId: item.assetId,
        episodeId: item.episodeId,
        title: item.title,
        timing: item.timing,
        anchorAt: item.anchorAt?.toISOString() ?? null,
        capMs: item.capMs,
        origin: item.origin,
        relaxedRules: item.relaxedRules,
        ...(item.origin.type === 'show' ? { originShowSlotId: item.origin.showSlotId } : {}),
      });
      expect(parsed.error?.issues ?? []).toEqual([]);
    }
  });

  it('plans a soft slot soft, with its cap, and still ends the music on time', () => {
    const day = generateDay(snapshot, dates[0] as LocalDate, { extensions: backTiming(snapshot) });
    const noon = shows(day).find((s) => s.timing === 'soft') as GeneratedItem;
    expect(noon.capMs).toBe(30_000);
    expect(noon.conflict).toBeNull();
    const hard = shows(day).filter((s) => s.timing === 'hard');
    expect(hard).toHaveLength(HARD_START_SHOWS.length - 1);
  });

  it('back-times soft clock markers too, at their time', () => {
    const day = generateDay(snapshot, dates[0] as LocalDate, { extensions: backTiming(snapshot) });
    const plain = generateDay(snapshot, dates[0] as LocalDate);
    const markers = (d: GeneratedDay) => top(d).filter((i) => i.kind === 'marker');
    expect(markers(day).map((m) => m.anchorAt?.toISOString())).toEqual(
      markers(plain).map((m) => m.anchorAt?.toISOString()),
    );
    // Every hour's music lands on its marker, so no drift builds up toward the next show.
    expect(markers(day).every((m) => m.conflict === null)).toBe(true);
    // Without back-timing, the anchors get the generator's residual.
    expect(markers(plain).some((m) => m.conflict !== null)).toBe(true);
    expect(shows(plain).some((s) => s.conflict !== null)).toBe(true);
  });

  it('falls back to a whole jingle without beds, and never overruns', () => {
    // Without beds, a gap only closes when a song or a jingle of the right length exists:
    // these songs are 2.5 to 5.5 min, so a 1 min gap may stay (the feeder's to handle).
    const noBeds = hardStartSnapshot(dates, { beds: false });
    let close = 0;
    let total = 0;
    for (const day of generateDays(noBeds, dates, { extensions: backTiming(noBeds) })) {
      for (const show of shows(day)) {
        const last = tailBefore(day, show).at(-1) as GeneratedItem;
        expect(top(day).some((i) => i.kind === 'fill')).toBe(false);
        if (last.kind === 'jingle') {
          expect(last.plannedDurationMs).toBe(assetLength(noBeds, last.assetId));
        }
        expect(show.conflict?.kind ?? 'gap').toBe('gap');
        total++;
        if ((show.conflict?.ms ?? 0) <= DEFAULT_BACK_TIMING.minFillMs) close++;
      }
    }
    expect(close / total).toBeGreaterThan(0.7);
  });

  it('re-picks the last song through the rules', () => {
    // Every song is far too long for any re-pick: back-timing drops and cuts instead, and
    // never picks outside the slot's category.
    const day = generateDay(snapshot, dates[1] as LocalDate, { extensions: backTiming(snapshot) });
    for (const show of shows(day)) {
      for (const item of tailBefore(day, show)) {
        if (item.kind !== 'song' || item.origin.type !== 'clock') continue;
        const slot = snapshot.clocks.get(item.origin.clockId as string)?.slots[
          item.origin.slotIndex
        ];
        const categoryId = slot && 'categoryId' in slot ? slot.categoryId : null;
        const members = snapshot.categories.get(categoryId as string)?.members ?? [];
        expect(members.some((m) => m.id === item.assetId)).toBe(true);
      }
    }
  });

  it('plans nothing before a regeneration freeze point, not even in a gap it left', () => {
    // A regeneration (#101) keeps everything before its freeze point, anchors included. A gap
    // back-timing left before an anchor the first time (a dropped song) must stay a gap: the
    // generator plans nothing new before the freeze point.
    // Without beds, some gaps before an anchor stay open: those are what a new song could fill.
    const noBeds = hardStartSnapshot(dates, { beds: false });
    const date = dates[0] as LocalDate;
    const first = generateDay(noBeds, date, { extensions: backTiming(noBeds) });
    const freeze = new Date(`${date}T10:00:00Z`).getTime();
    const frozen = top(first).filter((i) => i.plannedStart.getTime() < freeze);
    expect(frozen.some((i) => i.timing !== 'flow')).toBe(true);
    // Leave out the last song of the run before an anchor: a gap a whole song fits in.
    const anchor = frozen.findIndex((i, n) => i.timing !== 'flow' && n > 2);
    const gapAt = frozen.findLastIndex((i, n) => n < anchor && i.kind === 'song');
    expect(gapAt).toBeGreaterThanOrEqual(0);
    const kept: KeptItem[] = frozen
      .filter((_, n) => n !== gapAt)
      .map((i, n) => ({
        id: `kept-${n}`,
        kind: i.kind,
        plannedStart: i.plannedStart,
        plannedDurationMs: i.plannedDurationMs,
        timing: i.timing,
        anchorAt: i.anchorAt,
        segmentId: null,
        crossOutMs: null,
        showSlotId: i.origin.type === 'show' ? i.origin.showSlotId : null,
        reasons: ['past'],
        played: null,
      }));
    const again = generateDay(
      { ...noBeds, kept: new Map([[date, kept]]), frozenUntil: new Date(freeze) },
      date,
      {
        extensions: backTiming(noBeds),
      },
    );
    const before = top(again).filter((i) => i.plannedStart.getTime() < freeze);
    expect(before.map((i) => i.keptId)).toEqual(kept.map((k) => k.id));
  });

  it('is deterministic', () => {
    const a = generateDay(snapshot, dates[2] as LocalDate, { extensions: backTiming(snapshot) });
    const b = generateDay(snapshot, dates[2] as LocalDate, { extensions: backTiming(snapshot) });
    expect(a.items).toEqual(b.items);
  });

  it('keeps every show on time across the DST weekends (Europe/Paris)', () => {
    for (const first of ['2026-03-28', '2026-10-24'] as const) {
      const days = datesFrom(first, 3);
      const dst = hardStartSnapshot(days);
      for (const day of generateDays(dst, days, { extensions: backTiming(dst) })) {
        expect(shows(day)).toHaveLength(HARD_START_SHOWS.length);
        for (const show of shows(day)) {
          expect(show.conflict).toBeNull();
          expect(show.plannedStart.getTime()).toBe(show.anchorAt?.getTime());
        }
      }
    }
  });

  it('uses the beds category for fills', () => {
    const day = generateDay(snapshot, dates[0] as LocalDate, { extensions: backTiming(snapshot) });
    const beds = snapshot.categories.get(BEDS_CATEGORY_ID)?.members ?? [];
    for (const fill of top(day).filter((i) => i.kind === 'fill')) {
      expect(beds.some((b) => b.id === fill.assetId)).toBe(true);
    }
  });
});
