import { MIN_VIEW_SAMPLES, type WaveformView } from '../cue-editor/waveform/index.ts';
import { ms, SR } from './model.ts';

// The editor's window on the segue axis. Unlike a single asset's view it reaches into negative
// positions (A plays before 0), so it is clamped to the segue's own bounds.

export interface Bounds {
  from: number;
  to: number;
}

/** Room left around the segue so its edges can be dragged past. */
export const BOUNDS_PAD = ms(5000);

export const padded = (b: Bounds): Bounds => ({ from: b.from - BOUNDS_PAD, to: b.to + BOUNDS_PAD });

/** Keeps `view` inside `bounds`: no narrower than a few points, no wider than the bounds. */
export function clampAxisView(view: WaveformView, bounds: Bounds): WaveformView {
  const max = Math.max(MIN_VIEW_SAMPLES, bounds.to - bounds.from);
  const span = Math.min(max, Math.max(MIN_VIEW_SAMPLES, view.toSample - view.fromSample));
  const from = Math.min(Math.max(bounds.from, view.fromSample), bounds.to - span);
  return { fromSample: from, toSample: from + span };
}

/** What opens first: the 25 s around the transition. */
export const initialView = (transition: number): WaveformView => ({
  fromSample: transition - ms(12_000),
  toSample: transition + ms(13_000),
});

const STEPS_S = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120] as const;

/** Ruler ticks: a round step that leaves at least `minPx` between labels. */
export function ticks(view: WaveformView, width: number, minPx = 72): number[] {
  if (width <= 0) return [];
  const spanS = (view.toSample - view.fromSample) / SR;
  const step = STEPS_S.find((s) => (s / spanS) * width >= minPx) ?? 300;
  const stepSamples = step * SR;
  const first = Math.ceil(view.fromSample / stepSamples) * stepSamples;
  const out: number[] = [];
  for (let at = first; at <= view.toSample; at += stepSamples) out.push(Math.round(at));
  return out;
}

/** `-3.5 s`, `+12 s`, `0 s`: a position relative to A's end. */
export function formatOffset(samples: number, decimals = 1): string {
  const s = samples / SR;
  const rounded = Number(s.toFixed(decimals));
  const text = rounded.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
  return `${rounded > 0 ? '+' : ''}${text} s`;
}
