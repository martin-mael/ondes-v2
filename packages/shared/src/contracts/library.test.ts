import { describe, expect, it } from 'vitest';
import {
  createAssetFileSchema,
  createAssetSchema,
  isrcSchema,
  listAssetsQuerySchema,
  musicalKeySchema,
  PLAYOUT_FLAC_BLOCK_SIZE,
  PLAYOUT_SAMPLE_RATE,
  samplesToSeconds,
  updateAssetSchema,
  updateCuesSchema,
} from './library.ts';

const sha256 = 'a'.repeat(64);

describe('library contracts', () => {
  it('normalizes ISRCs', () => {
    expect(isrcSchema.parse('fr-z03-14-00123')).toBe('FRZ031400123');
    expect(isrcSchema.safeParse('FRZ0314').success).toBe(false);
  });

  it('requires killAt after startAt', () => {
    const base = { type: 'song', title: 'x' } as const;
    expect(
      createAssetSchema.safeParse({
        ...base,
        startAt: '2026-10-25T00:00:00+02:00',
        killAt: '2026-10-25T01:00:00+01:00',
      }).success,
    ).toBe(true);
    expect(
      createAssetSchema.safeParse({
        ...base,
        startAt: '2026-10-25T02:00:00Z',
        killAt: '2026-10-25T01:00:00Z',
      }).success,
    ).toBe(false);
    expect(updateAssetSchema.safeParse({}).success).toBe(false);
    expect(updateAssetSchema.safeParse({ durationMs: 10 }).success).toBe(false);
  });

  it('only accepts FLAC playout copies with a block size (spike #12)', () => {
    const playout = {
      role: 'playout',
      storageKey: 'org/o/sha256/x.flac',
      sha256,
      sizeBytes: 10,
      codec: 'flac',
      sampleRate: PLAYOUT_SAMPLE_RATE,
      flacBlockSize: PLAYOUT_FLAC_BLOCK_SIZE,
    } as const;
    expect(createAssetFileSchema.safeParse(playout).success).toBe(true);
    expect(createAssetFileSchema.safeParse({ ...playout, codec: 'mp3' }).success).toBe(false);
    expect(createAssetFileSchema.safeParse({ ...playout, flacBlockSize: null }).success).toBe(
      false,
    );
    expect(
      createAssetFileSchema.safeParse({ ...playout, role: 'master', codec: 'pcm_s24le' }).success,
    ).toBe(true);
  });

  it('takes cue positions as whole samples', () => {
    expect(updateCuesSchema.safeParse({ cueIn: { samples: 1024 } }).success).toBe(true);
    expect(updateCuesSchema.safeParse({ cueIn: { samples: 10.5 } }).success).toBe(false);
    expect(updateCuesSchema.safeParse({ cueIn: {} }).success).toBe(false);
    expect(updateCuesSchema.safeParse({ sampleRate: 44_100 }).success).toBe(false);
    expect(samplesToSeconds(88_200, 44_100)).toBe(2);
  });

  it('parses list queries from the query string', () => {
    expect(listAssetsQuerySchema.parse({ tag: 'genre:hip:hop', limit: '20' })).toEqual({
      tag: { key: 'genre', value: 'hip:hop' },
      limit: 20,
    });
    expect(listAssetsQuerySchema.safeParse({ tag: 'colour:red' }).success).toBe(false);
    expect(listAssetsQuerySchema.parse({}).limit).toBe(50);
  });

  it('validates musical keys', () => {
    for (const key of ['C', 'F#m', 'Bbm'])
      expect(musicalKeySchema.safeParse(key).success).toBe(true);
    expect(musicalKeySchema.safeParse('H').success).toBe(false);
  });
});
