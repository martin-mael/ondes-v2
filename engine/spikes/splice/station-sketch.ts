// Spike: runs station-sketch.liq on Z → [A body | island | B body] → C, with the station
// crossfade around the chain, and checks the island joins inside the chain.
//
//   node engine/tests/splice/run.ts --only noise-flac-segment   # renders the chain first
//   node engine/spikes/splice/station-sketch.ts
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, ffmpeg, mono, SAMPLE_RATE } from '../../tests/splice/audio.ts';
import { joins, makePlan } from '../../tests/splice/island.ts';
import { compareJoins, findLag, trackAlignment } from '../../tests/splice/seam-detector.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const work = join(repo, 'engine/tests/splice/.work');
const chainDir = join(work, 'noise-flac-segment');

for (const [name, seed] of [
  ['z', 4],
  ['c', 5],
] as const) {
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `anoisesrc=color=pink:seed=${seed}:amplitude=0.2:sample_rate=${SAMPLE_RATE}:duration=10`,
    '-af',
    'aformat=channel_layouts=stereo',
    '-c:a',
    'flac',
    '-sample_fmt',
    's32',
    join(work, 'material', `sketch-${name}.flac`),
  ]);
}
const chain = readFileSync(join(chainDir, 'playlist.m3u'), 'utf8').trim().split('\n');
const playlist = [
  '/work/material/sketch-z.flac',
  chain.join(' | '),
  '/work/material/sketch-c.flac',
].join('\n');
writeFileSync(join(work, 'sketch.m3u'), `${playlist}\n`);

const res = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '-v',
    `${work}:/work`,
    '-v',
    `${join(here, 'station-sketch.liq')}:/sketch.liq:ro`,
    '-e',
    'SPLICE_PLAYLIST=/work/sketch.m3u',
    '-e',
    'SPLICE_OUT=/work/sketch.wav',
    'savonet/liquidsoap:v2.4.6',
    '/sketch.liq',
  ],
  { encoding: 'utf8' },
);
writeFileSync(join(work, 'sketch.log'), res.stdout + res.stderr);
if (res.status !== 0) throw new Error(res.stdout + res.stderr);
console.log(
  res.stdout
    .split('\n')
    .filter((l) => /station:|Analysis/.test(l))
    .join('\n'),
);

const y = mono(decode(join(work, 'sketch.wav')));
const ref = mono(decode(join(chainDir, 'reference.wav')));
// Z lasts 10 s and the crossfade overlaps 3 s, so the chain starts around 7 s in.
const probe = 200_000;
const start = findLag(y, ref, probe, 2048, 60_000, sec(7)).lag;
console.log(`output ${y.length} samples; chain starts at output sample ${start}`);
const inner = y.subarray(start);
// Skip the crossfaded head and tail of the chain; check everything in between.
const head = sec(3.5);
const tail = sec(3.5);
const plan = makePlan({ splice: 'butt', grid: { size: 1024, offset: 0 } });
const reports = compareJoins(inner, ref, joins(plan, 'butt'));
for (const r of reports) {
  console.log(
    `${r.label}: shift ${r.shift}, residual ${r.residualDb.toFixed(1)} dB (floor ${r.baselineDb.toFixed(1)} dB)`,
  );
}
const aligned = trackAlignment(
  inner.subarray(head, ref.length - tail),
  ref.subarray(head, ref.length - tail),
);
console.log(
  `alignment inside the chain: ${aligned.points.length} points, ${aligned.events.length} events`,
);
for (const e of aligned.events) console.log(`  ${e.kind} @${e.offset + head}: ${e.detail}`);

function sec(s: number) {
  return Math.round(s * SAMPLE_RATE);
}
