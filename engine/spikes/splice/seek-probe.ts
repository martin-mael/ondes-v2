// Spike probe: where does Liquidsoap actually start when a request carries `liq_cue_in`?
//
// For each format and target sample, plays one white-noise request with that cue-in and a
// cue-out 0.5 s later, then finds where the output really starts in the source by exact
// correlation (white noise has no self-similarity) and how long it played.
//
//   node engine/spikes/splice/seek-probe.ts [--decoder flac|mad|faad|mp4] [--formats flac-1024,mp3]
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { decode, ffmpeg, mono, SAMPLE_RATE } from '../../tests/splice/audio.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const { values } = parseArgs({
  options: {
    decoder: { type: 'string', default: '' },
    formats: { type: 'string', default: 'flac-1024,flac-4096,mp3,aac' },
    image: { type: 'string', default: 'savonet/liquidsoap:v2.4.6' },
  },
});
const work = join(repo, 'engine/tests/splice/.work/seek-probe');
mkdirSync(work, { recursive: true });

const master = join(work, 'noise.flac');
ffmpeg([
  '-f',
  'lavfi',
  '-i',
  `anoisesrc=color=white:seed=7:amplitude=0.25:sample_rate=${SAMPLE_RATE}:duration=30`,
  '-af',
  'aformat=channel_layouts=stereo',
  '-c:a',
  'flac',
  '-sample_fmt',
  's32',
  master,
]);
const variants: Record<string, { ext: string; args: string[] }> = {
  'flac-1024': { ext: 'flac', args: ['-c:a', 'flac', '-sample_fmt', 's32', '-frame_size', '1024'] },
  'flac-4096': { ext: 'flac', args: ['-c:a', 'flac', '-sample_fmt', 's32', '-frame_size', '4096'] },
  mp3: { ext: 'mp3', args: ['-c:a', 'libmp3lame', '-b:a', '256k'] },
  aac: { ext: 'm4a', args: ['-c:a', 'aac', '-b:a', '256k'] },
  'aac-adts': { ext: 'aac', args: ['-c:a', 'aac', '-b:a', '256k'] },
  wav: { ext: 'wav', args: ['-c:a', 'pcm_s24le'] },
};

// Targets: odd positions, exact packet multiples, and one just past a multiple.
const targets = [
  0, 1, 1023, 1024, 1025, 1152, 4096, 4097, 88_211, 89_088, 308_737, 352_837, 353_280, 441_001,
  600_123,
];
const segment = Math.round(0.5 * SAMPLE_RATE);
const sec = (n: number) => (n / SAMPLE_RATE).toFixed(9);

for (const name of values.formats.split(',')) {
  const v = variants[name];
  if (!v) throw new Error(`unknown format ${name}`);
  const file = join(work, `noise-${name}.${v.ext}`);
  ffmpeg(['-i', master, ...v.args, file]);
  // Decoded by the ffmpeg CLI, i.e. with the gapless trimming the island renderer would see.
  const src = mono(decode(file));
  for (const t of targets) {
    const uri = `annotate:liq_cue_in="${sec(t)}",liq_cue_out="${sec(t + segment)}":/work/noise-${name}.${v.ext}`;
    writeFileSync(join(work, 'probe.m3u'), `${uri}\n`);
    const res = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${work}:/work`,
        '-v',
        `${join(repo, 'engine/tests/splice/splice.liq')}:/splice.liq:ro`,
        '-e',
        'SPLICE_PLAYLIST=/work/probe.m3u',
        '-e',
        'SPLICE_OUT=/work/probe.wav',
        '-e',
        `SPLICE_DECODER=${values.decoder}`,
        values.image,
        '/splice.liq',
      ],
      { encoding: 'utf8' },
    );
    if (res.status !== 0) throw new Error(res.stdout + res.stderr);
    const y = mono(decode(join(work, 'probe.wav')));
    // Locate output[1024, 1536) in the source within ±40000 samples of the target.
    let best = -1;
    let at = -1;
    for (let s0 = Math.max(0, t - 40_000); s0 < Math.min(src.length - 512, t + 40_000); s0++) {
      let d = 0;
      let e1 = 0;
      let e2 = 0;
      for (let i = 0; i < 512; i++) {
        const a = y[1024 + i] ?? 0;
        const b = src[s0 + i] ?? 0;
        d += a * b;
        e1 += a * a;
        e2 += b * b;
      }
      const c = d / Math.sqrt(e1 * e2 + 1e-30);
      if (c > best) {
        best = c;
        at = s0;
      }
    }
    const landed = at - 1024;
    console.log(
      `${name.padEnd(9)} target ${String(t).padStart(7)}  landed ${String(landed).padStart(7)}  error ${String(landed - t).padStart(6)}  played ${y.length - segment >= 0 ? '+' : ''}${y.length - segment}  corr ${best.toFixed(4)}`,
    );
  }
}
