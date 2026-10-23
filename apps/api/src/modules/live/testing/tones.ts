import { readFileSync, writeFileSync } from 'node:fs';

// Test audio for the live switching engine test (#64): pure tones written as 16-bit WAV, and
// an analysis of the recorded final mix that says which tone was on air when and where it went
// silent. Each source of the test plays its own frequency, so the recording tells them apart.

export const RATE = 44100;

/** Writes a mono 16-bit WAV of a sine at `freq` Hz, `seconds` long, at half scale. */
export function writeTone(path: string, freq: number, seconds: number): void {
  const n = Math.round(seconds * RATE);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / RATE) * 16384), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

/**
 * The first channel of a 16-bit PCM WAV, as floats. Reads the `data` chunk up to the end of
 * the file: a recording cut short leaves its header's sizes unset.
 */
export function readWavChannel(path: string): { rate: number; samples: Float32Array } {
  const buf = readFileSync(path);
  let off = 12;
  let rate = RATE;
  let channels = 1;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10);
      rate = buf.readUInt32LE(off + 12);
      if (buf.readUInt16LE(off + 22) !== 16) throw new Error('expected 16-bit PCM');
    }
    if (id === 'data') {
      const start = off + 8;
      const frames = Math.floor((buf.length - start) / (2 * channels));
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++)
        samples[i] = buf.readInt16LE(start + i * 2 * channels) / 32768;
      return { rate, samples };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${path}`);
}

export type Window = {
  /** Seconds from the start of the recording. */
  at: number;
  /** RMS level in dBFS (-120 for digital silence). */
  db: number;
  /** Frequency estimated from zero crossings, in Hz. */
  freq: number;
};

/** Level and zero-crossing frequency per window of `seconds`. */
export function analyse(samples: Float32Array, rate: number, seconds = 0.1): Window[] {
  const size = Math.round(rate * seconds);
  const out: Window[] = [];
  for (let start = 0; start + size <= samples.length; start += size) {
    let sum = 0;
    let crossings = 0;
    for (let i = start; i < start + size; i++) {
      const x = samples[i] ?? 0;
      sum += x * x;
      if (i > start && (samples[i - 1] ?? 0) < 0 !== x < 0) crossings++;
    }
    const rms = Math.sqrt(sum / size);
    out.push({
      at: start / rate,
      db: rms > 1e-6 ? 20 * Math.log10(rms) : -120,
      freq: crossings / 2 / seconds,
    });
  }
  return out;
}

/** The label of the closest tone within 8 %, or null (silence, a crossfade, a mix). */
export function classify(w: Window, tones: Record<string, number>, minDb = -40): string | null {
  if (w.db < minDb) return null;
  for (const [label, freq] of Object.entries(tones)) {
    if (Math.abs(w.freq - freq) <= freq * 0.08) return label;
  }
  return null;
}

export type Run = { label: string; from: number; to: number };

/**
 * What aired, in order: runs of windows with the same tone, at least `minWindows` long (shorter
 * ones are crossfades and mixes), with neighbouring runs of the same tone merged.
 */
export function toneRuns(windows: Window[], tones: Record<string, number>, minWindows = 3): Run[] {
  const raw: Run[] = [];
  const step = windows.length > 1 ? (windows[1]?.at ?? 0) - (windows[0]?.at ?? 0) : 0;
  for (const w of windows) {
    const label = classify(w, tones);
    if (label === null) continue;
    const last = raw.at(-1);
    if (last && last.label === label && Math.abs(last.to - w.at) < step / 2) last.to = w.at + step;
    else raw.push({ label, from: w.at, to: w.at + step });
  }
  const runs: Run[] = [];
  for (const r of raw) {
    if ((r.to - r.from) / step < minWindows - 0.01) continue;
    const last = runs.at(-1);
    if (last && last.label === r.label) last.to = r.to;
    else runs.push({ ...r });
  }
  return runs;
}

/** Windows quieter than `minDb` between `from` and `to` seconds: dead air. */
export function silentWindows(windows: Window[], from: number, to: number, minDb = -40): Window[] {
  return windows.filter((w) => w.at >= from && w.at < to && w.db < minDb);
}

/**
 * Level of one frequency in dBFS (sine amplitude, -120 floor) per window of `seconds` from
 * `from` to `to` seconds (Goertzel): tells whether a tone is still there under another one,
 * where zero crossings only see the mix.
 */
export function toneLevels(
  samples: Float32Array,
  rate: number,
  freq: number,
  from: number,
  to: number,
  seconds = 0.1,
): { at: number; db: number }[] {
  const size = Math.round(rate * seconds);
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / rate);
  const out: { at: number; db: number }[] = [];
  for (
    let start = Math.round(from * rate);
    start + size <= Math.min(samples.length, to * rate);
    start += size
  ) {
    let s1 = 0;
    let s2 = 0;
    for (let i = start; i < start + size; i++) {
      const s0 = (samples[i] ?? 0) + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    const amplitude = (2 * Math.sqrt(Math.max(power, 0))) / size;
    out.push({ at: start / rate, db: amplitude > 1e-6 ? 20 * Math.log10(amplitude) : -120 });
  }
  return out;
}
