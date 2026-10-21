import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../app/i18n/i18n.tsx';
import { stationId } from '../../app/testing/render.tsx';
import { type Preview, PreviewProvider, usePreview } from './preview.tsx';
import { assetDetail, libraryAsset, logItem } from './testing.ts';

// The preview player with a fake <audio> and a fetch the test answers by hand: one item from
// its cue-in, the transition on the plan's timing, failures, and no stale playback after a
// stop, a switch or an unmount.

class FakeAudio {
  static all: FakeAudio[] = [];
  src = '';
  currentTime = 0;
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
  load = vi.fn();
  constructor() {
    FakeAudio.all.push(this);
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
}

const a = libraryAsset('a1', 'Outgoing', 200_000);
const b = libraryAsset('b1', 'Incoming', 180_000);
const sha = (c: string) => c.repeat(64);

/** Answers `GET …/assets/:id` when the test says so; records aborts. */
function controlledFetch() {
  const pending = new Map<string, { resolve: () => void; signal?: AbortSignal | null }>();
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://app.test').pathname;
    const assetId = path.split('/').at(-1) ?? '';
    const body = assetId === a.id ? assetDetail(a, sha('a')) : assetDetail(b, sha('b'));
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
      pending.set(assetId, {
        signal: init?.signal,
        resolve: () => resolve(new Response(JSON.stringify(body), { status: 200 })),
      });
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const answer = async (assetId: string) => {
    await act(async () => {
      pending.get(assetId)?.resolve();
    });
  };
  return { pending, answer };
}

function renderPreview() {
  let preview: Preview | undefined;
  function Grab() {
    preview = usePreview();
    return null;
  }
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider locale="en">
        <PreviewProvider stationId={stationId}>
          <Grab />
        </PreviewProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return {
    ...view,
    get preview() {
      if (!preview) throw new Error('no preview');
      return preview;
    },
  };
}

const metadata = async (audio: FakeAudio | undefined) => {
  await act(async () => {
    audio?.onloadedmetadata?.();
  });
};

const itemA = logItem({ assetId: a.id, plannedDurationMs: 200_020, title: 'Outgoing' });
const itemB = logItem({ assetId: b.id, title: 'Incoming' });

beforeEach(() => {
  FakeAudio.all = [];
  vi.stubGlobal('Audio', FakeAudio);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('preview', () => {
  it('plays an item from its versioned audio URL', async () => {
    const { answer } = controlledFetch();
    const view = renderPreview();
    act(() => view.preview.play(itemA));
    await answer(a.id);
    const [audio] = FakeAudio.all;
    expect(audio?.src).toBe(`/api/v1/stations/${stationId}/assets/${a.id}/audio?v=${sha('a')}`);
    await metadata(audio);
    expect(audio?.play).toHaveBeenCalledOnce();
    expect(audio?.currentTime).toBe(0);
  });

  it('never starts audio that was stopped, switched away from, or unmounted', async () => {
    const { answer, pending } = controlledFetch();
    const view = renderPreview();

    // Stopped while A's details load: A never plays, its fetch is aborted.
    act(() => view.preview.play(itemA));
    act(() => view.preview.stop());
    expect(pending.get(a.id)?.signal?.aborted).toBe(true);
    await answer(a.id);
    expect(FakeAudio.all[0]?.src ?? '').toBe('');

    // Switched to B while A loads: only B plays, even when A answers last.
    act(() => view.preview.play(itemA));
    act(() => view.preview.play(itemB));
    await answer(b.id);
    await answer(a.id);
    const [audio] = FakeAudio.all;
    expect(audio?.src).toContain(b.id);
    await metadata(audio);
    expect(audio?.play).toHaveBeenCalledOnce();

    // Unmounted while loading: aborted, and the element is silenced.
    act(() => view.preview.play(itemA));
    view.unmount();
    expect(pending.get(a.id)?.signal?.aborted).toBe(true);
    expect(audio?.onloadedmetadata).toBeNull();
    expect(audio?.pause).toHaveBeenCalled();
  });

  it('replaces the media handlers on each load instead of piling them up', async () => {
    const { answer } = controlledFetch();
    const view = renderPreview();
    act(() => view.preview.play(itemA));
    await answer(a.id);
    const [audio] = FakeAudio.all;
    const first = audio?.onloadedmetadata;
    act(() => view.preview.play(itemA));
    // Served from the cache this time.
    await act(async () => {});
    expect(audio?.onloadedmetadata).not.toBe(first);
    await metadata(audio);
    expect(audio?.play).toHaveBeenCalledOnce();
  });

  it('plays the transition on the plan’s timing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { answer } = controlledFetch();
    const view = renderPreview();
    act(() => view.preview.playTransition(itemA, itemB));
    expect(view.preview.playing?.label).toBe('Transition: Outgoing → Incoming');
    await answer(a.id);
    await answer(b.id);
    const [outgoing, incoming] = FakeAudio.all;
    expect(incoming?.src).toContain(b.id);
    await metadata(outgoing);
    // 200 s slot: B starts at A's 200 s; A plays from 8 s before.
    expect(outgoing?.currentTime).toBe(192);
    expect(incoming?.play).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(8_000);
    });
    expect(incoming?.play).toHaveBeenCalledOnce();
    expect(incoming?.currentTime).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(8_000);
    });
    expect(view.preview.playing).toBeNull();
    expect(outgoing?.pause).toHaveBeenCalled();
  });

  it('reports a transition that can’t play, and stops', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => 0);
    const { answer } = controlledFetch();
    const view = renderPreview();
    act(() => view.preview.playTransition(itemA, itemB));
    await answer(a.id);
    await answer(b.id);
    const [, incoming] = FakeAudio.all;
    await act(async () => {
      incoming?.onerror?.();
    });
    expect(error).toHaveBeenCalledWith('Can’t play this audio (no playout file yet?).');
    expect(view.preview.playing).toBeNull();
  });
});
