import { type AssetMetadata, type CreateAsset, isrcSchema, type TagKey } from '@ondes/shared';
import type { ProbeResult, ProbeStream } from './ffmpeg.ts';

// File tags → asset fields. ffprobe reads ID3v1/v2 (MP3, AIFF, WAV `id3 ` chunks), Vorbis
// comments (FLAC, Ogg, Opus), RIFF INFO and MP4 atoms into one key/value list; keys differ in
// case between formats, so they're matched lower-cased. ffmpeg joins repeated Vorbis fields
// (two ARTIST lines) with ";".

export interface ReadTags {
  asset: Pick<
    CreateAsset,
    'title' | 'artists' | 'album' | 'year' | 'isrc' | 'metadata' | 'sourceFilename'
  >;
  tags: { key: TagKey; value: string }[];
}

const MAX_TEXT = 500;

function clean(value: string | undefined, max = MAX_TEXT): string | undefined {
  const text = value?.replace(/\0/g, '').trim();
  return text ? text.slice(0, max) : undefined;
}

function split(value: string | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of value.split(';')) {
    const part = clean(raw);
    if (part && !seen.has(part.toLowerCase())) {
      seen.add(part.toLowerCase());
      parts.push(part);
    }
  }
  return parts;
}

/** Title fallback: the file name without its extension. */
export function titleFromFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  return clean(base.replace(/\.[^.]+$/, '')) ?? clean(base) ?? 'Untitled';
}

export function readTags(probe: ProbeResult, stream: ProbeStream, filename: string): ReadTags {
  const all: Record<string, string> = {};
  // Stream tags first (Ogg keeps Vorbis comments there), container tags win.
  for (const source of [stream.tags, probe.format?.tags]) {
    for (const [key, value] of Object.entries(source ?? {})) all[key.toLowerCase()] = value;
  }
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = clean(all[key]);
      if (value) return value;
    }
    return undefined;
  };

  const yearText = pick('date', 'year', 'tdrc', 'tyer', 'originaldate', 'icrd');
  const yearMatch = yearText?.match(/\b(\d{4})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;
  const isrc = isrcSchema.safeParse(pick('isrc', 'tsrc') ?? '');

  const metadata: AssetMetadata = {};
  const composer = pick('composer', 'tcom');
  const label = pick('label', 'organization', 'tpub_label');
  const publisher = pick('publisher', 'tpub');
  const comment = clean(all.comment ?? all.description ?? all.icmt, 5000);
  if (composer) metadata.composer = composer;
  if (label) metadata.label = label;
  if (publisher) metadata.publisher = publisher;
  if (comment) metadata.comment = comment;

  const tags = split(pick('genre', 'tcon', 'ignr'))
    .slice(0, 20)
    .map((value) => ({ key: 'genre' as const, value: value.slice(0, 200) }));

  return {
    asset: {
      title: pick('title', 'tit2', 'inam') ?? titleFromFilename(filename),
      artists: split(pick('artist', 'artists', 'tpe1', 'iart', 'album_artist')).slice(0, 50),
      album: pick('album', 'talb', 'iprd') ?? null,
      year: year !== undefined && year >= 1000 && year <= 9999 ? year : null,
      isrc: isrc.success ? isrc.data : null,
      metadata,
      sourceFilename: filename.slice(0, 1000),
    },
    tags,
  };
}
