import type { AsRunEntry, LogItem } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { buildOverlay } from './overlay.ts';

let n = 0;
const id = () => `01a15ddf-0000-7000-8000-${String(++n).padStart(12, '0')}`;
const A1 = '01a15ddf-0000-7000-8000-0000000000a1';
const A2 = '01a15ddf-0000-7000-8000-0000000000a2';

const FROM = Date.parse('2026-10-20T22:00:00Z'); // 2026-10-21 00:00 Europe/Paris
const TO = Date.parse('2026-10-21T22:00:00Z');
const at = (hhmmss: string) => `2026-10-21T${hhmmss}.000Z`;

function item(start: string, overrides: Partial<LogItem> = {}): LogItem {
  return {
    id: id(),
    logDayId: '01a15ddf-0000-7000-8000-0000000000d0',
    position: 0,
    kind: 'song',
    plannedStart: at(start),
    plannedDurationMs: 180_000,
    assetId: A1,
    asset: { id: A1, type: 'song', title: 'Planned', artists: ['Band'], durationMs: 180_000 },
    episodeId: null,
    liveSlotId: null,
    title: null,
    cueOverrides: null,
    timing: 'flow',
    anchorAt: null,
    capMs: null,
    origin: { type: 'manual' },
    locked: false,
    relaxedRules: [],
    segmentId: null,
    conflict: null,
    parts: [],
    ...overrides,
  };
}

function entry(start: string, overrides: Partial<AsRunEntry> = {}): AsRunEntry {
  return {
    id: id(),
    stationId: '01a15ddf-0000-7000-8000-0000000000b1',
    source: 'log',
    logItemId: null,
    segmentId: null,
    kind: 'song',
    assetId: A1,
    fileSha256: null,
    title: 'Aired',
    artist: null,
    artists: [],
    liveSessionId: null,
    startedAt: at(start),
    endedAt: null,
    durationMs: null,
    outcome: null,
    plannedStart: null,
    plannedDurationMs: null,
    driftMs: null,
    bootId: 'boot',
    seq: ++n,
    recordedAt: at(start),
    ...overrides,
  };
}

const ended = (start: string, end: string, more: Partial<AsRunEntry> = {}) =>
  entry(start, { endedAt: at(end), outcome: 'complete', ...more });

const NOW = Date.parse(at('20:00:00'));
const overlay = (items: LogItem[], entries: AsRunEntry[], now = NOW) =>
  buildOverlay({ items, entries, from: FROM, to: TO, now });

describe('buildOverlay', () => {
  it('matches entries to plan items by log item id, with the plan and the entry', () => {
    const a = item('10:00:00');
    const e = ended('10:00:04', '10:03:00', { logItemId: a.id, driftMs: 4000 });
    const [row] = overlay([a], [e]);
    expect(row).toMatchObject({ status: 'aired', at: e.startedAt, repeat: false });
    expect(row?.plan).toMatchObject({ logItemId: a.id, title: 'Planned', artists: ['Band'] });
    expect(row?.entry?.id).toBe(e.id);
  });

  it('marks planned items nothing aired for: missed when over, pending when not', () => {
    const past = item('10:00:00');
    const future = item('19:59:00');
    const rows = overlay([past, future], []);
    expect(rows.map((r) => r.status)).toEqual(['missed', 'pending']);
    expect(rows[0]?.entry).toBeNull();
  });

  it('a missed item whose slot off-plan audio held is replaced, by those entries', () => {
    const a = item('10:00:00');
    const safety = ended('09:59:30', '10:04:00', { source: 'safety', assetId: A2 });
    const rows = overlay([a], [safety]);
    expect(rows.map((r) => r.status)).toEqual(['safety', 'replaced']);
    expect(rows[1]?.replacedBy).toEqual([safety.id]);
  });

  it('a brief overlap (a crossfade tail) does not replace an item', () => {
    const a = item('10:00:00');
    const tail = ended('09:57:00', '10:00:01', { source: 'safety' });
    expect(overlay([a], [tail]).map((r) => r.status)).toEqual(['safety', 'missed']);
  });

  it('an item that aired another asset than planned is replaced', () => {
    const a = item('10:00:00');
    const e = ended('10:00:00', '10:03:00', { logItemId: a.id, assetId: A2 });
    expect(overlay([a], [e])[0]?.status).toBe('replaced');
  });

  it('an episode fallback is a fallback', () => {
    const a = item('10:00:00', { kind: 'episode' });
    const e = ended('10:00:00', '11:00:00', { logItemId: a.id, fallback: 'latest_episode' });
    expect(overlay([a], [e])[0]?.status).toBe('fallback');
  });

  it('a live entry fills the live slot it overlaps; outside a slot it is off-plan live', () => {
    const slot = item('12:00:00', {
      kind: 'live_slot',
      assetId: null,
      asset: null,
      plannedDurationMs: 3_600_000,
    });
    const inSlot = ended('12:01:00', '12:58:00', { source: 'live', kind: null, assetId: null });
    const outside = ended('15:00:00', '15:10:00', { source: 'live', kind: null, assetId: null });
    const rows = overlay([slot], [inSlot, outside]);
    expect(rows.map((r) => [r.status, r.plan?.logItemId ?? null])).toEqual([
      ['live', slot.id],
      ['live', null],
    ]);
  });

  it('a live slot nobody went live in is missed, and an unplanned entry is off-plan', () => {
    const slot = item('12:00:00', { kind: 'live_slot', assetId: null, asset: null });
    const stray = ended('13:00:00', '13:03:00', { logItemId: null });
    expect(overlay([slot], [stray]).map((r) => r.status)).toEqual(['missed', 'unplanned']);
  });

  it('island parts match their part; the segment is aired once any part aired', () => {
    const seg = item('10:00:00', { kind: 'segment', assetId: null, asset: null });
    const p1 = { ...item('10:00:00'), segmentId: seg.id };
    const p2 = { ...item('10:03:00'), segmentId: seg.id };
    const { parts: _1, ...part1 } = p1;
    const { parts: _2, ...part2 } = p2;
    seg.parts = [part1, part2];
    const e1 = ended('10:00:00', '10:03:00', { logItemId: p1.id, segmentId: seg.id });
    const rows = overlay([seg], [e1]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.plan).toMatchObject({ logItemId: p1.id, segmentId: seg.id });
  });

  it('an island reported as one item matches its segment', () => {
    const seg = item('10:00:00', { kind: 'segment', assetId: null, asset: null });
    const e = ended('10:00:00', '10:06:00', { logItemId: seg.id, kind: 'segment' });
    expect(overlay([seg], [e])[0]).toMatchObject({ status: 'aired' });
  });

  it('a rendered island (#57) is the transition between its items, never off-plan', () => {
    const a = item('10:00:00');
    const b = item('10:03:00');
    const ea = ended('10:00:00', '10:02:50', { logItemId: a.id });
    // #57's `transition` isn't in the contract yet: set it as the recorder will.
    const island = {
      ...ended('10:02:50', '10:03:10', { title: 'B' }),
      transition: { rendered: true, voices: [{ title: 'VT' }] },
    } as AsRunEntry;
    const eb = ended('10:03:10', '10:06:00', { logItemId: b.id });
    const rows = overlay([a, b], [ea, island, eb]);
    expect(rows.map((r) => r.status)).toEqual(['aired', 'transition', 'aired']);
    // A missed item next to it isn't "replaced" by the transition.
    expect(overlay([a, b], [ea, island]).map((r) => r.status)).toEqual([
      'aired',
      'transition',
      'missed',
    ]);
  });

  it('an item aired twice (again after a restart) has a repeat row', () => {
    const a = item('10:00:00');
    const first = ended('10:00:00', '10:01:00', { logItemId: a.id, outcome: 'interrupted' });
    const again = ended('10:01:30', '10:04:30', { logItemId: a.id });
    expect(overlay([a], [first, again]).map((r) => r.repeat)).toEqual([false, true]);
  });

  it('keeps an item planned late in the day whose entry started after midnight', () => {
    const late = item('21:59:00');
    const e = ended('22:01:00', '22:04:00', { logItemId: late.id });
    const nextDayStray = ended('22:10:00', '22:12:00', { source: 'safety' });
    const rows = overlay([late], [e, nextDayStray], Date.parse(at('23:00:00')));
    expect(rows.map((r) => r.status)).toEqual(['aired']);
  });

  it('ignores markers and items of other days, and sorts by air time', () => {
    const marker = item('09:00:00', { kind: 'marker', plannedDurationMs: 0 });
    const yesterday = { ...item('10:00:00'), plannedStart: '2026-10-20T10:00:00.000Z' };
    const b = item('11:00:00');
    const a = item('10:00:00');
    const eb = ended('11:00:02', '11:03:00', { logItemId: b.id });
    const rows = overlay([marker, yesterday, a, b], [eb]);
    expect(rows.map((r) => r.plan?.logItemId)).toEqual([a.id, b.id]);
    expect(rows.map((r) => r.status)).toEqual(['missed', 'aired']);
  });
});
