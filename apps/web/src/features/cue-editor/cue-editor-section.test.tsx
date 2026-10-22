import { type AssetCues, type AssetDetail, encodePeaks, type LibraryItem } from '@ondes/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../app/i18n/i18n.tsx';
import { stationId } from '../../app/testing/render.tsx';
import { assetDetail, libraryAsset } from '../log-timeline/testing.ts';
import { CueEditorSection } from './cue-editor-section.tsx';

// The cue editor in the drawer slot, with a fake api and a fake <audio>: the waveform from the
// peaks route, a marker moved with the keyboard and saved locked, drafts kept across refetches
// and in-flight saves, a failed save, the read-only view, a track without peaks yet, playback
// from a marker, and the transition preview into a searched, a random and a silent next track.

const SR = 44_100;
const LENGTH = SR * 200;
const peaksSha = 'b'.repeat(64);

const auto = (samples: number | null) => ({ samples, source: 'auto' as const, locked: false });

function cuesOf(id: string, overrides: Partial<AssetCues> = {}): AssetCues {
  return {
    assetId: id,
    sampleRate: SR,
    analyzerVersion: 'autocue/1',
    cueIn: auto(SR),
    cueOut: auto(SR * 195),
    introEnd: auto(SR * 15),
    outroStart: auto(null),
    fadeIn: auto(null),
    fadeOut: auto(null),
    crossStartNext: auto(SR * 190),
    updatedAt: new Date('2026-10-21T08:00:00.000Z'),
    ...overrides,
  };
}

function withCues(detail: AssetDetail, withPeaks = true, cues = cuesOf(detail.id)): AssetDetail {
  const playout = detail.files[0];
  return {
    ...detail,
    files:
      withPeaks && playout
        ? [...detail.files, { ...playout, id: `${playout.id}p`, role: 'peaks', sha256: peaksSha }]
        : detail.files,
    cues,
  };
}

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

const asset = assetDetail(libraryAsset('01', 'Été indien', 200_000), 'a'.repeat(64));
const nextA = assetDetail(libraryAsset('02', 'Lumière', 180_000), 'c'.repeat(64));
const nextB = assetDetail(libraryAsset('03', 'Silence', 180_000));
const item = (detail: AssetDetail): LibraryItem => ({
  ...detail,
  tags: [],
  analysis: { loudness: false, cues: false, peaks: false },
  integratedLufs: null,
  playoutGain: { gainDb: 0, source: 'unmeasured', limitedByPeak: false },
  bpm: null,
  musicalKey: null,
  lastPlayedAt: null,
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

interface Call {
  method: string;
  path: string;
  body: unknown;
}
let calls: Call[];
/** Answers `PUT …/cues`; a test may replace it. */
let putCues: (body: { cueIn?: { samples: number } }) => Response | Promise<Response>;

beforeEach(() => {
  calls = [];
  FakeAudio.all = [];
  putCues = (body) =>
    Response.json(
      cuesOf(asset.id, {
        cueIn: { samples: body.cueIn?.samples ?? SR, source: 'manual', locked: true },
      }),
    );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://app.test');
      const path = url.pathname.replace(/^\/api\/v1/, '');
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      if (path.endsWith('/peaks')) {
        expect(url.searchParams.get('v')).toBe(peaksSha);
        return new Response(new Blob([peaksBytes.slice()]), { status: 200 });
      }
      if (path.endsWith('/cues') && method === 'PUT') return putCues(body);
      if (path.endsWith('/library/search')) {
        const items = [asset, nextA, nextB]
          .filter((d) => !body.filter.q || d.title.toLowerCase().includes(body.filter.q))
          .map(item);
        return Response.json({ items, nextCursor: null });
      }
      if (path.endsWith('/library/random')) return Response.json({ item: item(nextA) });
      for (const d of [nextA, nextB]) {
        if (path === `/stations/${stationId}/assets/${d.id}`) return Response.json(d);
      }
      return new Response(null, { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderEditor(detail: AssetDetail, canWrite = true) {
  const refresh = vi.fn(async () => {});
  const onDirtyChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (d: AssetDetail) => (
    <QueryClientProvider client={queryClient}>
      <I18nProvider locale="en">
        <CueEditorSection
          stationId={stationId}
          asset={d}
          canWrite={canWrite}
          refresh={refresh}
          onDirtyChange={onDirtyChange}
        />
      </I18nProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(ui(detail));
  return { refresh, onDirtyChange, rerender: (d: AssetDetail) => rerender(ui(d)) };
}

const row = (field: string) => document.querySelector(`[data-field="${field}"]`) as HTMLElement;

describe('cue editor', () => {
  it('moves a marker and saves it locked', async () => {
    const { refresh, onDirtyChange } = renderEditor(withCues(asset));
    const cueIn = await screen.findByRole('slider', { name: 'Cue in' });
    expect(screen.getByRole('slider', { name: 'Next track starts' })).toBeInTheDocument();
    // Not set: no marker.
    expect(screen.queryByRole('slider', { name: 'Outro start' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save cue points' })).toBeDisabled();

    fireEvent.keyDown(cueIn, { key: 'ArrowRight', shiftKey: true });
    expect(row('cueIn')).toHaveTextContent('0:01.100');
    expect(within(row('cueIn')).getByText('edited')).toBeInTheDocument();
    // A move locks the point, and the button says so.
    expect(screen.getByRole('button', { name: 'Unlock Cue in' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save cue points' }));
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
      { sampleRate: SR, cueIn: { samples: SR + 4410, locked: true } },
    ]);
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it('saves a moved point unlocked when it was unlocked again', async () => {
    renderEditor(withCues(asset));
    fireEvent.keyDown(await screen.findByRole('slider', { name: 'Intro end' }), {
      key: 'ArrowLeft',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock Intro end' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save cue points' }));
    });
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      sampleRate: SR,
      introEnd: { samples: SR * 15 - 441, locked: false },
    });
  });

  it('keeps unsaved edits when the asset is reloaded, and adopts a reload otherwise', async () => {
    const { rerender } = renderEditor(withCues(asset));
    const cueIn = await screen.findByRole('slider', { name: 'Cue in' });
    // A reload with nothing edited: the new copy shows.
    rerender(withCues(asset, true, cuesOf(asset.id, { introEnd: auto(SR * 20) })));
    expect(row('introEnd')).toHaveTextContent('0:20.000');
    // A reload while edited (someone else moved cue-out): the edit stays, still unsaved.
    fireEvent.keyDown(cueIn, { key: 'ArrowRight' });
    rerender(withCues(asset, true, cuesOf(asset.id, { cueOut: auto(SR * 194) })));
    expect(row('cueIn')).toHaveTextContent('0:01.010');
    expect(within(row('cueIn')).getByText('edited')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save cue points' })).toBeEnabled();
  });

  it('locks the markers while a save is in flight, then shows the stored copy', async () => {
    let answer: (response: Response) => void = () => {};
    putCues = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    renderEditor(withCues(asset));
    const cueIn = await screen.findByRole('slider', { name: 'Cue in' });
    fireEvent.keyDown(cueIn, { key: 'ArrowRight' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save cue points' }));
    });
    await waitFor(() =>
      expect(screen.getByRole('slider', { name: 'Cue in' })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    // The list's buttons are gone too while saving.
    expect(screen.queryByRole('button', { name: 'Clear Cue in' })).toBeNull();
    await act(async () => {
      answer(
        Response.json(
          cuesOf(asset.id, { cueIn: { samples: SR + 441, source: 'manual', locked: true } }),
        ),
      );
    });
    await waitFor(() =>
      expect(screen.getByRole('slider', { name: 'Cue in' })).toHaveAttribute(
        'aria-disabled',
        'false',
      ),
    );
    expect(within(row('cueIn')).queryByText('edited')).toBeNull();
    expect(row('cueIn')).toHaveTextContent('manual');
  });

  it('says when a save fails, and keeps the draft', async () => {
    putCues = () =>
      Response.json(
        { error: 'library_conflict', message: 'cueOut must be after cueIn' },
        { status: 409 },
      );
    renderEditor(withCues(asset));
    fireEvent.keyDown(await screen.findByRole('slider', { name: 'Cue in' }), { key: 'ArrowRight' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save cue points' }));
    });
    expect(await screen.findByText("The cue points couldn't be saved.")).toBeInTheDocument();
    expect(within(row('cueIn')).getByText('edited')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save cue points' })).toBeEnabled();
  });

  it('locks a point without moving it', async () => {
    renderEditor(withCues(asset));
    await screen.findByRole('slider', { name: 'Cue in' });
    fireEvent.click(screen.getByRole('button', { name: /^Lock Intro end/ }));
    expect(screen.getByRole('button', { name: 'Unlock Intro end' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByRole('button', { name: /^Lock Intro end/ })).toBeInTheDocument();
  });

  it('is read-only without library:write', async () => {
    renderEditor(withCues(asset), false);
    const cueIn = await screen.findByRole('slider', { name: 'Cue in' });
    expect(cueIn).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('button', { name: 'Save cue points' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Play from Cue in' })).toBeEnabled();
  });

  it('lists the cue points while the waveform is pending analysis, without asking for it', () => {
    renderEditor(withCues(asset, false));
    expect(screen.getByText(/waveform is not ready yet/)).toBeInTheDocument();
    expect(row('introEnd')).toHaveTextContent('0:15.000');
    expect(calls.some((c) => c.path.endsWith('/peaks'))).toBe(false);
  });

  it('plays from a marker, past cue-out included, and leaves the cursor there', async () => {
    renderEditor(withCues(asset));
    await screen.findByRole('slider', { name: 'Cue in' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Play from Cue out' }));
    });
    const [main] = FakeAudio.all;
    expect(main?.currentTime).toBe(195);
    expect(main?.paused).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByRole('button', { name: 'Play from the cursor' })).toBeInTheDocument();
    expect(document.querySelector('[data-position]')).toHaveTextContent('3:15.000');
  });

  it('previews the transition into a searched track', async () => {
    renderEditor(withCues(asset));
    await screen.findByRole('slider', { name: 'Cue in' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search songs' }), {
      target: { value: 'lum' },
    });
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.path.endsWith('/library/search') &&
            (c.body as { filter: { q?: string } }).filter.q === 'lum',
        ),
      ).toBe(true),
    );
    const select = screen.getByRole('combobox', { name: 'Next track' });
    await waitFor(() => expect(within(select).queryByText(/Silence/)).toBeNull());
    // Never the edited asset; only playable songs are asked for.
    expect(within(select).queryByText(/Été indien/)).toBeNull();
    expect(calls.find((c) => c.path.endsWith('/library/search'))?.body).toMatchObject({
      filter: { types: ['song'], playable: true },
    });
    fireEvent.change(select, { target: { value: nextA.id } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Preview the transition' }));
    });
    await waitFor(() => expect(FakeAudio.all[1]?.src).toContain(`/assets/${nextA.id}/audio`));
    expect(FakeAudio.all[0]?.currentTime).toBe(184);
    expect(screen.getAllByRole('button', { name: 'Stop' }).length).toBeGreaterThan(0);
  });

  it('draws a random next track from the whole station', async () => {
    renderEditor(withCues(asset));
    await screen.findByRole('slider', { name: 'Cue in' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Random' }));
    });
    expect(calls.find((c) => c.path.endsWith('/library/random'))?.body).toEqual({
      filter: { types: ['song'], playable: true },
      exclude: [asset.id],
    });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Next track' })).toHaveValue(nextA.id),
    );
  });

  it('says when the next track has no audio any more', async () => {
    const error = vi.spyOn(toast, 'error');
    renderEditor(withCues(asset));
    await screen.findByRole('slider', { name: 'Cue in' });
    const select = screen.getByRole('combobox', { name: 'Next track' });
    await waitFor(() => expect(within(select).getByText(/Silence/)).toBeInTheDocument());
    fireEvent.change(select, { target: { value: nextB.id } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Preview the transition' }));
    });
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        'This track has no playout copy any more: pick another one.',
      ),
    );
    expect(FakeAudio.all.every((a) => a.paused)).toBe(true);
  });
});
