import { describe, expect, it } from 'vitest';
import {
  compareJoins,
  detectClicks,
  detectDropouts,
  findLag,
  joinEvents,
  trackAlignment,
} from './seam-detector.ts';

const SR = 44100;

function sine(n: number, freq: number, amp = 0.5, phase = 0): Float32Array {
  return Float32Array.from(
    { length: n },
    (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / SR + phase),
  );
}

/** Deterministic white noise (mulberry32). */
function noise(n: number, seed = 1, amp = 0.25): Float32Array {
  let a = seed;
  return Float32Array.from({ length: n }, () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return amp * (((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5) * 2;
  });
}

const drop = (x: Float32Array, at: number, k: number) =>
  Float32Array.from([...x.subarray(0, at), ...x.subarray(at + k)]);
const insert = (x: Float32Array, at: number, extra: Float32Array) =>
  Float32Array.from([...x.subarray(0, at), ...extra, ...x.subarray(at)]);

describe('detectClicks', () => {
  it('finds nothing in a clean tone', () => {
    expect(detectClicks(sine(SR, 440), SR)).toEqual([]);
  });

  it('finds a single dropped sample', () => {
    const events = detectClicks(drop(sine(SR, 440), 20_000, 1), SR);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('click');
    expect(Math.abs((events[0]?.offset ?? 0) - 20_000)).toBeLessThan(16);
  });

  it('finds a 0.5 dB gain step', () => {
    const x = sine(SR, 440);
    for (let i = 30_000; i < x.length; i++) x[i] = (x[i] ?? 0) * 10 ** (0.5 / 20);
    const events = detectClicks(x, SR);
    expect(events).toHaveLength(1);
    expect(Math.abs((events[0]?.offset ?? 0) - 30_000)).toBeLessThan(16);
  });

  it('ignores a smooth fade', () => {
    const x = sine(SR, 660);
    for (let i = 0; i < x.length; i++) x[i] = (x[i] ?? 0) * (1 - i / x.length);
    expect(detectClicks(x, SR)).toEqual([]);
  });
});

describe('detectDropouts', () => {
  it('reports inserted digital silence with its length', () => {
    const events = detectDropouts(insert(sine(SR, 440), 10_000, new Float32Array(211)));
    expect(events).toEqual([expect.objectContaining({ kind: 'dropout', samples: 211 })]);
    expect(Math.abs((events[0]?.offset ?? 0) - 10_000)).toBeLessThanOrEqual(1);
  });

  it('ignores zero crossings and leading silence', () => {
    expect(detectDropouts(insert(sine(SR, 440), 0, new Float32Array(500)))).toEqual([]);
  });
});

describe('findLag', () => {
  it('finds the exact lag on noise', () => {
    const r = noise(20_000);
    const y = insert(r, 0, new Float32Array(37));
    expect(findLag(y, r, 5000, 2048, 200).lag).toBe(37);
  });

  it('resolves the period ambiguity of a tone to the smallest lag', () => {
    const r = sine(20_000, 441); // period 100 samples
    expect(findLag(r, r, 5000, 2048, 300).lag).toBe(0);
  });
});

describe('trackAlignment', () => {
  it('reports dropped samples as an overlap at the right place', () => {
    const r = noise(SR * 3);
    const { events } = trackAlignment(drop(r, 70_000, 443), r);
    expect(events).toEqual([expect.objectContaining({ kind: 'overlap', samples: 443 })]);
    expect(Math.abs((events[0]?.offset ?? 0) - 70_000)).toBeLessThan(4096 + 1024);
  });

  it('reports inserted samples as a gap', () => {
    const r = noise(SR * 3);
    const { events } = trackAlignment(insert(r, 50_000, noise(877, 9)), r);
    expect(events).toEqual([expect.objectContaining({ kind: 'gap', samples: 877 })]);
  });

  it('reports output that does not match the reference at all', () => {
    const r = noise(SR * 2);
    const y = Float32Array.from([...r.subarray(0, SR), ...noise(SR, 99)]);
    const { events } = trackAlignment(y, r);
    expect(events).toEqual([expect.objectContaining({ kind: 'mismatch' })]);
    expect(Math.abs((events[0]?.offset ?? 0) - SR)).toBeLessThan(4096 + 1024);
  });

  it('is silent on an identical signal', () => {
    const r = noise(SR * 2);
    expect(trackAlignment(r, r).events).toEqual([]);
  });
});

describe('compareJoins', () => {
  it('measures shift and residual at a join', () => {
    const r = noise(SR * 2);
    const y = drop(r, 40_000, 1);
    const [report] = compareJoins(y, r, [{ at: 40_000, label: 'A→island' }]);
    expect(report).toMatchObject({ lagBefore: 0, lagAfter: -1, shift: -1 });
    // The missing sample is also a waveform discontinuity, hence the mismatch.
    expect(joinEvents(report ? [report] : [], -70)).toEqual([
      expect.objectContaining({ kind: 'overlap', samples: 1 }),
      expect.objectContaining({ kind: 'mismatch' }),
    ]);
  });

  it('flags a gain mismatch as a residual', () => {
    const r = noise(SR * 2);
    const y = r.map((v, i) => (i >= 40_000 ? v * 10 ** (-0.1 / 20) : v));
    const reports = compareJoins(y, r, [{ at: 40_000 }]);
    expect(reports[0]?.shift).toBe(0);
    expect(reports[0]?.residualDb).toBeGreaterThan(-45);
    expect(joinEvents(reports, -70)).toEqual([expect.objectContaining({ kind: 'mismatch' })]);
  });

  it('passes a sample-exact splice', () => {
    const r = noise(SR * 2);
    const reports = compareJoins(r, r, [{ at: 40_000, span: 441 }]);
    expect(reports[0]).toMatchObject({ shift: 0, residualDb: -Infinity });
    expect(joinEvents(reports, -70)).toEqual([]);
  });
});
