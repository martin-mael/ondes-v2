// Test material for the splice tests, generated on demand into a work directory.
// Nothing here is committed: tones and noise are synthesised by ffmpeg, the music track
// is downloaded from Wikimedia Commons and checked against its SHA-1.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpeg, SAMPLE_RATE } from './audio.ts';

export const SIGNALS = ['tone', 'noise', 'music'] as const;
export type Signal = (typeof SIGNALS)[number];

/** Playout copy formats under test. FLAC is the candidate; the rest answer "do we need lossless?". */
/**
 * `grid` is where packets start in the decoded (gapless-trimmed) signal: FLAC with a fixed
 * 1024-sample block size, AAC-LC frames of 1024 after the priming samples are trimmed, and
 * LAME MP3 frames of 1152 shifted by the 1105-sample encoder + decoder delay.
 */
export const FORMATS = {
  flac: {
    ext: 'flac',
    args: ['-c:a', 'flac', '-sample_fmt', 's32', '-frame_size', '1024'],
    grid: { size: 1024, offset: 0 },
  },
  mp3: {
    ext: 'mp3',
    args: ['-c:a', 'libmp3lame', '-b:a', '256k'],
    grid: { size: 1152, offset: 1152 - 1105 },
  },
  aac: { ext: 'm4a', args: ['-c:a', 'aac', '-b:a', '256k'], grid: { size: 1024, offset: 0 } },
} as const;
export type Format = keyof typeof FORMATS;

/**
 * "Scheming Weasel (faster)" by Kevin MacLeod (incompetech.com), CC BY 4.0, via Wikimedia
 * Commons. 16-bit 44.1 kHz WAV, ~89 s.
 */
export const MUSIC = {
  title: 'Kevin MacLeod - Scheming Weasel (faster)',
  license: 'CC BY 4.0',
  page: 'https://commons.wikimedia.org/wiki/File:Kevin_MacLeod_-_Scheming_Weasel_(faster).wav',
  url: 'https://upload.wikimedia.org/wikipedia/commons/9/9e/Kevin_MacLeod_-_Scheming_Weasel_%28faster%29.wav',
  sha1: '95593b6585d1c04f380a927a3ae6c456fa86e51a',
};

export type Material = {
  /** 24-bit FLAC masters: what the island renderer would read. */
  masters: { a: string; vt: string; b: string };
};

const LENGTH_S = 30;

/** Raised-cosine fade in/out of `f` seconds on a `d`-second clip, as an aeval expression. */
const clipEnvelope = (d: number, f: number) =>
  `if(lt(t,${f}),(1-cos(PI*t/${f}))/2,if(gt(t,${d - f}),(1-cos(PI*(${d}-t)/${f}))/2,1))`;

function synth(path: string, expr: string, duration: number): void {
  if (existsSync(path)) return;
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `aevalsrc='${expr}|${expr}':s=${SAMPLE_RATE}:d=${duration}`,
    ...FORMATS.flac.args,
    path,
  ]);
}

function noise(path: string, seed: number, amplitude: number, duration: number, env = '1') {
  if (existsSync(path)) return;
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `anoisesrc=color=white:seed=${seed}:amplitude=${amplitude}:sample_rate=${SAMPLE_RATE}:duration=${duration}`,
    '-af',
    `aformat=channel_layouts=stereo,aeval='val(0)*${env}|val(1)*${env}'`,
    ...FORMATS.flac.args,
    path,
  ]);
}

async function downloadMusic(cacheDir: string): Promise<string> {
  const path = join(cacheDir, 'music-source.wav');
  if (existsSync(path)) return path;
  const res = await fetch(MUSIC.url, { headers: { 'user-agent': 'ondes-splice-test/0.1' } });
  if (!res.ok) throw new Error(`could not download ${MUSIC.url}: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const sha1 = createHash('sha1').update(body).digest('hex');
  if (sha1 !== MUSIC.sha1) throw new Error(`music checksum mismatch: ${sha1}`);
  writeFileSync(path, body);
  return path;
}

export async function makeMaterial(signal: Signal, dir: string): Promise<Material> {
  mkdirSync(dir, { recursive: true });
  const masters = {
    a: join(dir, `${signal}-a.flac`),
    vt: join(dir, `${signal}-vt.flac`),
    b: join(dir, `${signal}-b.flac`),
  };
  const vtLength = 2;
  if (signal === 'tone') {
    synth(masters.a, '0.5*sin(2*PI*440*t)', LENGTH_S);
    synth(masters.b, '0.5*sin(2*PI*660*t)', LENGTH_S);
    synth(masters.vt, `0.4*sin(2*PI*1000*t)*${clipEnvelope(vtLength, 0.02)}`, vtLength);
  } else if (signal === 'noise') {
    noise(masters.a, 1, 0.25, LENGTH_S);
    noise(masters.b, 2, 0.25, LENGTH_S);
    noise(masters.vt, 3, 0.25, vtLength, clipEnvelope(vtLength, 0.02));
  } else {
    const src = await downloadMusic(dir);
    if (!existsSync(masters.a)) {
      ffmpeg(['-i', src, '-ar', String(SAMPLE_RATE), '-ac', '2', ...FORMATS.flac.args, masters.a]);
    }
    // B is the same track: the B body seeks deep into it, which is the case we care about.
    if (!existsSync(masters.b)) writeFileSync(masters.b, readFileSync(masters.a));
    noise(masters.vt, 3, 0.2, vtLength, clipEnvelope(vtLength, 0.02));
  }
  return { masters };
}

/** Encodes a master into a playout copy of `format` (FLAC is re-used as is). */
export function playoutCopy(master: string, format: Format): string {
  if (format === 'flac') return master;
  const out = master.replace(/\.flac$/, `.${FORMATS[format].ext}`);
  if (!existsSync(out)) ffmpeg(['-i', master, ...FORMATS[format].args, out]);
  return out;
}
