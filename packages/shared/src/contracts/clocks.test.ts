import { describe, expect, it } from 'vitest';
import {
  type ClockSlot,
  type ClockSlotInput,
  clockSlotSchema,
  createClockSchema,
  estimateClock,
  logKindForSlot,
  type SlotReference,
  slotCategoryId,
  updateClockSchema,
} from './clocks.ts';

const cat = '0199f6a0-0000-7000-8000-000000000001';
const jingles = '0199f6a0-0000-7000-8000-000000000002';
const asset = '0199f6a0-0000-7000-8000-000000000003';
const MIN = 60_000;

const other = '0199f6a0-0000-7000-8000-000000000004';
const refs: Record<string, SlotReference> = {
  [other]: { exists: true, durationMs: MIN, assetType: 'other' },
  [cat]: { exists: true, durationMs: 4 * MIN, assetType: 'song' },
  [jingles]: { exists: true, durationMs: 10_000, assetType: 'jingle' },
  [asset]: { exists: true, durationMs: 2 * MIN, assetType: 'song' },
};
const lookup = (slot: ClockSlot) => {
  const id = slot.kind === 'asset' ? slot.assetId : slotCategoryId(slot);
  return id ? (refs[id] ?? { exists: false, durationMs: null, assetType: null }) : undefined;
};

const slots = (input: ClockSlotInput[]) => input.map((s) => clockSlotSchema.parse(s));
const estimate = (input: ClockSlotInput[], targetDurationMs = 60 * MIN) =>
  estimateClock({ targetDurationMs, slots: slots(input) }, lookup);
const song = { kind: 'category', categoryId: cat } as const;

describe('clock slots', () => {
  it('fills defaults', () => {
    expect(clockSlotSchema.parse({ kind: 'vt' })).toEqual({
      kind: 'vt',
      label: null,
      durationMs: null,
      mode: 'placeholder',
      categoryId: null,
    });
    expect(clockSlotSchema.parse({ kind: 'marker', offsetMs: 0 })).toMatchObject({
      timing: 'hard',
      capMs: null,
    });
    expect(createClockSchema.parse({ name: ' Day ' })).toEqual({
      name: 'Day',
      targetDurationMs: 3_600_000,
      slots: [],
    });
  });

  it('needs the edited version on update', () => {
    expect(updateClockSchema.safeParse({ name: 'X' }).success).toBe(false);
    expect(updateClockSchema.safeParse({ version: 2 }).success).toBe(false);
    expect(updateClockSchema.parse({ version: 2, name: 'X' })).toEqual({ version: 2, name: 'X' });
  });

  it('rejects unknown kinds and out-of-range offsets', () => {
    expect(clockSlotSchema.safeParse({ kind: 'nope' }).success).toBe(false);
    expect(clockSlotSchema.safeParse({ kind: 'marker', offsetMs: -1 }).success).toBe(false);
  });

  it('maps slots onto log item kinds', () => {
    expect(logKindForSlot('category', 'song')).toBe('song');
    expect(logKindForSlot('asset', 'bed')).toBe('bed');
    expect(logKindForSlot('asset', 'other')).toBeNull();
    expect(logKindForSlot('live')).toBe('live_slot');
    expect(logKindForSlot('marker')).toBe('marker');
    expect(logKindForSlot('vt')).toBe('vt');
  });
});

describe('estimateClock', () => {
  it('lays slots end to end from their averages and nominal durations', () => {
    const e = estimate(
      [
        { kind: 'marker', offsetMs: 0 },
        { kind: 'jingle', categoryId: jingles },
        song,
        { ...song, durationMs: 3 * MIN },
        { kind: 'asset', assetId: asset },
        { kind: 'vt' },
      ],
      10 * MIN,
    );
    expect(e.slots.map((s) => [s.startMs, s.durationMs, s.source])).toEqual([
      [0, 0, 'marker'],
      [0, 10_000, 'average'],
      [10_000, 4 * MIN, 'average'],
      [250_000, 3 * MIN, 'nominal'],
      [430_000, 2 * MIN, 'asset'],
      [550_000, 30_000, 'default'],
    ]);
    expect(e.totalMs).toBe(580_000);
    expect(e.warnings).toEqual([]);
  });

  it('warns about an over- or under-filled hour beyond the tolerance', () => {
    const fifteen = Array.from({ length: 15 }, () => song);
    expect(estimate(fifteen).warnings).toEqual([]);
    expect(estimate([...fifteen, song]).warnings).toEqual([{ code: 'over_target', ms: 4 * MIN }]);
    expect(estimate(fifteen.slice(1)).warnings).toEqual([{ code: 'under_target', ms: 4 * MIN }]);
    expect(
      estimate([...fifteen.slice(1), { kind: 'live', durationMs: 3.5 * MIN }]).warnings,
    ).toEqual([]);
  });

  it('stretches fills to the next marker, sharing the slack', () => {
    const e = estimate([
      song,
      { kind: 'fill' },
      { kind: 'fill' },
      { kind: 'marker', offsetMs: 30 * MIN, timing: 'hard' },
      { kind: 'fill' },
    ]);
    expect(e.slots.map((s) => s.durationMs)).toEqual([4 * MIN, 13 * MIN, 13 * MIN, 0, 30 * MIN]);
    expect(e.slots[3]?.startMs).toBe(30 * MIN);
    expect(e.totalMs).toBe(60 * MIN);
    expect(e.warnings).toEqual([]);
  });

  it('reports overruns and gaps at markers', () => {
    const e = estimate([
      ...Array.from({ length: 8 }, () => song),
      { kind: 'marker', offsetMs: 30 * MIN, timing: 'hard' },
      song,
      { kind: 'marker', offsetMs: 45 * MIN, timing: 'not_before' },
      { kind: 'marker', offsetMs: 50 * MIN, timing: 'soft', capMs: MIN },
    ]);
    // Whole-clock warnings first, then by slot.
    expect(e.warnings).toEqual([
      { code: 'under_target', ms: 10 * MIN },
      { code: 'overrun', slotIndex: 8, ms: 2 * MIN },
      { code: 'gap', slotIndex: 10, ms: 11 * MIN },
      { code: 'gap', slotIndex: 11, ms: 5 * MIN },
    ]);
    // A hard marker cuts back to its offset.
    expect(e.slots[8]?.startMs).toBe(30 * MIN);
  });

  it('lets a soft marker run late up to its cap', () => {
    const late = (capMs: number) =>
      estimate(
        [
          { ...song, durationMs: 11 * MIN },
          { kind: 'marker', offsetMs: 10 * MIN, timing: 'soft', capMs },
        ],
        11 * MIN,
      ).warnings;
    expect(late(2 * MIN)).toEqual([]);
    expect(late(30_000)).toEqual([{ code: 'overrun', slotIndex: 1, ms: 30_000 }]);
  });

  it('flags markers out of order or past the end', () => {
    const e = estimate(
      [
        { kind: 'marker', offsetMs: 5 * MIN, timing: 'not_before' },
        { kind: 'marker', offsetMs: 2 * MIN, timing: 'not_before' },
        { kind: 'marker', offsetMs: 20 * MIN, timing: 'not_before' },
      ],
      10 * MIN,
    );
    expect(e.warnings.map((w) => [w.code, w.slotIndex])).toEqual([
      ['over_target', undefined],
      ['gap', 0],
      ['marker_order', 1],
      ['marker_beyond_target', 2],
      ['gap', 2],
    ]);
  });

  it('flags missing references, wrong types and unknown lengths', () => {
    const missing = '0199f6a0-0000-7000-8000-0000000000ff';
    const e = estimate(
      [
        { kind: 'category' },
        { kind: 'category', categoryId: missing },
        { kind: 'jingle', categoryId: cat },
        { kind: 'live' },
        { kind: 'vt', mode: 'promo' },
      ],
      MIN,
    );
    expect(e.warnings.map((w) => [w.code, w.slotIndex])).toEqual([
      // The jingle slot borrows the song category's 4 minutes.
      ['over_target', undefined],
      ['missing_reference', 0],
      ['missing_reference', 1],
      ['wrong_asset_type', 2],
      ['unknown_duration', 3],
      ['missing_reference', 4],
    ]);
  });

  it('flags assets of a type the log cannot place, and deleted fill categories', () => {
    const missing = '0199f6a0-0000-7000-8000-0000000000ff';
    const e = estimate(
      [
        { kind: 'category', categoryId: other },
        { kind: 'asset', assetId: other },
        { kind: 'fill', categoryId: missing },
        { kind: 'fill' },
      ],
      2 * MIN,
    );
    expect(e.warnings.map((w) => [w.code, w.slotIndex])).toEqual([
      ['unsupported_asset_type', 0],
      ['unsupported_asset_type', 1],
      ['missing_reference', 2],
    ]);
  });

  it('times a partial clock with markers', () => {
    // 40 minutes before a show: a song, the news at :20 (hard), songs, a fill to the end.
    const e = estimate(
      [
        song,
        { kind: 'fill' },
        { kind: 'marker', offsetMs: 20 * MIN, timing: 'hard' },
        { kind: 'asset', assetId: asset },
        song,
        song,
        { kind: 'fill' },
      ],
      40 * MIN,
    );
    expect(e.slots.map((s) => [s.startMs / MIN, s.durationMs / MIN])).toEqual([
      [0, 4],
      [4, 16],
      [20, 0],
      [20, 2],
      [22, 4],
      [26, 4],
      [30, 10],
    ]);
    expect(e.totalMs).toBe(40 * MIN);
    expect(e.warnings).toEqual([]);
  });
});
