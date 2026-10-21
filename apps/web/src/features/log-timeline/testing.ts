import type { AsRunEntry, LogItem } from '@ondes/shared';

// Fixtures for the timeline's tests.

let n = 0;
/** A fresh uuid. */
export const id = () => `01a15ddf-0000-7000-8000-${String(++n).padStart(12, '0')}`;

export function logItem(overrides: Partial<LogItem> = {}): LogItem {
  return {
    id: id(),
    logDayId: '01a15ddf-0000-7000-8000-0000000000d0',
    position: 0,
    kind: 'song',
    plannedStart: '2026-10-21T10:00:00.000Z',
    plannedDurationMs: 200_000,
    assetId: null,
    asset: null,
    episodeId: null,
    liveSlotId: null,
    title: 'Song',
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

export function asRunEntry(overrides: Partial<AsRunEntry> = {}): AsRunEntry {
  return {
    id: id(),
    stationId: '01a15ddf-0000-7000-8000-0000000000b1',
    source: 'log',
    logItemId: null,
    segmentId: null,
    kind: 'song',
    assetId: null,
    fileSha256: null,
    title: null,
    artist: null,
    artists: [],
    liveSessionId: null,
    startedAt: '2026-10-21T10:00:01.000Z',
    endedAt: null,
    durationMs: null,
    outcome: null,
    plannedStart: null,
    plannedDurationMs: null,
    driftMs: null,
    bootId: 'boot-1',
    seq: 1,
    recordedAt: '2026-10-21T10:00:01.000Z',
    ...overrides,
  };
}
