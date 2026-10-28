import type { AsRunEntry, Asset, AssetDetail, LogItem } from '@ondes/shared';
import { orgs, stationId } from '../../app/testing/render.tsx';

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

/** `logItem` with an asset of its kind (one the feeder can push), titled `title`. */
export function playable(overrides: Partial<LogItem> & { title: string }): LogItem {
  const item = logItem(overrides);
  const type =
    item.kind === 'jingle' || item.kind === 'vt' || item.kind === 'bed' ? item.kind : 'song';
  const assetId = id();
  return {
    ...item,
    assetId,
    asset: {
      id: assetId,
      type,
      title: overrides.title,
      artists: [],
      durationMs: item.plannedDurationMs,
    },
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

const AT = '2026-10-21T10:00:00.000Z';

/** A library asset of the test station, id `…0003<suffix>` (two hex digits). */
export function libraryAsset(suffix: string, title: string, durationMs: number): Asset {
  return {
    id: `01a15ddf-0000-7000-8000-0000000003${suffix}`,
    orgId: orgs[0]?.id ?? '',
    stationId,
    type: 'song',
    title,
    artists: ['Bellecour Sound System'],
    album: null,
    year: null,
    isrc: null,
    version: null,
    durationMs,
    explicit: false,
    startAt: null,
    killAt: null,
    notes: null,
    metadata: {},
    sourceFilename: null,
    normalizeLoudness: true,
    gainOverrideDb: null,
    createdAt: new Date(AT),
    updatedAt: new Date(AT),
  };
}

/** Its detail; `playoutSha256` adds a playout copy. */
export function assetDetail(a: Asset, playoutSha256?: string): AssetDetail {
  return {
    ...a,
    files: playoutSha256
      ? [
          {
            id: id(),
            assetId: a.id,
            orgId: a.orgId,
            stationId: a.stationId,
            role: 'playout',
            storageKey: `org/${a.orgId}/sha256/${playoutSha256}.flac`,
            sha256: playoutSha256,
            sizeBytes: 1000,
            codec: 'flac',
            mimeType: 'audio/flac',
            sampleRate: 44_100,
            channels: 2,
            bitDepth: 16,
            durationSamples: 44_100 * 200,
            flacBlockSize: 4096,
            createdAt: new Date(AT),
          },
        ]
      : [],
    cues: null,
    loudness: null,
    playoutGain: { gainDb: 0, source: 'unmeasured', limitedByPeak: false },
    analysis: null,
    tags: [],
  };
}
