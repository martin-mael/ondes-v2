// PCM helpers for the splice tests. Decoding and encoding go through the host `ffmpeg`
// binary, so every file is read with the same libavcodec decoders Liquidsoap uses.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export type Audio = {
  sampleRate: number;
  /** One Float32Array per channel, all the same length. */
  channels: Float32Array[];
};

export const SAMPLE_RATE = 44100;

/** Runs ffmpeg and throws with its stderr on failure. */
export function ffmpeg(args: string[]): void {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8',
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`ffmpeg ${args.join(' ')} failed (${res.status}):\n${res.stderr}`);
  }
}

/** Decodes any file ffmpeg reads into float PCM, at `sampleRate` and with `channels` channels. */
export function decode(path: string, sampleRate = SAMPLE_RATE, channels = 2): Audio {
  const res = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      path,
      '-f',
      'f32le',
      '-acodec',
      'pcm_f32le',
      '-ac',
      String(channels),
      '-ar',
      String(sampleRate),
      '-',
    ],
    { maxBuffer: 1 << 30 },
  );
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`ffmpeg could not decode ${path}:\n${res.stderr}`);
  const buf = res.stdout as Buffer;
  const interleaved = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return deinterleave(interleaved, channels, sampleRate);
}

export function deinterleave(data: Float32Array, channels: number, sampleRate: number): Audio {
  const frames = Math.floor(data.length / channels);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      // biome-ignore lint/style/noNonNullAssertion: c < channels
      out[c]![i] = data[i * channels + c] ?? 0;
    }
  }
  return { sampleRate, channels: out };
}

/** Writes 32-bit float WAV. Handy for listening to a failing case. */
export function writeWav(path: string, audio: Audio): void {
  const ch = audio.channels.length;
  const frames = audio.channels[0]?.length ?? 0;
  const dataBytes = frames * ch * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20); // IEEE float
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(audio.sampleRate, 24);
  buf.writeUInt32LE(audio.sampleRate * ch * 4, 28);
  buf.writeUInt16LE(ch * 4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      buf.writeFloatLE(audio.channels[c]?.[i] ?? 0, o);
      o += 4;
    }
  }
  writeFileSync(path, buf);
}

/** Copies `length` frames starting at `start`, zero-padding outside the source. */
export function slice(audio: Audio, start: number, length: number): Audio {
  return {
    sampleRate: audio.sampleRate,
    channels: audio.channels.map((ch) => {
      const out = new Float32Array(Math.max(0, length));
      for (let i = 0; i < length; i++) out[i] = ch[start + i] ?? 0;
      return out;
    }),
  };
}

export function concat(parts: Audio[]): Audio {
  const first = parts[0];
  if (!first) throw new Error('concat: nothing to concatenate');
  const total = parts.reduce((n, p) => n + (p.channels[0]?.length ?? 0), 0);
  const channels = first.channels.map(() => new Float32Array(total));
  let o = 0;
  for (const p of parts) {
    p.channels.forEach((ch, c) => {
      channels[c]?.set(ch, o);
    });
    o += p.channels[0]?.length ?? 0;
  }
  return { sampleRate: first.sampleRate, channels };
}

export const dbToLinear = (db: number): number => 10 ** (db / 20);

/** Mixes all channels down to one, which is what the detector analyses. */
export function mono(audio: Audio): Float32Array {
  const n = audio.channels[0]?.length ?? 0;
  const out = new Float32Array(n);
  for (const ch of audio.channels) {
    for (let i = 0; i < n; i++) out[i] = (out[i] ?? 0) + (ch[i] ?? 0) / audio.channels.length;
  }
  return out;
}
