import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createS3Storage, loadStorageConfig } from '@ondes/storage';
import { audioStream, defaultTools, ffprobe, run, transcodePlayout } from '../ingest/ffmpeg.ts';
import { joinParts } from './join.ts';

// Live recording build benchmark (#67, ADR 0039 "Measurements"): times the steps a build
// runs on `hours` of stereo pink noise (which compresses like a real mix, unlike a sine) in
// `parts` engine-like FLAC files:
//   node apps/worker/src/jobs/live-recording/bench.ts [hours=2] [parts=3]
// Uses ffmpeg from PATH (prefix PATH=$PWD/apps/worker/test/bin:$PATH for the worker image's).
// With S3_ENDPOINT set (`. ./.env.example`), also times the bucket traffic of a build on the
// dev Garage: the staging put, ingest's download, the master and playout puts. Prints a JSON
// line per step and a summary. Not a test: run by hand, its output goes in the ADR.

const hours = Number(process.argv[2] ?? 2);
const parts = Number(process.argv[3] ?? 3);
const tools = defaultTools();
const work = await mkdtemp(join(tmpdir(), 'ondes-live-rec-bench-'));
const timings: Record<string, number> = {};

async function timed<T>(step: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const result = await fn();
  timings[step] = Math.round(performance.now() - t0);
  console.log(JSON.stringify({ step, ms: timings[step] }));
  return result;
}

try {
  const seconds = (hours * 3600) / parts;
  const files: string[] = [];
  for (let i = 0; i < parts; i++) {
    const file = join(work, `live-bench-${i + 1}.flac`);
    // As the engine writes them: 44.1 kHz, 16-bit, stereo, compression 5.
    await run(
      tools.ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `anoisesrc=color=pink:sample_rate=44100:amplitude=0.3:duration=${seconds}:seed=${i + 1}`,
        '-ac',
        '2',
        '-c:a',
        'flac',
        '-sample_fmt',
        's16',
        '-compression_level',
        '5',
        file,
      ],
      { timeoutMs: 600_000 },
    );
    files.push(file);
  }
  const joined = join(work, 'joined.flac');
  await timed('join', () =>
    joinParts(tools, files, joined, { work, expectedSeconds: hours * 3600, tags: {} }),
  );
  const size = (await stat(joined)).size;
  const probe = await ffprobe(tools, joined);
  const stream = audioStream(probe);
  if (!stream) throw new Error('no audio stream');
  const playout = join(work, 'playout.flac');
  await timed('playout copy', () => transcodePlayout(tools, joined, playout, stream));
  await timed('decode (peaks, loudness, autocue each)', () =>
    run(tools.ffmpeg, ['-nostdin', '-v', 'error', '-i', playout, '-f', 'null', '-'], {
      timeoutMs: 600_000,
    }),
  );

  if (process.env.S3_ENDPOINT) {
    const storage = createS3Storage(loadStorageConfig());
    const key = (name: string) => `bench/live-recording-${process.pid}/${name}`;
    const playoutSize = (await stat(playout)).size;
    await timed('s3: staging put', () =>
      storage.put(key('staging'), createReadStream(joined), { contentLength: size }),
    );
    await timed('s3: ingest download', async () => {
      const { body } = await storage.get(key('staging'));
      await pipeline(body, createWriteStream(join(work, 'downloaded.flac')));
    });
    await timed('s3: master put', () =>
      storage.put(key('master'), createReadStream(joined), { contentLength: size }),
    );
    await timed('s3: playout put', () =>
      storage.put(key('playout'), createReadStream(playout), { contentLength: playoutSize }),
    );
    for (const name of ['staging', 'master', 'playout']) await storage.delete(key(name));
  }

  const total = Object.values(timings).reduce((a, b) => a + b, 0);
  console.log(
    JSON.stringify({
      msg: 'live recording build benchmark',
      hours,
      parts,
      joinedBytes: size,
      totalMs: total,
      msPerAudioHour: Math.round(total / hours),
      timings,
    }),
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
