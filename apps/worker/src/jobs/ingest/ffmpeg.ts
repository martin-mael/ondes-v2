import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { PLAYOUT_FLAC_BLOCK_SIZE, PLAYOUT_SAMPLE_RATE } from '@ondes/shared';
import { z } from 'zod';

// ffprobe/ffmpeg wrappers for ingest. Binaries come from FFPROBE_PATH / FFMPEG_PATH (default:
// on the PATH; the worker image installs Debian's ffmpeg).
//
// Uploaded files are untrusted. Both tools only read local files (`-protocol_whitelist file`)
// through the audio demuxers below (`-format_whitelist`): a ".mp3" that is really an HLS or
// concat playlist can't make ffmpeg fetch URLs (SSRF) or read other local files. The worker
// should also have no network egress beyond Postgres, RabbitMQ and S3 (deploy/README.md).

export interface Tools {
  ffmpeg: string;
  ffprobe: string;
}

export const defaultTools = (env: Record<string, string | undefined> = process.env): Tools => ({
  ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: env.FFPROBE_PATH || 'ffprobe',
});

/** Demuxers ingest accepts (ffmpeg names; `mov` covers mp4/m4a, `matroska` covers webm). */
export const AUDIO_DEMUXERS = [
  'wav',
  'w64',
  'mp3',
  'aac',
  'flac',
  'ogg',
  'aiff',
  'mov',
  'mp4',
  'm4a',
  'matroska',
  'webm',
  'wv',
  'ape',
  'caf',
  'au',
] as const;

/** Input options for an untrusted file: local file protocol and audio demuxers only. */
export const SAFE_INPUT = [
  '-protocol_whitelist',
  'file',
  '-format_whitelist',
  AUDIO_DEMUXERS.join(','),
] as const;

/** Time limits: probing is quick; transcoding gets a base plus one second per audio second. */
export const PROBE_TIMEOUT_MS = 60_000;
export const transcodeTimeoutMs = (durationSeconds: number | undefined) =>
  120_000 + Math.ceil(durationSeconds ?? 3600) * 1000;

/**
 * The tool ran and rejected the file (non-zero exit). `stderr` is its last lines, for the
 * upload's error. Only this means "broken file"; see {@link isFileError}.
 */
export class ToolError extends Error {
  readonly stderr: string;
  readonly exitCode: number;

  constructor(tool: string, exitCode: number, stderr: string) {
    super(`${tool} exited with ${exitCode}: ${stderr || '(no output)'}`);
    this.name = 'ToolError';
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

/** The tool was killed (OOM, SIGKILL, shutdown) or timed out: not the file's fault. */
export class ToolKilledError extends Error {
  constructor(tool: string, reason: string) {
    super(`${tool} ${reason}`);
    this.name = 'ToolKilledError';
  }
}

// ffmpeg exits non-zero for these too, but they are about the machine, not the file.
const MACHINE_ERRORS = [
  /No space left on device/i,
  /Cannot allocate memory/i,
  /Requested resampling engine is unavailable/i,
  /Unknown encoder/i,
  /Permission denied/i,
];

/** True when `error` says the file itself is broken or unsupported (quarantine, no retry). */
export function isFileError(error: unknown): error is ToolError {
  return error instanceof ToolError && !MACHINE_ERRORS.some((re) => re.test(error.stderr));
}

async function run(
  command: string,
  args: readonly string[],
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<{ stdout: string }> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    const out: Buffer[] = [];
    let err = '';
    let failed = false;
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep the tail only: ffmpeg can be chatty on broken input.
      err = (err + chunk.toString('utf8')).slice(-8000);
    });
    child.on('error', (error) => {
      // Spawn failures (ENOENT) and aborts (shutdown, timeout).
      failed = true;
      if (timeout.aborted) {
        reject(new ToolKilledError(command, `timed out after ${options.timeoutMs} ms`));
      } else reject(error);
    });
    child.on('close', (code, signalName) => {
      if (failed) return;
      if (code === 0) resolve({ stdout: Buffer.concat(out).toString('utf8') });
      else if (code === null) reject(new ToolKilledError(command, `killed by ${signalName}`));
      else reject(new ToolError(command, code, tail(err)));
    });
  });
}

const tail = (text: string, lines = 10) => text.trim().split('\n').slice(-lines).join('\n');

const tagsSchema = z.record(z.string(), z.string()).optional();
const intString = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : Number(v)))
  .pipe(z.number().int().optional());
const floatString = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v) => (v === undefined || v === '' || v === 'N/A' ? undefined : Number(v)))
  .pipe(z.number().optional());

const probeStreamSchema = z.object({
  index: z.int(),
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  sample_fmt: z.string().optional(),
  sample_rate: intString,
  channels: z.int().optional(),
  bits_per_sample: z.int().optional(),
  bits_per_raw_sample: intString,
  time_base: z.string().optional(),
  duration_ts: z.int().optional(),
  duration: floatString,
  disposition: z.object({ attached_pic: z.int().optional() }).loose().optional(),
  tags: tagsSchema,
});

const probeSchema = z.object({
  streams: z.array(probeStreamSchema).default([]),
  format: z
    .object({
      format_name: z.string().optional(),
      duration: floatString,
      tags: tagsSchema,
    })
    .loose()
    .optional(),
});

export type ProbeResult = z.infer<typeof probeSchema>;
export type ProbeStream = z.infer<typeof probeStreamSchema>;

export async function ffprobe(tools: Tools, path: string, signal?: AbortSignal) {
  const { stdout } = await run(
    tools.ffprobe,
    ['-v', 'error', ...SAFE_INPUT, '-print_format', 'json', '-show_format', '-show_streams', path],
    { signal, timeoutMs: PROBE_TIMEOUT_MS },
  );
  const parsed = probeSchema.safeParse(safeJson(stdout));
  // Output we can't read comes from the file (odd tags, broken headers), not the machine.
  if (!parsed.success) throw new ToolError(tools.ffprobe, 0, 'unreadable ffprobe output');
  return parsed.data;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The first real audio stream (not cover art). */
export function audioStream(probe: ProbeResult): ProbeStream | undefined {
  return probe.streams.find((s) => s.codec_type === 'audio' && !s.disposition?.attached_pic);
}

const LOSSLESS_CODECS = new Set(['flac', 'alac', 'wavpack', 'ape', 'tta', 'truehd', 'mlp']);

export function isLossless(stream: ProbeStream): boolean {
  const codec = stream.codec_name ?? '';
  return codec.startsWith('pcm_') || LOSSLESS_CODECS.has(codec);
}

/** Bits per sample of a lossless stream; `null` for lossy codecs. */
export function bitDepth(stream: ProbeStream): number | null {
  if (!isLossless(stream)) return null;
  const bits = stream.bits_per_raw_sample || stream.bits_per_sample;
  if (bits) return bits;
  if (stream.sample_fmt?.startsWith('dbl')) return 64;
  if (stream.sample_fmt?.startsWith('flt') || stream.sample_fmt?.startsWith('s32')) return 32;
  return 16;
}

/** Exact length in samples of a stream, from its timestamps when they count samples. */
export function durationSamples(stream: ProbeStream, probe: ProbeResult): number | null {
  const rate = stream.sample_rate;
  if (!rate) return null;
  if (stream.duration_ts !== undefined && stream.time_base === `1/${rate}`) {
    return stream.duration_ts;
  }
  const seconds = stream.duration ?? probe.format?.duration;
  return seconds === undefined ? null : Math.round(seconds * rate);
}

/**
 * Encodes the playout copy (spike #12): FLAC, 44.1 kHz, fixed 1024-sample blocks, first audio
 * stream only, no tags or pictures, bit-exact (the same input always gives the same bytes, so
 * a retried ingest finds the object it already stored). Resampled with SoX's resampler at
 * high precision, with triangular dither when reducing the bit depth. 24-bit when the source is lossless
 * and deeper than 16 bits, 16-bit otherwise; more than two channels are downmixed to stereo.
 */
export async function transcodePlayout(
  tools: Tools,
  input: string,
  output: string,
  stream: ProbeStream,
  options: { signal?: AbortSignal; durationSeconds?: number } = {},
): Promise<void> {
  const deep = (bitDepth(stream) ?? 16) > 16;
  await run(
    tools.ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-y',
      ...SAFE_INPUT,
      '-i',
      input,
      '-map',
      `0:${stream.index}`,
      '-vn',
      '-map_metadata',
      '-1',
      ...((stream.channels ?? 2) > 2 ? ['-ac', '2'] : []),
      '-af',
      `aresample=${PLAYOUT_SAMPLE_RATE}:resampler=soxr:precision=28:dither_method=triangular`,
      '-ar',
      String(PLAYOUT_SAMPLE_RATE),
      '-c:a',
      'flac',
      '-frame_size',
      String(PLAYOUT_FLAC_BLOCK_SIZE),
      ...(deep ? ['-sample_fmt', 's32', '-bits_per_raw_sample', '24'] : ['-sample_fmt', 's16']),
      '-flags',
      '+bitexact',
      '-fflags',
      '+bitexact',
      '-f',
      'flac',
      output,
    ],
    { signal: options.signal, timeoutMs: transcodeTimeoutMs(options.durationSeconds) },
  );
}

export interface FlacStreamInfo {
  minBlockSize: number;
  maxBlockSize: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Samples per channel; 0 when the encoder didn't know. */
  totalSamples: number;
}

/**
 * Reads a FLAC file's STREAMINFO block (the first metadata block, right after `fLaC`). Its
 * min and max block sizes are equal for a fixed-blocksize stream; only the last frame may be
 * shorter, and STREAMINFO doesn't count it in the minimum.
 */
export async function readFlacStreamInfo(path: string): Promise<FlacStreamInfo> {
  const file = await open(path, 'r');
  try {
    const buf = Buffer.alloc(42);
    const { bytesRead } = await file.read(buf, 0, 42, 0);
    return parseFlacStreamInfo(buf.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

export function parseFlacStreamInfo(buf: Buffer): FlacStreamInfo {
  if (buf.length < 42 || buf.toString('latin1', 0, 4) !== 'fLaC') {
    throw new Error('not a FLAC stream');
  }
  if ((buf.readUInt8(4) & 0x7f) !== 0)
    throw new Error('first FLAC metadata block is not STREAMINFO');
  const info = buf.subarray(8, 42);
  // Bytes 10..17 pack: sample rate (20 bits), channels-1 (3), bits-1 (5), total samples (36).
  const packed = info.readBigUInt64BE(10);
  return {
    minBlockSize: info.readUInt16BE(0),
    maxBlockSize: info.readUInt16BE(2),
    sampleRate: Number(packed >> 44n),
    channels: Number((packed >> 41n) & 0x7n) + 1,
    bitsPerSample: Number((packed >> 36n) & 0x1fn) + 1,
    totalSamples: Number(packed & 0xfffffffffn),
  };
}
// ci-probe ci-probe-worker
