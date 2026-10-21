import { spawn } from 'node:child_process';
import { endianness } from 'node:os';
import { ToolError, ToolKilledError, type Tools, transcodeTimeoutMs } from '../ingest/ffmpeg.ts';

// Decodes the playout copy to interleaved 16-bit PCM on ffmpeg's stdout and hands it to
// `onSamples` chunk by chunk: a one-hour episode is 635 MB of PCM, never held in memory.
// Same input rules and error classes as ingest's `run()` (jobs/ingest/ffmpeg.ts): a non-zero
// exit is a `ToolError` (`isFileError` tells the file's fault from the machine's), a kill or
// timeout a `ToolKilledError`.

if (endianness() !== 'LE') throw new Error('peaks: s16le samples need a little-endian host');

/** Decodes `path` (the playout FLAC), keeping every channel and the sample rate as they are. */
export async function decodePcm16(
  tools: Tools,
  path: string,
  options: {
    channels: number;
    onSamples: (samples: Int16Array) => void;
    signal?: AbortSignal;
    durationSeconds?: number;
  },
): Promise<void> {
  const timeoutMs = transcodeTimeoutMs(options.durationSeconds);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const frameBytes = 2 * options.channels;
  const args = [
    '-nostdin',
    '-v',
    'error',
    // Our own playout copy, but read like any stored file: local and FLAC only.
    '-protocol_whitelist',
    'file',
    '-format_whitelist',
    'flac',
    '-i',
    path,
    '-map',
    '0:a:0',
    '-f',
    's16le',
    '-c:a',
    'pcm_s16le',
    'pipe:1',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(tools.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let carry: Buffer = Buffer.alloc(0);
    let err = '';
    let failed = false;
    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      child.kill('SIGKILL');
      reject(error);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (failed) return;
      const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      const usable = data.length - (data.length % frameBytes);
      carry = Buffer.from(data.subarray(usable));
      if (usable === 0) return;
      // Int16Array needs an even byte offset; pooled buffers usually have one.
      const bytes = data.byteOffset % 2 === 0 ? data : Buffer.from(data);
      try {
        options.onSamples(new Int16Array(bytes.buffer, bytes.byteOffset, usable / 2));
      } catch (error) {
        fail(error);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString('utf8')).slice(-8000);
    });
    child.on('error', (error) => {
      if (failed) return;
      failed = true;
      if (timeout.aborted) {
        reject(new ToolKilledError(tools.ffmpeg, `timed out after ${timeoutMs} ms`));
      } else reject(error);
    });
    child.on('close', (code, signalName) => {
      if (failed) return;
      if (code === 0) resolve();
      else if (code === null) reject(new ToolKilledError(tools.ffmpeg, `killed by ${signalName}`));
      else reject(new ToolError(tools.ffmpeg, code, err.trim().split('\n').slice(-10).join('\n')));
    });
  });
}
