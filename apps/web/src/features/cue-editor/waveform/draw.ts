import type { DecodedPeaks, PeaksLevel } from '@ondes/shared';
import { samplesPerPixel, type WaveformView } from './view.ts';

// Canvas drawing of peaks (#24): one vertical min..max bar per device pixel column, each
// channel in its own band (stereo: left on top). Pure apart from the context it draws on, so the
// segue editor (#58) can call it on its own canvases.

export interface DrawPeaksStyle {
  /** Fill of the bars (any CSS colour). */
  color: string;
  /** Fill of the zero line between bars, drawn where the audio is silent. Default: `color`. */
  baselineColor?: string;
}

/** The coarsest level that still has at least one point per pixel, else the finest. */
export function pickLevel(peaks: DecodedPeaks, samplesPerPx: number): PeaksLevel | undefined {
  let chosen = peaks.levels[0];
  for (const level of peaks.levels) {
    if (level.samplesPerPoint <= samplesPerPx) chosen = level;
  }
  return chosen;
}

/**
 * Draws the window `view` of `peaks` across `width` × `height` pixels of `ctx`'s current
 * transform (CSS pixels when the caller scaled the context by devicePixelRatio; `pixelRatio`
 * then sets how many columns are drawn per CSS pixel). Clears that rectangle first.
 */
export function drawPeaks(
  ctx: CanvasRenderingContext2D,
  peaks: DecodedPeaks,
  view: WaveformView,
  width: number,
  height: number,
  style: DrawPeaksStyle,
  pixelRatio = 1,
): void {
  ctx.clearRect(0, 0, width, height);
  const columns = Math.max(0, Math.floor(width * pixelRatio));
  if (columns === 0 || height <= 0 || peaks.lengthSamples <= 0) return;
  const colWidth = width / columns;
  const perColumn = samplesPerPixel(view, width) / pixelRatio;
  const level = pickLevel(peaks, perColumn);
  if (!level || perColumn <= 0) return;
  const { channels } = peaks;
  const band = height / channels;
  const half = band / 2;
  const values = level.values;
  const spp = level.samplesPerPoint;
  const baseline = style.baselineColor ?? style.color;

  for (let c = 0; c < channels; c++) {
    const mid = band * c + half;
    ctx.fillStyle = baseline;
    // The zero line, clipped to the asset's extent.
    const startX = Math.max(0, ((0 - view.fromSample) / perColumn) * colWidth);
    const endX = Math.min(width, ((peaks.lengthSamples - view.fromSample) / perColumn) * colWidth);
    if (endX > startX) ctx.fillRect(startX, mid - 0.5, endX - startX, 1);
    ctx.fillStyle = style.color;
    for (let col = 0; col < columns; col++) {
      const from = view.fromSample + col * perColumn;
      const to = from + perColumn;
      if (to <= 0 || from >= peaks.lengthSamples) continue;
      const first = Math.max(0, Math.floor(Math.max(0, from) / spp));
      const last = Math.min(level.points - 1, Math.max(first, Math.ceil(to / spp) - 1));
      let min = 127;
      let max = -128;
      for (let p = first; p <= last; p++) {
        const at = (p * channels + c) * 2;
        const lo = values[at] as number;
        const hi = values[at + 1] as number;
        if (lo < min) min = lo;
        if (hi > max) max = hi;
      }
      if (max < min) continue;
      const top = mid - ((max + 0.5) / 128) * half;
      const bottom = mid - ((min - 0.5) / 128) * half;
      ctx.fillRect(
        col * colWidth,
        top,
        Math.max(colWidth, 1 / pixelRatio),
        Math.max(bottom - top, 1),
      );
    }
  }
}
