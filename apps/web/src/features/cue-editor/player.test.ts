import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCuePlayer } from './player.ts';

// The cue editor's player with a fake <audio> and animation frames run by hand: play from a
// marker up to a stop point, and a transition that starts the next track on the next-track
// start and fades the outgoing one out.

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

const SR = 44_100;
let frames: FrameRequestCallback[] = [];
const runFrame = () => {
  const pending = frames;
  frames = [];
  for (const f of pending) f(0);
};

beforeEach(() => {
  FakeAudio.all = [];
  frames = [];
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f));
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => vi.unstubAllGlobals());

describe('useCuePlayer', () => {
  it('plays from a sample and stops at the stop point', async () => {
    const { result } = renderHook(() => useCuePlayer({ src: '/a.flac', sampleRate: SR }));
    await act(async () => result.current.playFrom(SR * 10, SR * 12));
    const [main] = FakeAudio.all;
    expect(main?.src).toBe('/a.flac');
    expect(main?.currentTime).toBe(10);
    expect(result.current.state).toBe('asset');
    if (!main) throw new Error('no audio');
    main.currentTime = 11;
    act(runFrame);
    expect(result.current.position.get()).toBe(SR * 11);
    main.currentTime = 12;
    act(runFrame);
    expect(result.current.state).toBe('idle');
    expect(main.paused).toBe(true);
  });

  it('plays to the end when started at or past the stop point', async () => {
    const { result } = renderHook(() => useCuePlayer({ src: '/a.flac', sampleRate: SR }));
    await act(async () => result.current.playFrom(SR * 196, SR * 195));
    const [main] = FakeAudio.all;
    if (!main) throw new Error('no audio');
    main.currentTime = 197;
    act(runFrame);
    expect(result.current.state).toBe('asset');
    expect(main.paused).toBe(false);
    act(() => main.onended?.());
    expect(result.current.state).toBe('idle');
  });

  it('starts the next track when the outgoing one ends early, and stops when it ends', async () => {
    const { result } = renderHook(() => useCuePlayer({ src: '/a.flac', sampleRate: SR }));
    await act(async () =>
      result.current.playTransition(
        { fromSample: SR * 184, switchAt: SR * 190, stopAt: SR * 195, fadeOutFrom: null },
        { src: '/b.flac', fromSeconds: 0 },
      ),
    );
    const [main, next] = FakeAudio.all;
    if (!main || !next) throw new Error('no audio');
    main.currentTime = 186;
    act(() => main.onended?.());
    expect(next.play).toHaveBeenCalled();
    act(runFrame);
    expect(result.current.state).toBe('transition');
    act(() => next.onended?.());
    expect(result.current.state).toBe('idle');
  });

  it('starts the next track at the stop point when the next-track start is past it', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const { result } = renderHook(() => useCuePlayer({ src: '/a.flac', sampleRate: SR }));
    await act(async () =>
      result.current.playTransition(
        { fromSample: SR * 190, switchAt: SR * 199, stopAt: SR * 195, fadeOutFrom: null },
        { src: '/b.flac', fromSeconds: 0 },
      ),
    );
    const [main, next] = FakeAudio.all;
    if (!main || !next) throw new Error('no audio');
    main.currentTime = 195;
    act(runFrame);
    expect(main.paused).toBe(true);
    expect(next.play).toHaveBeenCalled();
    now.mockReturnValue(7000);
    act(runFrame);
    expect(result.current.state).toBe('idle');
    now.mockRestore();
  });

  it('starts the next track on the next-track start', async () => {
    const { result } = renderHook(() => useCuePlayer({ src: '/a.flac', sampleRate: SR }));
    await act(async () =>
      result.current.playTransition(
        { fromSample: SR * 184, switchAt: SR * 190, stopAt: SR * 195, fadeOutFrom: SR * 191 },
        { src: '/b.flac', fromSeconds: 0.5 },
      ),
    );
    const [main, next] = FakeAudio.all;
    if (!main || !next) throw new Error('no audio');
    expect(main.currentTime).toBe(184);
    expect(next.src).toBe('/b.flac');
    expect(next.currentTime).toBe(0.5);
    main.currentTime = 189;
    act(runFrame);
    expect(next.play).not.toHaveBeenCalled();
    main.currentTime = 190;
    act(runFrame);
    expect(next.play).toHaveBeenCalled();
    main.currentTime = 193;
    act(runFrame);
    expect(main.volume).toBeCloseTo(0.5);
    expect(result.current.state).toBe('transition');
    act(() => result.current.stop());
    expect(next.src).toBe('');
    expect(result.current.state).toBe('idle');
  });
});
