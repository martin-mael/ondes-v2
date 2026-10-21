import { run, ToolError, type Tools, transcodeTimeoutMs } from '../ingest/ffmpeg.ts';

// EBU R128 / ITU-R BS.1770-4 measurement with ffmpeg's `ebur128` filter (true peak on: 4×
// oversampled). Only ever run on our own playout copies (FLAC), so the input whitelist is the
// local file protocol and the FLAC demuxer, nothing else.

export interface Ebur128Result {
  integratedLufs: number;
  loudnessRangeLu: number | null;
  /** `null` for digital silence (`-inf`). */
  truePeakDbtp: number | null;
}

/** ffmpeg prints `-inf` (or `inf`) for silence. */
const NUMBER = String.raw`(-?inf|-?\d+(?:\.\d+)?)`;

/**
 * Reads the filter's closing summary from ffmpeg's log. The filter prints it at the `info`
 * level once the input ends, last; only the last `Summary:` counts.
 */
export function parseEbur128Summary(log: string): Ebur128Result {
  const at = log.lastIndexOf('Summary:');
  if (at < 0) throw new Error('no ebur128 summary in the ffmpeg output');
  const summary = log.slice(at);
  const integrated = summary.match(
    new RegExp(String.raw`Integrated loudness:\s*I:\s*${NUMBER} LUFS`),
  );
  const lra = summary.match(new RegExp(String.raw`Loudness range:\s*LRA:\s*${NUMBER} LU\b`));
  const peak = summary.match(new RegExp(String.raw`True peak:\s*Peak:\s*${NUMBER} dBFS`));
  if (!integrated?.[1]) throw new Error('no integrated loudness in the ebur128 summary');
  return {
    // Gated silence measures -70 (the absolute gate); older builds print -inf.
    integratedLufs: Math.max(-70, toNumber(integrated[1]) ?? -70),
    loudnessRangeLu: lra?.[1] ? toNumber(lra[1]) : null,
    truePeakDbtp: peak?.[1] ? toNumber(peak[1]) : null,
  };
}

function toNumber(text: string): number | null {
  const value = Number(text.replace('inf', 'Infinity'));
  return Number.isFinite(value) ? value : null;
}

/**
 * Measures a FLAC file. A mono file is measured as dual mono (+3 dB): the stream is stereo, so
 * the engine plays it on both channels, and that is the loudness listeners get.
 */
export async function measureLoudness(
  tools: Tools,
  path: string,
  options: { channels: number | null; durationSeconds?: number; signal?: AbortSignal },
): Promise<Ebur128Result> {
  const dualMono = options.channels === 1;
  const { stderr } = await run(
    tools.ffmpeg,
    [
      '-nostdin',
      '-hide_banner',
      '-nostats',
      '-v',
      'info',
      '-protocol_whitelist',
      'file',
      '-format_whitelist',
      'flac',
      '-i',
      path,
      '-map',
      '0:a:0',
      '-af',
      `ebur128=peak=true:framelog=quiet${dualMono ? ':dualmono=true' : ''}`,
      '-f',
      'null',
      '-',
    ],
    { signal: options.signal, timeoutMs: transcodeTimeoutMs(options.durationSeconds) },
  );
  try {
    return parseEbur128Summary(stderr);
  } catch (error) {
    // ffmpeg decoded the file but printed no usable summary: a file problem, not the machine's.
    throw new ToolError(tools.ffmpeg, 0, error instanceof Error ? error.message : String(error));
  }
}

const versions = new Map<string, Promise<string>>();

/** `7.1.5-0+deb13u1`, from `ffmpeg -version`; cached per binary. */
export function ffmpegVersion(tools: Tools): Promise<string> {
  let version = versions.get(tools.ffmpeg);
  if (!version) {
    version = run(tools.ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 30_000 }).then(
      ({ stdout }) => stdout.match(/ffmpeg version (\S+)/)?.[1] ?? 'unknown',
    );
    version.catch(() => versions.delete(tools.ffmpeg));
    versions.set(tools.ffmpeg, version);
  }
  return version;
}
