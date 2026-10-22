import { describe, expect, it } from 'vitest';
import {
  centreView,
  clampView,
  fullView,
  MIN_VIEW_SAMPLES,
  sampleToX,
  scrollView,
  xToSample,
  zoomView,
} from './view.ts';

describe('waveform view', () => {
  const view = { fromSample: 1000, toSample: 11_000 };

  it('maps samples to pixels and back', () => {
    expect(sampleToX(view, 100, 1000)).toBe(0);
    expect(sampleToX(view, 100, 6000)).toBe(50);
    expect(sampleToX(view, 100, 11_000)).toBe(100);
    expect(sampleToX(view, 100, 0)).toBe(-10);
    expect(xToSample(view, 100, 50)).toBe(6000);
    expect(xToSample(view, 100, 33.333)).toBe(4333);
  });

  it('zooms around the anchor, keeping it at the same x', () => {
    const zoomed = zoomView(view, 2, 3500);
    expect(zoomed.toSample - zoomed.fromSample).toBe(5000);
    expect(sampleToX(zoomed, 100, 3500)).toBeCloseTo(sampleToX(view, 100, 3500));
  });

  it('clamps to the asset and to the narrowest window', () => {
    expect(clampView({ fromSample: -500, toSample: 9500 }, 100_000)).toEqual({
      fromSample: 0,
      toSample: 10_000,
    });
    expect(clampView({ fromSample: 95_000, toSample: 105_000 }, 100_000)).toEqual({
      fromSample: 90_000,
      toSample: 100_000,
    });
    expect(clampView({ fromSample: -1, toSample: 1e9 }, 100_000)).toEqual(fullView(100_000));
    const narrow = zoomView(view, 1000, 5000, 100_000);
    expect(narrow.toSample - narrow.fromSample).toBe(MIN_VIEW_SAMPLES);
  });

  it('scrolls, unclamped or within the asset', () => {
    expect(scrollView(view, -2000)).toEqual({ fromSample: -1000, toSample: 9000 });
    expect(scrollView(view, -2000, 100_000)).toEqual({ fromSample: 0, toSample: 10_000 });
  });

  it('centres a window on a sample', () => {
    expect(centreView(50_000, 10_000, 100_000)).toEqual({ fromSample: 45_000, toSample: 55_000 });
    expect(centreView(1000, 10_000, 100_000)).toEqual({ fromSample: 0, toSample: 10_000 });
  });
});
