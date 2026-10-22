import { spawn } from 'node:child_process';
import { endianness } from 'node:os';
import { ISLAND_FORMAT, type SourcePcm } from '@ondes/shared';
import { ToolError, ToolKilledError, type Tools } from '../ingest/ffmpeg.ts';

// ffmpeg I/O for the island renderer. Decoding goes to 32-bit integer PCM (a 16- or 24-bit
// FLAC is exact in it, and in float32 after scaling), cut with `atrim` on sample counts so the
// range is sample-exact whatever the packet grid. Encoding takes 24-bit samples on stdin and
// writes the playout format: FLAC, 44.1 kHz, fixed 1024-sample blocks, bit-exact (the same mix
// always gives the same bytes). Same error classes as ingest (`ToolError`, `ToolKilledError`).

if (endianness() !== 'LE')
  throw new Error('island-render: s32le samples need a little-endian host');

const TIMEOUT_MS = 60_000;

type Spawned = { stdout: Buffer[]; stderr: string };

function runTool(
  tools: Tools,
  args: string[],
  options: { input?: Uint8Array; signal?: AbortSignal; onStdout?: (chunk: Buffer) => void },
): Promise<Spawned> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return new Promise((resolve, reject) => {
    const child = spawn(tools.ffmpeg, args, {
      stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      signal,
    });
    const out: Buffer[] = [];
    let err = '';
    let failed = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (options.onStdout) options.onStdout(chunk);
      else out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString('utf8')).slice(-8000);
    });
    if (options.input && child.stdin) {
      // EPIPE when ffmpeg exits early: its exit code says why.
      child.stdin.on('error', () => {});
      child.stdin.end(options.input);
    }
    child.on('error', (error) => {
      failed = true;
      if (timeout.aborted) {
        reject(new ToolKilledError(tools.ffmpeg, `timed out after ${TIMEOUT_MS} ms`));
      } else reject(error);
    });
    child.on('close', (code, signalName) => {
      if (failed) return;
      if (code === 0) resolve({ stdout: out, stderr: err });
      else if (code === null) reject(new ToolKilledError(tools.ffmpeg, `killed by ${signalName}`));
      else reject(new ToolError(tools.ffmpeg, code, err.trim().split('\n').slice(-10).join('\n')));
    });
  });
}

/**
 * Samples `[from, to)` of the FLAC at `path`, one array per channel. Fewer than `to − from`
 * when the file is shorter.
 */
export async function decodeRange(
  tools: Tools,
  path: string,
  range: { from: number; to: number; channels: number },
  signal?: AbortSignal,
): Promise<SourcePcm> {
  const { channels } = range;
  const frames = range.to - range.from;
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  let carry = Buffer.alloc(0);
  let n = 0;
  const frameBytes = 4 * channels;
  await runTool(
    tools,
    [
      '-nostdin',
      '-v',
      'error',
      '-protocol_whitelist',
      'file',
      '-format_whitelist',
      'flac',
      '-i',
      path,
      '-map',
      '0:a:0',
      '-af',
      `atrim=start_sample=${range.from}:end_sample=${range.to}`,
      '-f',
      's32le',
      '-c:a',
      'pcm_s32le',
      'pipe:1',
    ],
    {
      signal,
      onStdout: (chunk) => {
        const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        const usable = data.length - (data.length % frameBytes);
        for (let o = 0; o < usable && n < frames; o += frameBytes, n++) {
          for (let c = 0; c < channels; c++) {
            (out[c] as Float32Array)[n] = data.readInt32LE(o + 4 * c) / 2 ** 31;
          }
        }
        carry = Buffer.from(data.subarray(usable));
      },
    },
  );
  return n === frames ? out : out.map((ch) => ch.subarray(0, n));
}

/** Encodes interleaved stereo 24-bit samples to the island format at `output`. */
export async function encodeIsland(
  tools: Tools,
  samples: Int32Array,
  output: string,
  signal?: AbortSignal,
): Promise<void> {
  // 24-bit values in the top bits of s32, which ffmpeg's FLAC encoder takes as 24-bit.
  const input = new Int32Array(samples.length);
  for (let i = 0; i < samples.length; i++) input[i] = (samples[i] as number) * 256;
  await runTool(
    tools,
    [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      's32le',
      '-ar',
      String(ISLAND_FORMAT.sampleRate),
      '-ch_layout',
      'stereo',
      '-i',
      'pipe:0',
      '-map_metadata',
      '-1',
      '-c:a',
      'flac',
      '-frame_size',
      String(ISLAND_FORMAT.blockSize),
      '-sample_fmt',
      's32',
      '-bits_per_raw_sample',
      String(ISLAND_FORMAT.bitDepth),
      '-flags',
      '+bitexact',
      '-fflags',
      '+bitexact',
      '-f',
      'flac',
      output,
    ],
    { input: new Uint8Array(input.buffer), signal },
  );
}
