import { randomUUID } from 'node:crypto';
import {
  type AsRunEntry,
  type OnAir,
  publicHistoryItemSchema,
  publicNowPlayingSchema,
} from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { toPublicHistory, toPublicNowPlaying } from './service.ts';

// The public cut of the on-air snapshot and the as-run (#74): modes, what an interlude hides,
// live, the next tracks, and that no internal id ever makes it out.

const station = { slug: 'vandale', name: 'Vandale', timezone: 'Europe/Paris' };
const at = '2026-10-27T18:00:00.000Z';
const ids = { asRun: randomUUID(), logItem: randomUUID(), show: randomUUID(), ep: randomUUID() };

const onAir = (over: Partial<OnAir> = {}): OnAir => ({
  at,
  mode: { kind: 'automation', djName: null },
  current: {
    asRunId: ids.asRun,
    source: 'log',
    kind: 'song',
    logItemId: ids.logItem,
    title: 'Song',
    artist: 'Artist',
    startedAt: '2026-10-27T17:59:00.000Z',
    durationMs: 180_000,
    introMs: 5_000,
    outroMs: 170_000,
  },
  next: [
    {
      logItemId: randomUUID(),
      kind: 'jingle',
      timing: 'flow',
      title: 'ID jingle 3',
      artists: [],
      plannedStart: '2026-10-27T18:02:00.000Z',
      estimatedStart: '2026-10-27T18:02:00.000Z',
      durationMs: 5_000,
    },
    ...['B', 'C', 'D', 'E'].map((title, i) => ({
      logItemId: randomUUID(),
      kind: 'song' as const,
      timing: 'flow' as const,
      title,
      artists: ['X', 'Y'],
      plannedStart: `2026-10-27T18:0${3 + i}:00.000Z`,
      estimatedStart: `2026-10-27T18:0${3 + i}:00.000Z`,
      durationMs: 60_000,
    })),
  ],
  nextHardEvent: null,
  show: {
    showId: ids.show,
    name: 'Matinale',
    colour: '#ff8800',
    artworkUrl: null,
    type: 'live',
    startsAt: '2026-10-27T17:00:00.000Z',
    endsAt: '2026-10-27T19:00:00.000Z',
    episode: { id: ids.ep, number: 42, title: 'Ep' },
    rerun: false,
  },
  ...over,
});

const leaks = (value: unknown) => {
  const json = JSON.stringify(value);
  return Object.values(ids).filter((id) => json.includes(id));
};

describe('toPublicNowPlaying', () => {
  it('gives the track on air, the show and the next tracks only, with no internal id', () => {
    const body = publicNowPlayingSchema.parse(toPublicNowPlaying(station, onAir(), null, null));
    expect(body).toMatchObject({
      mode: 'automation',
      live: false,
      current: { kind: 'track', title: 'Song', artist: 'Artist', durationMs: 180_000 },
      show: { name: 'Matinale', episode: { number: 42, title: 'Ep' }, rerun: false },
      liveInfo: null,
    });
    expect(body.next.map((n) => n.title)).toEqual(['B', 'C', 'D']);
    expect(body.next[0]?.artist).toBe('X, Y');
    expect(leaks(body)).toEqual([]);
  });

  it('hides the internal titles of jingles and voice tracks', () => {
    const base = onAir();
    const current = base.current && { ...base.current, kind: 'vt' as const, title: 'VT Marie 14h' };
    const body = toPublicNowPlaying(station, { ...base, current }, null, null);
    expect(body.current).toMatchObject({ kind: 'interlude', title: null, artist: null });
  });

  it('maps safety to automation and the emergency loop to off air', () => {
    const safety = onAir({ mode: { kind: 'safety', djName: null } });
    expect(toPublicNowPlaying(station, safety, null, null).mode).toBe('automation');
    const emergency = toPublicNowPlaying(
      station,
      onAir({ mode: { kind: 'emergency', djName: null } }),
      null,
      null,
    );
    // Off air, the schedule isn't what listeners hear: no show, no next.
    expect(emergency).toMatchObject({ mode: 'off_air', current: null, show: null, next: [] });
    const off = toPublicNowPlaying(
      station,
      onAir({ mode: { kind: 'off_air', djName: null }, current: null }),
      null,
      null,
    );
    expect(off).toMatchObject({ mode: 'off_air', current: null, show: null, next: [] });
  });

  it('shows the DJ and their metadata while live', () => {
    const base = onAir({ mode: { kind: 'live', djName: 'Nova' } });
    const current = base.current && {
      ...base.current,
      source: 'live' as const,
      kind: null,
      title: 'Live',
      durationMs: null,
    };
    const entry = {
      live: { sessionId: randomUUID(), djName: 'Nova', title: 'Fête de la musique' },
    };
    const plain = toPublicNowPlaying(station, { ...base, current }, entry as AsRunEntry, null);
    expect(plain).toMatchObject({
      mode: 'live',
      live: true,
      current: { kind: 'live', title: null, artist: null, durationMs: null },
      liveInfo: { djName: 'Nova', title: 'Fête de la musique' },
    });
    const withMetadata = toPublicNowPlaying(station, { ...base, current }, null, {
      title: 'On stage',
      artist: 'Band',
      source: 'manual',
      updatedAt: at,
    });
    expect(withMetadata.current).toMatchObject({ title: 'On stage', artist: 'Band' });
    // Without the entry's snapshot: the open session's DJ, the show's name.
    expect(withMetadata.liveInfo).toEqual({ djName: 'Nova', title: 'Matinale' });
  });
});

describe('toPublicHistory', () => {
  const entry = (over: Partial<AsRunEntry>): AsRunEntry => ({
    id: randomUUID(),
    stationId: randomUUID(),
    source: 'log',
    logItemId: randomUUID(),
    segmentId: null,
    kind: 'song',
    assetId: randomUUID(),
    fileSha256: null,
    title: 'T',
    artist: 'A',
    artists: ['A'],
    liveSessionId: null,
    startedAt: '2026-10-27T17:00:00.000Z',
    endedAt: '2026-10-27T17:03:00.000Z',
    durationMs: 180_000,
    outcome: 'complete',
    plannedStart: null,
    plannedDurationMs: null,
    driftMs: null,
    bootId: 'b',
    seq: 1,
    recordedAt: '2026-10-27T17:00:00.000Z',
    ...over,
  });

  it('keeps tracks, episodes and live blocks that ended, and nothing internal', () => {
    const entries = [
      entry({ title: 'Song' }),
      entry({ kind: 'jingle', title: 'ID' }),
      entry({ outcome: 'skipped', title: 'Skipped' }),
      entry({ endedAt: null, outcome: null, title: 'On air' }),
      entry({ kind: 'episode', title: 'Episode 42' }),
      entry({ source: 'safety', kind: null, title: 'Safe' }),
      entry({
        source: 'live',
        kind: null,
        title: 'harbor',
        live: { sessionId: randomUUID(), djName: 'Nova', title: 'Concert' },
      }),
    ];
    const items = toPublicHistory(entries).map((i) => publicHistoryItemSchema.parse(i));
    expect(items.map((i) => [i.kind, i.title, i.artist])).toEqual([
      ['track', 'Song', 'A'],
      ['episode', 'Episode 42', 'A'],
      ['track', 'Safe', 'A'],
      ['live', 'Concert', 'Nova'],
    ]);
    const json = JSON.stringify(items);
    for (const e of entries) {
      expect(json).not.toContain(e.id);
      if (e.logItemId) expect(json).not.toContain(e.logItemId);
    }
  });
});
