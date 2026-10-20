// Automated seam detector: finds audible splices in a recorded engine output.
//
// Two families of checks:
// - Reference-free, for steady tones: `detectClicks` (spectral splatter: energy above a
//   cutoff where a low tone has none) and `detectDropouts` (runs of digital silence inside
//   loud audio).
// - Against a reference (the ideal, offline splice): `trackAlignment` measures the
//   output→reference lag along the whole file and reports every lag change as a gap
//   (samples inserted) or an overlap (samples dropped), with its sample offset;
//   `compareJoins` measures lag and residual around each known join.
//
// Pure functions over Float32Array, no I/O, so the island renderer (#56) can reuse them in CI.

export type SeamEventKind = 'click' | 'dropout' | 'gap' | 'overlap' | 'mismatch';

export type SeamEvent = {
  kind: SeamEventKind;
  /** Sample offset in the analysed (output) signal. */
  offset: number;
  /** Inserted (gap) or dropped (overlap) sample count, when relevant. */
  samples?: number;
  /** Level of the anomaly in dBFS (clicks) or dB relative to the reference (mismatch). */
  levelDb?: number;
  detail: string;
};

export const toDb = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -Infinity);

// ---------------------------------------------------------------------------------------
// High-pass filter: 8th-order Butterworth as four cascaded biquads (RBJ cookbook).
// A 1 kHz tone is ~144 dB down at 8 kHz, so anything left above the cutoff is splatter.

const BUTTERWORTH_8_Q = [0.50980263, 0.60134489, 0.89997622, 2.56291545];

export function highPass(x: Float32Array, sampleRate: number, cutoffHz: number): Float64Array {
  let y = Float64Array.from(x);
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cos = Math.cos(w0);
  for (const q of BUTTERWORTH_8_Q) {
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    const b0 = (1 + cos) / 2 / a0;
    const b1 = -(1 + cos) / a0;
    const b2 = b0;
    const a1 = (-2 * cos) / a0;
    const a2 = (1 - alpha) / a0;
    const out = new Float64Array(y.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const xi = y[i] ?? 0;
      const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      out[i] = yi;
      x2 = x1;
      x1 = xi;
      y2 = y1;
      y1 = yi;
    }
    y = out;
  }
  return y;
}

function median(values: number[]): number {
  if (values.length === 0) return -Infinity;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? -Infinity;
}

// ---------------------------------------------------------------------------------------
// Clicks / spectral splatter (steady low tones only).

export type ClickOptions = {
  /** High-pass cutoff. Keep it well above the highest test tone. */
  cutoffHz?: number;
  /** Analysis window in samples (hop = window / 2). */
  window?: number;
  /** A window is flagged above this absolute level (dBFS RMS)... */
  absoluteDb?: number;
  /** ...and this many dB above the median window level (lossy codecs raise the floor). */
  relativeDb?: number;
  /** Samples ignored at both ends (filter settling, file edges). */
  edge?: number;
};

export function detectClicks(
  x: Float32Array,
  sampleRate: number,
  options: ClickOptions = {},
): SeamEvent[] {
  const { cutoffHz = 8000, window = 64, absoluteDb = -90, relativeDb = 20, edge = 2048 } = options;
  const hp = highPass(x, sampleRate, cutoffHz);
  const hop = Math.max(1, window >> 1);
  const levels: { start: number; db: number }[] = [];
  for (let start = edge; start + window <= hp.length - edge; start += hop) {
    let sum = 0;
    for (let i = start; i < start + window; i++) sum += (hp[i] ?? 0) ** 2;
    levels.push({ start, db: toDb(Math.sqrt(sum / window)) });
  }
  const floor = median(levels.map((l) => l.db));
  const threshold = Math.max(absoluteDb, floor + relativeDb);

  const events: SeamEvent[] = [];
  let run: { start: number; end: number } | null = null;
  const flush = () => {
    if (!run) return;
    let peak = 0;
    let at = run.start;
    for (let i = run.start; i < run.end; i++) {
      const v = Math.abs(hp[i] ?? 0);
      if (v > peak) {
        peak = v;
        at = i;
      }
    }
    events.push({
      kind: 'click',
      offset: at,
      levelDb: toDb(peak),
      detail: `HF splatter above ${cutoffHz} Hz peaks at ${toDb(peak).toFixed(1)} dBFS (threshold ${threshold.toFixed(1)} dB RMS)`,
    });
    run = null;
  };
  for (const l of levels) {
    if (l.db > threshold) {
      if (run && l.start <= run.end) run.end = l.start + window;
      else {
        flush();
        run = { start: l.start, end: l.start + window };
      }
    }
  }
  flush();
  return events;
}

// ---------------------------------------------------------------------------------------
// Dropouts: digital silence inside audio that should be continuous.

export type DropoutOptions = {
  /** Minimum run of near-silent samples to report. */
  minSamples?: number;
  /** |sample| below this counts as silent. */
  silence?: number;
  /** RMS (linear) the surrounding audio must exceed for the run to count as a dropout. */
  context?: number;
  contextWindow?: number;
};

export function detectDropouts(x: Float32Array, options: DropoutOptions = {}): SeamEvent[] {
  const { minSamples = 8, silence = 1e-5, context = 1e-3, contextWindow = 1024 } = options;
  const rms = (from: number, to: number) => {
    const a = Math.max(0, from);
    const b = Math.min(x.length, to);
    if (b <= a) return 0;
    let s = 0;
    for (let i = a; i < b; i++) s += (x[i] ?? 0) ** 2;
    return Math.sqrt(s / (b - a));
  };
  const events: SeamEvent[] = [];
  let i = 0;
  while (i < x.length) {
    if (Math.abs(x[i] ?? 0) >= silence) {
      i++;
      continue;
    }
    let j = i;
    while (j < x.length && Math.abs(x[j] ?? 0) < silence) j++;
    const len = j - i;
    if (
      len >= minSamples &&
      i > 0 &&
      j < x.length &&
      rms(i - contextWindow, i) > context &&
      rms(j, j + contextWindow) > context
    ) {
      events.push({
        kind: 'dropout',
        offset: i,
        samples: len,
        detail: `${len} samples of silence inside audio`,
      });
    }
    i = j;
  }
  return events;
}

// ---------------------------------------------------------------------------------------
// Alignment against a reference.

/**
 * Lag that best aligns `output` with `reference` over `reference[start, start + length)`:
 * `output[n + lag] ≈ reference[n]`. Normalised cross-correlation, searched in
 * `[around - maxLag, around + maxLag]`. Near-ties (periodic signals) resolve to the lag
 * closest to `around`.
 */
export function findLag(
  output: Float32Array,
  reference: Float32Array,
  start: number,
  length: number,
  maxLag: number,
  around = 0,
): { lag: number; correlation: number } {
  let refEnergy = 0;
  for (let n = start; n < start + length; n++) refEnergy += (reference[n] ?? 0) ** 2;
  const scores: { lag: number; c: number }[] = [];
  let best = -Infinity;
  for (let lag = around - maxLag; lag <= around + maxLag; lag++) {
    let dot = 0;
    let outEnergy = 0;
    for (let n = start; n < start + length; n++) {
      const o = output[n + lag] ?? 0;
      dot += (reference[n] ?? 0) * o;
      outEnergy += o * o;
    }
    const c = refEnergy > 0 && outEnergy > 0 ? dot / Math.sqrt(refEnergy * outEnergy) : 0;
    scores.push({ lag, c });
    if (c > best) best = c;
  }
  let pick: { lag: number; c: number } | undefined;
  for (const s of scores) {
    if (s.c < best - 1e-4) continue;
    if (!pick || Math.abs(s.lag - around) < Math.abs(pick.lag - around)) pick = s;
  }
  return { lag: pick?.lag ?? around, correlation: pick?.c ?? 0 };
}

export type AlignmentOptions = {
  /** Distance between lag measurements, in samples. */
  step?: number;
  window?: number;
  /** Search range around the previous lag. */
  maxLag?: number;
  /** Search range used for the first measurement and whenever the narrow search fails. */
  wideLag?: number;
  /** Below this correlation the output is not aligned with the reference there. */
  minCorrelation?: number;
  /** Reference windows quieter than this (linear RMS) are skipped instead. */
  silence?: number;
};

export type AlignmentPoint = { at: number; lag: number; correlation: number };

/**
 * Measures the lag every `step` samples of the reference and reports each change as a
 * `gap` (output has extra samples) or an `overlap` (output is missing samples). Event
 * offsets are output positions, located between the two measurements that disagree.
 * Meaningful on noise and music; on a steady tone the lag is only known modulo a period.
 */
export function trackAlignment(
  output: Float32Array,
  reference: Float32Array,
  options: AlignmentOptions = {},
): { points: AlignmentPoint[]; events: SeamEvent[] } {
  const {
    step = 4096,
    window = 1024,
    maxLag = 256,
    wideLag = 4096,
    minCorrelation = 0.9,
    silence = 1e-4,
  } = options;
  const points: AlignmentPoint[] = [];
  const events: SeamEvent[] = [];
  let prev: AlignmentPoint | null = null;
  // Loud reference stretches the output cannot be aligned with: wrong content altogether.
  // One unaligned window alone is just a window straddling a gap or overlap.
  let lost: { from: number; to: number; windows: number } | null = null;
  const flushLost = () => {
    if (!lost || lost.windows < 2) {
      lost = null;
      return;
    }
    events.push({
      kind: 'mismatch',
      offset: lost.from + (prev?.lag ?? 0),
      detail: `output does not match the reference over reference [${lost.from}, ${lost.to})`,
    });
    lost = null;
  };
  for (let at = 0; at + window <= reference.length; at += step) {
    let energy = 0;
    for (let n = at; n < at + window; n++) energy += (reference[n] ?? 0) ** 2;
    if (Math.sqrt(energy / window) < silence) continue;
    let r: { lag: number; correlation: number } | null = prev
      ? findLag(output, reference, at, window, maxLag, prev.lag)
      : null;
    if (!r || r.correlation < minCorrelation) {
      r = findLag(output, reference, at, window, wideLag, prev?.lag ?? 0);
    }
    if (r.correlation < minCorrelation) {
      if (lost) {
        lost.to = at + window;
        lost.windows++;
      } else lost = { from: at, to: at + window, windows: 1 };
      continue;
    }
    flushLost();
    const p: AlignmentPoint = { at, lag: r.lag, correlation: r.correlation };
    points.push(p);
    if (prev && p.lag !== prev.lag) {
      const shift = p.lag - prev.lag;
      events.push({
        kind: shift > 0 ? 'gap' : 'overlap',
        offset: prev.at + window + prev.lag,
        samples: Math.abs(shift),
        detail:
          shift > 0
            ? `${shift} extra samples in the output between reference ${prev.at} and ${p.at}`
            : `${-shift} samples missing from the output between reference ${prev.at} and ${p.at}`,
      });
    }
    prev = p;
  }
  flushLost();
  return { points, events };
}

export type Join = {
  /** Reference sample where the join starts. */
  at: number;
  /** Length of the micro-crossfade (0 for a butt splice). */
  span?: number;
  label?: string;
};

export type JoinReport = {
  label: string;
  at: number;
  lagBefore: number;
  lagAfter: number;
  /** lagAfter - lagBefore: > 0 gap, < 0 overlap, 0 sample-exact. */
  shift: number;
  correlationBefore: number;
  correlationAfter: number;
  /** Worst residual (output - aligned reference) around the join, dB relative to reference RMS. */
  residualDb: number;
  /** Residual in a quiet stretch before the join: the codec/noise floor. */
  baselineDb: number;
};

export type JoinOptions = {
  window?: number;
  maxLag?: number;
  /** Distance kept between a join and the windows measuring the lag on each side. */
  guard?: number;
  /** Residual analysis window. */
  residualWindow?: number;
  /** How far around the join the residual is scanned. */
  residualSpan?: number;
};

export function compareJoins(
  output: Float32Array,
  reference: Float32Array,
  joins: Join[],
  options: JoinOptions = {},
): JoinReport[] {
  const {
    window = 4096,
    maxLag = 4096,
    guard = 1024,
    residualWindow = 256,
    residualSpan = 4410,
  } = options;
  let refPower = 0;
  for (const v of reference) refPower += v * v;
  const refRms = Math.sqrt(refPower / Math.max(1, reference.length));

  const residual = (from: number, to: number, lagFor: (n: number) => number) => {
    let worst = 0;
    for (
      let s = Math.max(0, from);
      s + residualWindow <= Math.min(reference.length, to);
      s += residualWindow >> 1
    ) {
      let e = 0;
      for (let n = s; n < s + residualWindow; n++) {
        e += ((output[n + lagFor(n)] ?? 0) - (reference[n] ?? 0)) ** 2;
      }
      worst = Math.max(worst, Math.sqrt(e / residualWindow));
    }
    return toDb(worst / refRms);
  };

  return joins.map((j, i) => {
    const span = j.span ?? 0;
    const before = findLag(output, reference, j.at - guard - window, window, maxLag);
    const after = findLag(output, reference, j.at + span + guard, window, maxLag, before.lag);
    const lagFor = (n: number) => (n < j.at + span / 2 ? before.lag : after.lag);
    return {
      label: j.label ?? `join ${i + 1}`,
      at: j.at,
      lagBefore: before.lag,
      lagAfter: after.lag,
      shift: after.lag - before.lag,
      correlationBefore: before.correlation,
      correlationAfter: after.correlation,
      residualDb: residual(j.at - residualSpan, j.at + span + residualSpan, lagFor),
      baselineDb: residual(j.at - guard - window, j.at - guard, () => before.lag),
    };
  });
}

/** Turns join reports into events: shifts become gaps/overlaps, loud residuals mismatches. */
export function joinEvents(reports: JoinReport[], maxResidualDb: number): SeamEvent[] {
  const events: SeamEvent[] = [];
  for (const r of reports) {
    const offset = r.at + r.lagBefore;
    if (r.shift !== 0) {
      events.push({
        kind: r.shift > 0 ? 'gap' : 'overlap',
        offset,
        samples: Math.abs(r.shift),
        detail: `${r.label}: output ${r.shift > 0 ? 'gains' : 'loses'} ${Math.abs(r.shift)} samples`,
      });
    }
    if (r.residualDb > maxResidualDb) {
      events.push({
        kind: 'mismatch',
        offset,
        levelDb: r.residualDb,
        detail: `${r.label}: residual ${r.residualDb.toFixed(1)} dB (floor ${r.baselineDb.toFixed(1)} dB, limit ${maxResidualDb} dB)`,
      });
    }
  }
  return events;
}
