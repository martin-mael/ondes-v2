// Spike probe: how does Liquidsoap turn `liq_cue_in` / `liq_cue_out` seconds into samples?
//
// Plays a FLAC noise file (1024-sample blocks, from seek-probe.ts) with cue points at and
// around exact sample positions, and reports where the output starts and ends in the source.
//
//   node engine/spikes/splice/seek-probe.ts --formats flac-1024   # creates the file
//   node engine/spikes/splice/cue-rounding-probe.ts
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, SAMPLE_RATE } from '../../tests/splice/audio.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const work = join(repo, 'engine/tests/splice/.work/seek-probe');
const src = decode(join(work, 'noise-flac-1024.flac')).channels[0] ?? new Float32Array();

// [cue-in, cue-out] in (fractional) samples; cue-in 0 means no cue-in at all.
const cases: [number, number][] = [
  [4096, 26146],
  [4096, 26146.25],
  [4096, 26146.5],
  [4096, 26145.75],
  [4096.25, 26146],
  [4095.75, 26146],
  [4095.5, 26145.5],
  [0, 22050],
  [0, 22050.25],
  [0, 22050.5],
  [0, 22049.75],
  [0, 22049.5],
];

for (const [ci, co] of cases) {
  const s = (n: number) => (n / SAMPLE_RATE).toFixed(12);
  const line = `annotate:${ci ? `liq_cue_in="${s(ci)}",` : ''}liq_cue_out="${s(co)}":/work/noise-flac-1024.flac`;
  writeFileSync(join(work, 'probe.m3u'), `${line}\n`);
  const res = spawnSync('docker', [
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
    'savonet/liquidsoap:v2.4.6',
    '/splice.liq',
  ]);
  if (res.status !== 0) throw new Error(String(res.stdout) + String(res.stderr));
  const y = decode(join(work, 'probe.wav')).channels[0] ?? new Float32Array();
  let start = -1;
  for (let s0 = 0; s0 < 10_000 && start < 0; s0++) {
    let ok = true;
    for (let i = 0; i < 32 && ok; i++) ok = Math.abs((y[i] ?? 0) - (src[s0 + i] ?? 0)) < 1e-5;
    if (ok) start = s0;
  }
  console.log(
    `cue_in ${String(ci || '-').padStart(7)}  cue_out ${String(co).padStart(8)}  →  plays [${start}, ${start + y.length})  (${y.length} samples)`,
  );
}
