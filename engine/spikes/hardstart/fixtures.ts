// Writes the spike's audio with ffmpeg (the fixtures container installs it): the hour of
// music in playlist.ts, the episode, the filler bed, safety and emergency files. Then
// ffprobes every file into catalog.json, the durations ingest would store and Node plans
// with. Usage: node fixtures.ts <dir>. Skips the work if the catalog is already there.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BED, EPISODE, fileName, MUSIC, SAMPLE_RATE, type Track } from './playlist.ts';

const CATALOG_VERSION = 2;

function ffmpeg(args: string[]) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: 'inherit',
  });
}

function probe(path: string): number {
  const out = execFileSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    path,
  ]);
  return Number(out.toString().trim());
}

function tones(hz: [number, number], seconds: number, rate = SAMPLE_RATE): string[] {
  // Two tones with a slow tremolo, a little below -6 dBFS.
  const expr = `0.3*sin(2*PI*${hz[0]}*t)*(0.8+0.2*sin(2*PI*0.25*t))+0.15*sin(2*PI*${hz[1]}*t)`;
  return ['-f', 'lavfi', '-i', `aevalsrc=exprs='${expr}':s=${rate}:d=${seconds}`];
}

function encoder(track: Track): string[] {
  switch (track.format) {
    case 'flac':
      // Spike #12: FLAC playout copies with a fixed 1024-sample block size.
      return ['-ac', '2', '-c:a', 'flac', '-frame_size', '1024'];
    case 'flac48':
      return ['-ac', '2', '-ar', '48000', '-c:a', 'flac', '-frame_size', '1024'];
    case 'mp3':
      return ['-ac', '2', '-c:a', 'libmp3lame', '-b:a', '256k'];
    case 'm4a':
      return ['-ac', '2', '-c:a', 'aac', '-b:a', '256k'];
    case 'wav':
      return ['-ac', '2', '-c:a', 'pcm_s16le'];
  }
}

if (import.meta.main) {
  const dir = process.argv[2] ?? '/media';
  const catalogPath = join(dir, 'catalog.json');
  if (existsSync(catalogPath)) {
    const existing = JSON.parse(readFileSync(catalogPath, 'utf8')) as { version: number };
    if (existing.version === CATALOG_VERSION) {
      console.log(`fixtures already in ${dir}`);
      process.exit(0);
    }
  }
  mkdirSync(join(dir, 'safety'), { recursive: true });
  const durations: Record<string, number> = {};

  for (const track of MUSIC) {
    const name = fileName(track.id, track.format);
    const rate = track.format === 'flac48' ? 48000 : SAMPLE_RATE;
    ffmpeg([...tones(track.hz, track.length, rate), ...encoder(track), join(dir, name)]);
    durations[track.id] = probe(join(dir, name));
    console.log(`${name}: ${durations[track.id]} s`);
  }

  const episode = join(dir, 'episode.flac');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `anoisesrc=d=${EPISODE.length}:c=white:r=${SAMPLE_RATE}:a=0.25:seed=${EPISODE.seed}`,
    '-ac',
    '2',
    '-c:a',
    'flac',
    '-frame_size',
    '1024',
    episode,
  ]);
  durations[EPISODE.id] = probe(episode);
  // The first 10 s as raw mono s16le: the driver's correlation template.
  ffmpeg(['-i', episode, '-t', '10', '-ac', '1', '-f', 's16le', join(dir, 'episode-head.s16')]);

  const bed = join(dir, 'bed.flac');
  ffmpeg([...tones(BED.hz, BED.length), '-ac', '2', '-c:a', 'flac', '-af', 'volume=0.5', bed]);
  durations[BED.id] = probe(bed);

  ffmpeg([...tones([131, 196], 60), '-ac', '2', '-c:a', 'flac', join(dir, 'safety/safety-1.flac')]);
  ffmpeg([...tones([147, 220], 60), '-ac', '2', '-c:a', 'flac', join(dir, 'safety/safety-2.flac')]);
  ffmpeg([...tones([98, 147], 30), '-ac', '2', '-c:a', 'pcm_s16le', join(dir, 'emergency.wav')]);

  writeFileSync(catalogPath, JSON.stringify({ version: CATALOG_VERSION, durations }, null, 2));
  console.log(`fixtures written to ${dir}`);
}
