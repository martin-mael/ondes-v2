import {
  type AssetActivity,
  type AssetCues,
  type AssetDetail,
  encodePeaks,
  type LibraryFacets,
  type LibraryItem,
  type MyOrg,
} from '@ondes/shared';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ApiCall,
  type ApiRoute,
  orgs,
  renderApp,
  signedIn,
  stationId,
} from '../../app/testing/render.tsx';
import { assetDetail, libraryAsset } from '../log-timeline/testing.ts';

// The cue editor page on the whole app with a fake api, and the asset drawer's cue summary
// that links to it: the page's title and back link (with the library's filters), the tall
// waveform with its markers, a save, the unsaved-changes guard, the keyboard shortcuts, a
// missing track, and the summary's markers, times and link.

const SR = 44_100;
const LENGTH = SR * 200;
const peaksSha = 'b'.repeat(64);
const lib = `/stations/${stationId}/library`;

const auto = (samples: number | null) => ({ samples, source: 'auto' as const, locked: false });
const base = assetDetail(libraryAsset('01', 'Été indien', 200_000), 'a'.repeat(64));
const cues: AssetCues = {
  assetId: base.id,
  sampleRate: SR,
  analyzerVersion: 'autocue/1',
  cueIn: auto(SR),
  cueOut: { samples: SR * 195, source: 'manual', locked: true },
  introEnd: auto(SR * 15),
  outroStart: auto(null),
  fadeIn: auto(null),
  fadeOut: auto(null),
  crossStartNext: auto(SR * 190),
  updatedAt: new Date('2026-10-21T08:00:00.000Z'),
};
const playout = base.files[0];
const asset: AssetDetail = {
  ...base,
  album: 'Le Costume Blanc',
  files: playout
    ? [
        ...base.files,
        { ...playout, id: '01a15ddf-0000-7000-8000-0000000009f1', role: 'peaks', sha256: peaksSha },
      ]
    : base.files,
  cues,
};
const page = `${lib}/${asset.id}/cues`;

const peaksBytes = encodePeaks({
  sampleRate: SR,
  channels: 1,
  lengthSamples: LENGTH,
  levels: [
    {
      samplesPerPoint: 4096,
      points: Math.ceil(LENGTH / 4096),
      values: new Int8Array(Math.ceil(LENGTH / 4096) * 2),
    },
  ],
});

class FakeAudio {
  static all: FakeAudio[] = [];
  src = '';
  currentTime = 0;
  volume = 1;
  paused = true;
  onloadedmetadata: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onended: (() => void) | null = null;
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  load = vi.fn(() => queueMicrotask(() => this.onloadedmetadata?.()));
  constructor() {
    FakeAudio.all.push(this);
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
}

const asProgrammer: MyOrg[] = orgs.map((org) => ({
  ...org,
  stations: org.stations.map((s) => (s.id === stationId ? { ...s, role: 'programmer' } : s)),
}));

const item: LibraryItem = {
  ...asset,
  tags: [],
  analysis: { loudness: false, cues: true, peaks: true },
  integratedLufs: null,
  playoutGain: { gainDb: 0, source: 'unmeasured', limitedByPeak: false },
  bpm: null,
  musicalKey: null,
  lastPlayedAt: null,
};
const facets: LibraryFacets = { total: 1, types: [], tags: [], analysis: [], validity: [] };
const activity: AssetActivity = { lastPlayedAt: null, plays7d: 0, plays30d: 0, cache: null };

function routes(extra: Record<string, ApiRoute> = {}): Record<string, ApiRoute> {
  return {
    ...signedIn(),
    'GET /orgs': [200, { orgs: asProgrammer }],
    [`GET /stations/${stationId}/assets/${asset.id}`]: [200, asset],
    [`GET ${lib}/assets/${asset.id}/activity`]: [200, activity],
    [`POST ${lib}/search`]: [200, { items: [item], nextCursor: null }],
    [`POST ${lib}/facets`]: [200, facets],
    [`GET /stations/${stationId}/tags`]: [200, { tags: [] }],
    [`PUT /stations/${stationId}/assets/${asset.id}/cues`]: (body) => [
      200,
      {
        ...cues,
        cueIn: { samples: (body as AssetCues).cueIn.samples, source: 'manual', locked: true },
      },
    ],
    ...extra,
  };
}

/** The app at `url`, with the peaks route answering binary (the fake api answers JSON). */
function open(url: string, extra: Record<string, ApiRoute> = {}) {
  const app = renderApp(url, routes(extra));
  const json = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/peaks')) {
      return new Response(new Blob([peaksBytes.slice()]), { status: 200 });
    }
    return json(input, init);
  });
  return app;
}

const puts = (calls: ApiCall[]) => calls.filter((c) => c.method === 'PUT');

beforeEach(() => {
  FakeAudio.all = [];
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1200);
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('cue editor page', () => {
  it('shows the track, a tall waveform with its markers, and a back link keeping the filters', async () => {
    const { screen } = open(`${page}?q=dassin&sort=title`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Été indien' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Bellecour Sound System · Le Costume Blanc')).toBeInTheDocument();
    const cueIn = await screen.findByRole('slider', { name: 'Cue in' });
    expect(screen.getByRole('slider', { name: 'Next track starts' })).toBeInTheDocument();
    // Much taller than the drawer's 112 px strip.
    expect(cueIn.closest('[data-waveform]')).toHaveStyle({ height: '320px' });
    expect(screen.getByRole('heading', { level: 2, name: 'Cue points' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Transition preview' }),
    ).toBeInTheDocument();
    const back = screen.getByRole('button', { name: 'Back to the library' });
    expect(back.getAttribute('href')).toContain(`/stations/${stationId}/library?`);
    expect(back.getAttribute('href')).toContain('q=dassin');
    expect(back.getAttribute('href')).toContain('sort=title');
    expect(back.getAttribute('href')).toContain(`asset=${asset.id}`);
  });

  it('saves a moved marker', async () => {
    const { screen, calls } = open(page);
    const cueIn = await screen.findByRole('slider', { name: 'Cue in' });
    expect(screen.getByRole('button', { name: 'Save cue points' })).toBeDisabled();
    fireEvent.keyDown(cueIn, { key: 'ArrowRight', shiftKey: true });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save cue points' }));
    });
    await waitFor(() =>
      expect(puts(calls).map((c) => c.body)).toEqual([
        { sampleRate: SR, cueIn: { samples: SR + 4410, locked: true } },
      ]),
    );
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
  });

  it('asks before leaving with unsaved changes', async () => {
    const { screen, history } = open(page);
    fireEvent.keyDown(await screen.findByRole('slider', { name: 'Intro end' }), {
      key: 'ArrowLeft',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Back to the library' }));
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay' }));
    expect(history.location.pathname).toBe(page);
  });

  it('plays and stops with Space, and keeps arrows and Space from scrolling the page', async () => {
    const { screen } = open(page);
    await screen.findByRole('slider', { name: 'Cue in' });
    const waveform = screen.getByRole('region', { name: /^Waveform: Space/ });
    let played = false;
    await act(async () => {
      played = !fireEvent.keyDown(waveform, { key: ' ' });
    });
    expect(played).toBe(true);
    expect(FakeAudio.all[0]?.paused).toBe(false);
    expect(FakeAudio.all[0]?.currentTime).toBe(1);
    fireEvent.keyDown(waveform, { key: ' ' });
    expect(FakeAudio.all[0]?.paused).toBe(true);
    // Arrows scroll and zoom the view, never the page.
    expect(fireEvent.keyDown(waveform, { key: 'ArrowUp' })).toBe(false);
    expect(fireEvent.keyDown(waveform, { key: 'ArrowRight' })).toBe(false);
    expect(fireEvent.keyDown(waveform, { key: 'ArrowDown' })).toBe(false);
    // A focused marker moves, and Space doesn't scroll from it either.
    const cueIn = screen.getByRole('slider', { name: 'Cue in' });
    expect(fireEvent.keyDown(cueIn, { key: 'ArrowRight' })).toBe(false);
    expect(fireEvent.keyDown(cueIn, { key: ' ' })).toBe(false);
    // Typing in the next-track search is left alone.
    expect(
      fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search songs' }), { key: ' ' }),
    ).toBe(true);
  });

  it('says when the track is not in the library', async () => {
    const { screen } = open(page, {
      [`GET /stations/${stationId}/assets/${asset.id}`]: [
        404,
        { error: 'not_found', message: 'no such asset' },
      ],
    });
    expect(await screen.findByText('This track is not in the library.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to the library' })).toBeInTheDocument();
  });
});

describe('asset drawer cue summary', () => {
  it('shows the markers and cue times, and links to the editor page with the filters', async () => {
    const { screen, user, history } = open(`${lib}?asset=${asset.id}&q=dassin`);
    const summary = await screen.findByRole('img', {
      name: 'Waveform of Été indien with its cue points',
    });
    expect(summary.querySelector('[data-summary-marker="cueIn"]')).not.toBeNull();
    expect(summary.querySelector('[data-summary-marker="outroStart"]')).toBeNull();
    expect(document.querySelector('[data-summary-field="introEnd"]')).toHaveTextContent('0:15.000');
    expect(document.querySelector('[data-summary-field="cueOut"]')).toHaveTextContent('3:15.000');
    // Read-only in the drawer: no marker to drag, no save.
    expect(screen.queryByRole('slider', { name: 'Cue in' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save cue points' })).toBeNull();
    // A link styled as a button (Base UI gives it the button role).
    const edit = screen.getByRole('button', { name: 'Edit cues' });
    expect(edit.getAttribute('href')).toBe(`${page}?q=dassin`);
    await user.click(edit);
    await waitFor(() => expect(history.location.pathname).toBe(page));
    expect(await screen.findByRole('slider', { name: 'Cue in' })).toBeInTheDocument();
  });
});
