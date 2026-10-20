// The hour played before the hard start: 14 music tracks in the formats a station meets
// (FLAC playout copies, plus MP3, AAC, 48 kHz FLAC and WAV to expose decoder effects), with
// autocue-style cue points on some and natural ends on others, and crossfades from 0 to 6 s.
// Then the episode, which must start at T. Shared by fixtures.ts and spike.ts.

export type Format = 'flac' | 'flac48' | 'mp3' | 'm4a' | 'wav';

export type Track = {
  id: string;
  format: Format;
  /** Length of the generated file, seconds. */
  length: number;
  /** Two tones per track, so every track sounds (and correlates) differently. */
  hz: [number, number];
  cueIn?: number;
  /** Unset = the track plays to its natural (decoded) end. */
  cueOut?: number;
  /** Planned overlap with the next item = cross_out of this one = cross_in of the next. */
  cross: number;
};

export const MUSIC: Track[] = [
  { id: 'm01', format: 'flac', length: 245, hz: [220, 277], cueIn: 0.6, cueOut: 241.2, cross: 3 },
  { id: 'm02', format: 'mp3', length: 212, hz: [247, 311], cross: 2 },
  { id: 'm03', format: 'flac', length: 287, hz: [262, 330], cueIn: 1.2, cueOut: 282.5, cross: 4 },
  { id: 'm04', format: 'flac48', length: 198, hz: [294, 370], cross: 0 },
  { id: 'm05', format: 'flac', length: 333, hz: [196, 247], cueIn: 0.3, cueOut: 330, cross: 5 },
  { id: 'm06', format: 'm4a', length: 224, hz: [330, 415], cross: 2 },
  { id: 'm07', format: 'flac', length: 256, hz: [175, 220], cueOut: 251.7, cross: 3 },
  { id: 'm08', format: 'wav', length: 181, hz: [349, 440], cross: 1 },
  { id: 'm09', format: 'mp3', length: 302, hz: [208, 262], cueIn: 0.8, cueOut: 299, cross: 3 },
  { id: 'm10', format: 'flac', length: 264, hz: [233, 294], cross: 6 },
  { id: 'm11', format: 'flac', length: 219, hz: [185, 233], cueIn: 0.4, cueOut: 215.3, cross: 2 },
  { id: 'm12', format: 'flac', length: 276, hz: [311, 392], cueIn: 1, cueOut: 270, cross: 3 },
  { id: 'm13', format: 'flac', length: 241, hz: [165, 208], cueIn: 0.5, cueOut: 237.9, cross: 2 },
  // The last song: back-timing gave it a cue-out 60 s before its end, so a re-plan can
  // lengthen it by up to 59 s or shorten it.
  { id: 'm14', format: 'flac', length: 300, hz: [277, 349], cueIn: 0.5, cueOut: 240, cross: 2 },
];

/** The pre-recorded episode: seeded white noise, so its start can be found to the sample. */
export const EPISODE = { id: 'episode', length: 240, seed: 1234, crossIn: 2 };

/** Filler bed for running early: a soft pad, long enough to cover any gap. */
export const BED = { id: 'bed', length: 300, hz: [110, 165] as [number, number] };

export const SAMPLE_RATE = 44100;

export function extension(format: Format): string {
  return format === 'flac48' ? 'flac' : format;
}

export function fileName(id: string, format: Format): string {
  return `${id}.${extension(format)}`;
}
