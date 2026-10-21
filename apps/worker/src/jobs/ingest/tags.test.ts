import { describe, expect, it } from 'vitest';
import type { ProbeResult, ProbeStream } from './ffmpeg.ts';
import { readTags, titleFromFilename } from './tags.ts';

const stream: ProbeStream = { index: 0, codec_type: 'audio', codec_name: 'mp3' };
const probe = (tags: Record<string, string>, streamTags?: Record<string, string>) => ({
  probe: { streams: [{ ...stream, tags: streamTags }], format: { tags } } as ProbeResult,
  stream: { ...stream, tags: streamTags },
});

describe('readTags', () => {
  it('maps ID3 tags (as ffprobe names them) to the asset', () => {
    const { probe: p, stream: s } = probe({
      title: 'Mistral',
      artist: 'Ana; Bo ;ana',
      album: 'Vents',
      date: '2019-04-02',
      genre: 'Jazz;Soul',
      TSRC: 'FR-Z03-14-00123',
      composer: 'C. Doe',
      publisher: 'Pub',
      comment: 'hello',
    });
    expect(readTags(p, s, 'x.mp3')).toEqual({
      asset: {
        title: 'Mistral',
        artists: ['Ana', 'Bo'],
        album: 'Vents',
        year: 2019,
        isrc: 'FRZ031400123',
        metadata: { composer: 'C. Doe', publisher: 'Pub', comment: 'hello' },
        sourceFilename: 'x.mp3',
      },
      tags: [
        { key: 'genre', value: 'Jazz' },
        { key: 'genre', value: 'Soul' },
      ],
    });
  });

  it('reads Vorbis comments from the stream (Ogg) with any key case', () => {
    const { probe: p, stream: s } = probe({}, { TITLE: 'Nuit', ARTIST: 'Cé', ORGANIZATION: 'Lab' });
    const { asset } = readTags(p, s, 'nuit.ogg');
    expect(asset).toMatchObject({ title: 'Nuit', artists: ['Cé'], metadata: { label: 'Lab' } });
  });

  it('falls back to the file name and drops invalid values', () => {
    const { probe: p, stream: s } = probe({ isrc: 'nope', date: 'someday' });
    expect(readTags(p, s, 'dir/02 - Le Vent.flac').asset).toMatchObject({
      title: '02 - Le Vent',
      artists: [],
      album: null,
      year: null,
      isrc: null,
    });
  });
});

describe('titleFromFilename', () => {
  it('strips the extension and the folders', () => {
    expect(titleFromFilename('a/b/Song.final.wav')).toBe('Song.final');
    expect(titleFromFilename('.wav')).toBe('.wav');
  });
});
