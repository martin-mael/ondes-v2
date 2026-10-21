import { run, SAFE_INPUT, type Tools } from '../ingest/ffmpeg.ts';
import type { LoudnessSeries } from './detect.ts';

// Frame loudness of a file, from one ffmpeg decode pass (#20). The audio is cut into 100 ms
// frames (`asetnsamples`, so frame `i` starts at sample `i * frameSamples`); `astats` gives
// each frame's sample peak and `ebur128` its momentary loudness (the 400 ms window ending at
// the frame's end) and the running integrated loudness. `ametadata` prints both per frame
// on stdout.

/** 100 ms at the playout copy's 44.1 kHz. */
export const FRAME_SECONDS = 0.1;

/** Time limit: a base plus a tenth of a second per audio second (decoding is fast). */
export const analysisTimeoutMs = (durationSeconds: number) =>
  60_000 + Math.ceil(durationSeconds * 100);

export function analysisArgs(input: string, frameSamples: number): string[] {
  return [
    '-nostdin',
    '-v',
    'error',
    ...SAFE_INPUT,
    '-i',
    input,
    '-map',
    '0:a:0',
    '-vn',
    '-af',
    [
      `asetnsamples=n=${frameSamples}:p=0`,
      'astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level',
      'ebur128=metadata=1',
      'ametadata=mode=print:file=-',
    ].join(','),
    '-f',
    'null',
    '-',
  ];
}

/** Collects `ametadata=mode=print` lines into a {@link LoudnessSeries}. */
export class FrameParser {
  readonly #frameSamples: number;
  readonly #momentary: number[] = [];
  readonly #peak: number[] = [];
  #index = -1;
  #integrated = -Infinity;

  constructor(frameSamples: number) {
    this.#frameSamples = frameSamples;
  }

  push(line: string): void {
    if (line.startsWith('frame:')) {
      const pts = /\bpts:(-?\d+)/.exec(line);
      // Audio filter timestamps count samples; frames are on the `asetnsamples` grid.
      this.#index = pts ? Math.round(Number(pts[1]) / this.#frameSamples) : this.#index + 1;
      this.#momentary[this.#index] = -Infinity;
      this.#peak[this.#index] = Number.NaN;
      return;
    }
    if (this.#index < 0) return;
    const eq = line.indexOf('=');
    if (eq < 0) return;
    const key = line.slice(0, eq);
    const value = parseLevel(line.slice(eq + 1));
    if (key === 'lavfi.r128.M') this.#momentary[this.#index] = value;
    else if (key === 'lavfi.r128.I') this.#integrated = value;
    else if (key === 'lavfi.astats.Overall.Peak_level') this.#peak[this.#index] = value;
  }

  series(sampleRate: number, totalSamples: number): LoudnessSeries {
    const frames = this.#index + 1;
    // Holes (a frame without its lines) read as silence and as an unknown peak.
    const momentary = Float64Array.from({ length: frames }, (_, i) => {
      return this.#momentary[i] ?? -Infinity;
    });
    const peak = Float64Array.from({ length: frames }, (_, i) => this.#peak[i] ?? Number.NaN);
    return {
      sampleRate,
      frameSamples: this.#frameSamples,
      totalSamples,
      momentary,
      peak,
      integratedLufs: this.#integrated,
    };
  }
}

/** `-inf`, `nan` and garbage are silence. */
function parseLevel(text: string): number {
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : -Infinity;
}

/**
 * Runs the analysis pass on a local file. Rejects with `ToolError` when ffmpeg rejects the file
 * and `ToolKilledError` when it is killed or times out, like ingest's tools. The output is
 * buffered: about 400 bytes per frame, 15 MB for an hour.
 */
export async function analyseFile(
  tools: Tools,
  path: string,
  file: { sampleRate: number; totalSamples: number },
  options: { signal?: AbortSignal } = {},
): Promise<LoudnessSeries> {
  const frameSamples = Math.round(file.sampleRate * FRAME_SECONDS);
  const { stdout } = await run(tools.ffmpeg, analysisArgs(path, frameSamples), {
    signal: options.signal,
    timeoutMs: analysisTimeoutMs(file.totalSamples / file.sampleRate),
  });
  const parser = new FrameParser(frameSamples);
  for (const line of stdout.split('\n')) parser.push(line);
  return parser.series(file.sampleRate, file.totalSamples);
}
