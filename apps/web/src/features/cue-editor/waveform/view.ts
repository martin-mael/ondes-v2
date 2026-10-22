// Time ↔ pixel mapping of a waveform (#24), shared by the cue editor and the segue editor
// (#58). Positions are sample positions at the peaks' sample rate (the playout copy's, like cue
// points); a view is the window `[fromSample, toSample)` drawn across the canvas's width. A view
// may reach before 0 or past the asset's end (lanes on a shared axis): nothing is drawn there.

export interface WaveformView {
  fromSample: number;
  toSample: number;
}

/** Samples one CSS pixel covers. */
export const samplesPerPixel = (view: WaveformView, width: number) =>
  width > 0 ? (view.toSample - view.fromSample) / width : 0;

/** X (CSS pixels from the left edge) of a sample position. */
export function sampleToX(view: WaveformView, width: number, sample: number): number {
  const span = view.toSample - view.fromSample;
  return span > 0 ? ((sample - view.fromSample) / span) * width : 0;
}

/** Sample position at x (CSS pixels from the left edge), rounded to an integer sample. */
export function xToSample(view: WaveformView, width: number, x: number): number {
  return Math.round(
    view.fromSample + (width > 0 ? (x / width) * (view.toSample - view.fromSample) : 0),
  );
}

/** The whole asset. */
export const fullView = (lengthSamples: number): WaveformView => ({
  fromSample: 0,
  toSample: Math.max(1, lengthSamples),
});

/** Narrowest window: this many samples (≈ 23 ms at 44.1 kHz, a few pixels per peaks point). */
export const MIN_VIEW_SAMPLES = 1024;

/**
 * Keeps a view inside `[0, lengthSamples)`, no narrower than {@link MIN_VIEW_SAMPLES} and no
 * wider than the asset, shifting it rather than shrinking it when it overflows an edge.
 */
export function clampView(view: WaveformView, lengthSamples: number): WaveformView {
  const length = Math.max(1, lengthSamples);
  const span = Math.min(length, Math.max(MIN_VIEW_SAMPLES, view.toSample - view.fromSample));
  const from = Math.min(Math.max(0, view.fromSample), length - span);
  return { fromSample: Math.max(0, from), toSample: Math.max(0, from) + span };
}

/**
 * Zooms by `factor` (> 1 zooms in) around `anchorSample`, which stays at the same x.
 * Clamped to the asset when `lengthSamples` is given.
 */
export function zoomView(
  view: WaveformView,
  factor: number,
  anchorSample: number,
  lengthSamples?: number,
): WaveformView {
  const span = view.toSample - view.fromSample;
  const ratio = span > 0 ? (anchorSample - view.fromSample) / span : 0.5;
  const next = span / factor;
  const fromSample = anchorSample - ratio * next;
  const zoomed = { fromSample, toSample: fromSample + next };
  return lengthSamples === undefined ? zoomed : clampView(zoomed, lengthSamples);
}

/** Moves the window by `deltaSamples`, clamped to the asset when `lengthSamples` is given. */
export function scrollView(
  view: WaveformView,
  deltaSamples: number,
  lengthSamples?: number,
): WaveformView {
  const moved = {
    fromSample: view.fromSample + deltaSamples,
    toSample: view.toSample + deltaSamples,
  };
  return lengthSamples === undefined ? moved : clampView(moved, lengthSamples);
}

/** A window of `spanSamples` centred on `sample`, clamped to the asset. */
export function centreView(
  sample: number,
  spanSamples: number,
  lengthSamples: number,
): WaveformView {
  return clampView(
    { fromSample: sample - spanSamples / 2, toSample: sample + spanSamples / 2 },
    lengthSamples,
  );
}
