import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run, type Tools } from '../ingest/ffmpeg.ts';

// Joining a recording's parts (#67, ADR 0039): the engine's FLAC files, in air order, decoded
// and re-encoded as one FLAC. Every part has the same format (the template's `%flac`, 44.1 kHz
// 16-bit stereo) and the files were cut on frame boundaries of one continuous mix, so the
// join is sample-continuous: a handover inside a show sounds as it aired.
//
// Re-encoding (rather than copying FLAC frames) also repairs a part the engine never closed
// (an engine restart): its STREAMINFO has no length, and its last frame may be cut short.
// FLAC encodes at several hundred times real time, so it costs seconds per hour of audio.

/** Engine file names (`live-<boot>-<n>.flac`): anything else is refused, never opened. */
export const PART_FILE = /^live-[A-Za-z0-9-]+-\d+\.flac$/;

export const isPartFile = (name: string) => PART_FILE.test(name);

/** ffmpeg's concat list syntax: one `file '<path>'` per line, quotes escaped. */
export function concatList(paths: readonly string[]): string {
  return `${paths.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join('\n')}\n`;
}

export type JoinTags = { title?: string | null; artist?: string | null; date?: string | null };

/** Generous: decoding and encoding run far faster than real time. */
export const joinTimeoutMs = (seconds: number) => 120_000 + Math.ceil(seconds) * 200;

/**
 * Joins `paths` (absolute, in order) into `out` (FLAC, 16-bit), with `tags` as Vorbis comments
 * (ingest reads them into the asset). `expectedSeconds` only sizes the timeout.
 */
export async function joinParts(
  tools: Tools,
  paths: readonly string[],
  out: string,
  options: { work: string; tags: JoinTags; expectedSeconds: number; signal?: AbortSignal },
): Promise<void> {
  const list = join(options.work, 'parts.txt');
  await writeFile(list, concatList(paths));
  const metadata = Object.entries(options.tags).flatMap(([k, v]) =>
    v ? ['-metadata', `${k}=${v}`] : [],
  );
  await run(
    tools.ffmpeg,
    [
      '-nostdin',
      '-hide_banner',
      '-v',
      'error',
      // Only local files, and only the concat list's own demuxer for the list itself.
      '-protocol_whitelist',
      'file',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-map',
      '0:a:0',
      '-map_metadata',
      '-1',
      ...metadata,
      '-c:a',
      'flac',
      '-sample_fmt',
      's16',
      '-compression_level',
      '5',
      '-y',
      out,
    ],
    { signal: options.signal, timeoutMs: joinTimeoutMs(options.expectedSeconds) },
  );
}
