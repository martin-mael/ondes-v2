import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../../app/api/client.ts';
import { fadeGain, TRANSITION_TAIL_S, type TransitionPlan } from './model.ts';

// Listening in the cue editor (#24): the asset from a marker, or a transition into a next
// track. Two <audio> elements on the asset's audio route (a redirect to its playout copy, #51).
// Like the timeline's preview it approximates the engine: no loudness gain or crossfade
// curve, but the cue positions (unsaved ones included) and a linear fade-out.

export const assetAudioUrl = (stationId: string, assetId: string, playoutSha256?: string) =>
  `${API_BASE}/stations/${stationId}/assets/${encodeURIComponent(assetId)}/audio${
    playoutSha256 ? `?v=${playoutSha256}` : ''
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

export interface CuePlayer {
  state: PlayerState;
  /** Playback position in the asset, in samples (null when stopped). */
  position: number | null;
  /** Plays the asset from `sample`, up to `stopAt` (default: its end). */
  playFrom(sample: number, stopAt?: number): void;
  /** Plays the end of the asset and the start of `next`, as `plan` times them. */
  playTransition(plan: TransitionPlan, next: NextTrack): void;
  stop(): void;
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
  const [position, setPosition] = useState<number | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const stop = useCallback(() => {
    run.current += 1;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (audios.current) for (const a of audios.current) silence(a);
    setState('idle');
    setPosition(null);
  }, []);

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
        setPosition(sample);
        if (!tick(sample)) {
          stop();
          return;
        }
        frame.current = requestAnimationFrame(step);
      };
      frame.current = requestAnimationFrame(step);
    },
    [sampleRate, stop],
  );

  const playFrom = useCallback(
    (sample: number, stopAt?: number) => {
      stop();
      const id = run.current;
      const [main] = elementsOf(audios);
      setState('asset');
      setPosition(sample);
      main.onended = () => id === run.current && stop();
      startAt(main, src, sample / sampleRate).then(
        () => follow(id, (s) => stopAt === undefined || s < stopAt),
        (error) => fail(id, error),
      );
    },
    [src, sampleRate, stop, follow, fail],
  );

  const playTransition = useCallback(
    (plan: TransitionPlan, next: NextTrack) => {
      stop();
      const id = run.current;
      const [main, incoming] = elementsOf(audios);
      setState('transition');
      setPosition(plan.fromSample);
      preload(incoming, next.src, next.fromSeconds);
      let started: number | null = null;
      startAt(main, src, plan.fromSample / sampleRate).then(
        () =>
          follow(id, (s) => {
            if (s < plan.stopAt) main.volume = fadeGain(plan, s);
            else if (!main.paused) main.pause();
            if (started === null && s >= plan.switchAt) {
              started = performance.now();
              incoming.play().catch((error) => fail(id, error));
            }
            // Ends once the next track has played its part and the outgoing one is done.
            return (
              started === null ||
              s < plan.stopAt ||
              performance.now() - started < TRANSITION_TAIL_S * 1000
            );
          }),
        (error) => fail(id, error),
      );
    },
    [src, sampleRate, stop, follow, fail],
  );

  return { state, position, playFrom, playTransition, stop };
}
