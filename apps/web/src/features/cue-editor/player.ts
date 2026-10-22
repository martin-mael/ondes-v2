import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { API_BASE } from '../../app/api/client.ts';
import { fadeGain, TRANSITION_TAIL_S, type TransitionPlan } from './model.ts';

// Listening in the cue editor (#24): the asset from a marker, or a transition into a next
// track. Two <audio> elements on the asset's audio route (a redirect to its playout copy, #51).
// Like the timeline's preview it approximates the engine: no loudness gain or crossfade
// curve, but the cue positions (unsaved ones included) and a linear fade-out.

export const assetAudioUrl = (stationId: string, assetId: string, playoutSha256?: string) =>
  `${API_BASE}/stations/${encodeURIComponent(stationId)}/assets/${encodeURIComponent(assetId)}/audio${
    playoutSha256 ? `?v=${encodeURIComponent(playoutSha256)}` : ''
  }`;

/** Loads `src` and plays it from `seconds` once the browser knows the media. */
function startAt(audio: HTMLAudioElement, src: string, seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    audio.onloadedmetadata = () => {
      audio.onloadedmetadata = null;
      audio.currentTime = seconds;
      audio.play().then(resolve, reject);
    };
    audio.onerror = () => reject(new Error('audio error'));
    audio.volume = 1;
    audio.src = src;
    audio.load();
  });
}

/** Loads `src` at `seconds` without playing, so the next track starts on time. */
function preload(audio: HTMLAudioElement, src: string, seconds: number) {
  audio.onloadedmetadata = () => {
    audio.onloadedmetadata = null;
    audio.currentTime = seconds;
  };
  audio.volume = 1;
  audio.src = src;
  audio.load();
}

function silence(audio: HTMLAudioElement) {
  audio.onloadedmetadata = null;
  audio.onerror = null;
  audio.onended = null;
  audio.pause();
  audio.removeAttribute('src');
}

/** The player's two elements (the asset, the next track), created on first use. */
function elementsOf(ref: { current: [HTMLAudioElement, HTMLAudioElement] | null }) {
  ref.current ??= [new Audio(), new Audio()];
  return ref.current;
}

export interface NextTrack {
  src: string;
  /** Where it starts: its cue-in, in seconds. */
  fromSeconds: number;
}

export type PlayerState = 'idle' | 'asset' | 'transition';

/**
 * The playback position, outside React state: it changes every frame, and only the parts that
 * show it (the playhead, the time) subscribe, through {@link usePlayerPosition}.
 */
export interface PositionStore {
  /** Position in the asset, in samples (null when stopped). */
  get(): number | null;
  subscribe(listener: () => void): () => void;
}

export interface CuePlayer {
  state: PlayerState;
  position: PositionStore;
  /**
   * Plays the asset from `sample`, up to `stopAt` (default: its end). Starting at or past
   * `stopAt` plays to the end instead of stopping at once.
   */
  playFrom(sample: number, stopAt?: number): void;
  /** Plays the end of the asset and the start of `next`, as `plan` times them. */
  playTransition(plan: TransitionPlan, next: NextTrack): void;
  stop(): void;
}

/** The playback position (re-renders the caller on every frame while playing). */
export function usePlayerPosition(player: Pick<CuePlayer, 'position'>): number | null {
  return useSyncExternalStore(player.position.subscribe, player.position.get, player.position.get);
}

function createPositionStore(): PositionStore & { set(position: number | null): void } {
  let value: number | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(position) {
      if (position === value) return;
      value = position;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useCuePlayer({
  src,
  sampleRate,
  onError,
}: {
  src: string;
  sampleRate: number;
  onError?: (error: unknown) => void;
}): CuePlayer {
  const audios = useRef<[HTMLAudioElement, HTMLAudioElement] | null>(null);
  const frame = useRef<number | null>(null);
  const run = useRef(0);
  const [state, setState] = useState<PlayerState>('idle');
  const [position] = useState(createPositionStore);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const stop = useCallback(() => {
    run.current += 1;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (audios.current) for (const a of audios.current) silence(a);
    setState('idle');
    position.set(null);
  }, [position]);

  useEffect(() => stop, [stop]);
  // A new asset (or a new playout copy) stops what was playing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: src is the trigger
  useEffect(() => stop(), [src, stop]);

  const fail = useCallback(
    (id: number, error: unknown) => {
      if (id !== run.current) return;
      stop();
      onErrorRef.current?.(error);
    },
    [stop],
  );

  /** Follows the main element's position each frame; `tick` returns false to stop. */
  const follow = useCallback(
    (id: number, tick: (sample: number) => boolean) => {
      const [main] = elementsOf(audios);
      const step = () => {
        if (id !== run.current) return;
        const sample = Math.round(main.currentTime * sampleRate);
        position.set(sample);
        if (!tick(sample)) {
          stop();
          return;
        }
        frame.current = requestAnimationFrame(step);
      };
      frame.current = requestAnimationFrame(step);
    },
    [sampleRate, stop, position],
  );

  const playFrom = useCallback(
    (sample: number, stopAt?: number) => {
      stop();
      const id = run.current;
      const [main] = elementsOf(audios);
      // Started at or past the stop point (in the outro, past cue-out): play to the end.
      const until = stopAt !== undefined && sample < stopAt ? stopAt : undefined;
      setState('asset');
      position.set(sample);
      main.onended = () => id === run.current && stop();
      startAt(main, src, sample / sampleRate).then(
        () => follow(id, (s) => until === undefined || s < until),
        (error) => fail(id, error),
      );
    },
    [src, sampleRate, stop, follow, fail, position],
  );

  const playTransition = useCallback(
    (plan: TransitionPlan, next: NextTrack) => {
      stop();
      const id = run.current;
      const [main, incoming] = elementsOf(audios);
      // The next track starts by the outgoing one's stop point at the latest.
      const switchAt = Math.min(plan.switchAt, plan.stopAt);
      setState('transition');
      position.set(plan.fromSample);
      preload(incoming, next.src, next.fromSeconds);
      let started: number | null = null;
      let outgoingDone = false;
      const startNext = () => {
        if (started !== null) return;
        started = performance.now();
        incoming.play().catch((error) => fail(id, error));
      };
      // The outgoing file may end before its cue-out (a stale cue): the next one starts then.
      main.onended = () => {
        if (id !== run.current) return;
        outgoingDone = true;
        startNext();
      };
      incoming.onended = () => id === run.current && stop();
      startAt(main, src, plan.fromSample / sampleRate).then(
        () =>
          follow(id, (s) => {
            if (!outgoingDone && s >= plan.stopAt) {
              outgoingDone = true;
              main.pause();
            }
            if (!outgoingDone) main.volume = fadeGain(plan, s);
            if (s >= switchAt) startNext();
            // Ends once the outgoing track is done and the next one has played its part.
            return (
              started === null ||
              !outgoingDone ||
              performance.now() - started < TRANSITION_TAIL_S * 1000
            );
          }),
        (error) => fail(id, error),
      );
    },
    [src, sampleRate, stop, follow, fail, position],
  );

  return useMemo(
    () => ({ state, position, playFrom, playTransition, stop }),
    [state, position, playFrom, playTransition, stop],
  );
}
