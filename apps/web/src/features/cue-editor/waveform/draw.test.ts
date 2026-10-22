import { decodePeaks, encodePeaks } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { drawPeaks, pickLevel } from './draw.ts';

// A mono asset of 8192 samples: silent first half, full scale second half.
function fixture() {
  const level = (spp: number) => {
    const points = Math.ceil(8192 / spp);
    const values = new Int8Array(points * 2);
    for (let p = 0; p < points; p++) {
      if (p * spp >= 4096) {
        values[p * 2] = -128;
        values[p * 2 + 1] = 127;
      }
    }
    return { samplesPerPoint: spp, points, values };
  };
  return decodePeaks(
    encodePeaks({
      sampleRate: 44_100,
      channels: 1,
      lengthSamples: 8192,
      levels: [level(256), level(4096)],
    }),
  );
}

function recorder() {
  const rects: [number, number, number, number][] = [];
  const ctx = {
    fillStyle: '',
    clearRect() {},
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push([x, y, w, h]);
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rects };
}

describe('drawPeaks', () => {
  it('picks the coarsest level with a point per pixel', () => {
    const peaks = fixture();
    expect(pickLevel(peaks, 100)?.samplesPerPoint).toBe(256);
    expect(pickLevel(peaks, 300)?.samplesPerPoint).toBe(256);
    expect(pickLevel(peaks, 5000)?.samplesPerPoint).toBe(4096);
  });

  it('draws loud columns full height and silent ones as a thin line', () => {
    const peaks = fixture();
    const { ctx, rects } = recorder();
    drawPeaks(ctx, peaks, { fromSample: 0, toSample: 8192 }, 32, 100, { color: 'red' });
    // Baseline first, then one bar per column.
    const bars = rects.slice(1);
    expect(bars).toHaveLength(32);
    const heights = bars.map(([, , , h]) => Math.round(h));
    expect(heights.slice(0, 16).every((h) => h <= 2)).toBe(true);
    expect(heights.slice(16).every((h) => h >= 99)).toBe(true);
  });

  it('draws nothing outside the asset', () => {
    const peaks = fixture();
    const { ctx, rects } = recorder();
    drawPeaks(ctx, peaks, { fromSample: -8192, toSample: 0 }, 32, 100, { color: 'red' });
    expect(rects).toHaveLength(0);
    const half = recorder();
    drawPeaks(half.ctx, peaks, { fromSample: -8192, toSample: 8192 }, 32, 100, { color: 'red' });
    expect(half.rects.slice(1)).toHaveLength(16);
    expect(half.rects[0]?.[0]).toBe(16);
  });
});
