import { type AssetCues, type AssetDetail, encodePeaks } from '@ondes/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../app/i18n/i18n.tsx';
import { stationId } from '../../app/testing/render.tsx';
import { assetDetail, libraryAsset } from '../log-timeline/testing.ts';
import { CueEditorSection } from './cue-editor-section.tsx';

// The cue editor in the drawer slot, with a fake api: the waveform from the peaks route, a
// marker moved with the keyboard, the save's body (moved points locked), the read-only view and
// a track without peaks yet.

const SR = 44_100;
const LENGTH = SR * 200;
const peaksSha = 'b'.repeat(64);

function withCues(detail: AssetDetail, withPeaks = true): AssetDetail {
  const auto = (samples: number | null) => ({ samples, source: 'auto' as const, locked: false });
  const playout = detail.files[0];
  return {
    ...detail,
    files:
      withPeaks && playout
        ? [...detail.files, { ...playout, id: `${playout.id}p`, role: 'peaks', sha256: peaksSha }]
        : detail.files,
    cues: {
      assetId: detail.id,
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
    },
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

let puts: unknown[];

beforeEach(() => {
  puts = [];
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://app.test');
      if (url.pathname.endsWith('/peaks')) {
        expect(url.searchParams.get('v')).toBe(peaksSha);
        return new Response(new Blob([peaksBytes.slice()]), { status: 200 });
      }
      if (url.pathname.endsWith('/cues') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        const stored: AssetCues = {
          ...(withCues(asset).cues as AssetCues),
          cueIn: { samples: body.cueIn.samples, source: 'manual', locked: true },
        };
        return Response.json(stored);
      }
      if (url.pathname.endsWith('/library/search')) {
        return Response.json({ items: [], nextCursor: null });
      }
      return new Response(null, { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const asset = assetDetail(libraryAsset('01', 'Été indien', 200_000), 'a'.repeat(64));

function renderEditor(detail: AssetDetail, canWrite = true) {
  const refresh = vi.fn(async () => {});
  const onDirtyChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider locale="en">
        <CueEditorSection
          stationId={stationId}
          asset={detail}
          canWrite={canWrite}
          refresh={refresh}
          onDirtyChange={onDirtyChange}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { refresh, onDirtyChange };
}

describe('cue editor', () => {
  it('moves a marker and saves it locked', async () => {
    const { refresh, onDirtyChange } = renderEditor(withCues(asset));
    const cueIn = await screen.findByRole('slider', { name: 'Cue in' });
    expect(screen.getByRole('slider', { name: 'Next track starts' })).toBeInTheDocument();
    // Not set: no marker.
    expect(screen.queryByRole('slider', { name: 'Outro start' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save cue points' })).toBeDisabled();

    fireEvent.keyDown(cueIn, { key: 'ArrowRight', shiftKey: true });
    const row = document.querySelector('[data-field="cueIn"]') as HTMLElement;
    expect(row).toHaveTextContent('0:01.100');
    expect(within(row).getByText('edited')).toBeInTheDocument();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save cue points' }));
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(puts).toEqual([{ sampleRate: SR, cueIn: { samples: SR + 4410, locked: true } }]);
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
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

  it('lists the cue points while the waveform is pending analysis', () => {
    renderEditor(withCues(asset, false));
    expect(screen.getByText(/waveform is not ready yet/)).toBeInTheDocument();
    expect(document.querySelector('[data-field="introEnd"]')).toHaveTextContent('0:15.000');
  });
});
