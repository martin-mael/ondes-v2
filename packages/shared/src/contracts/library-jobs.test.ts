import { describe, expect, it } from 'vitest';
import { realtimeEventSchema } from './events.ts';
import {
  createUploadSchema,
  DEFAULT_UPLOAD_PART_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_PARTS,
  MIN_UPLOAD_PART_BYTES,
  uploadPartCount,
  uploadPartSize,
} from './library-jobs.ts';

const uuid = '0199f6a0-0000-7000-8000-00000000000a';
const file = {
  fileId: uuid,
  storageKey: `org/${uuid}/sha256/${'a'.repeat(64)}.flac`,
  sha256: 'a'.repeat(64),
  sizeBytes: 10,
  codec: 'flac',
  sampleRate: 44_100,
  channels: 2,
  durationSamples: 1000,
  flacBlockSize: 1024,
};

describe('upload parts', () => {
  it('uses the default part size for usual files', () => {
    expect(uploadPartSize(100 * 1024 ** 2)).toBe(DEFAULT_UPLOAD_PART_BYTES);
    expect(uploadPartCount(100 * 1024 ** 2, DEFAULT_UPLOAD_PART_BYTES)).toBe(7);
    expect(uploadPartCount(1, DEFAULT_UPLOAD_PART_BYTES)).toBe(1);
  });

  it('keeps every file within 10,000 parts of at least 5 MiB', () => {
    for (const bytes of [MAX_UPLOAD_BYTES, 500 * 1024 ** 3]) {
      const size = uploadPartSize(bytes);
      expect(size).toBeGreaterThanOrEqual(MIN_UPLOAD_PART_BYTES);
      expect(uploadPartCount(bytes, size)).toBeLessThanOrEqual(MAX_UPLOAD_PARTS);
    }
  });

  it('defaults the asset type and bounds the size', () => {
    expect(createUploadSchema.parse({ filename: 'a.mp3', sizeBytes: 1 }).assetType).toBe('song');
    expect(() =>
      createUploadSchema.parse({ filename: 'a.mp3', sizeBytes: MAX_UPLOAD_BYTES + 1 }),
    ).toThrow();
  });
});

describe('library events', () => {
  it('accepts asset.ingested and upload.updated', () => {
    const envelope = { id: uuid, stationId: uuid, at: '2026-10-21T08:00:00.000Z' };
    const ingested = {
      ...envelope,
      type: 'asset.ingested',
      data: { orgId: uuid, assetId: uuid, uploadId: uuid, master: file, playout: file },
    };
    expect(realtimeEventSchema.parse(ingested)).toEqual(ingested);
    const updated = {
      ...envelope,
      type: 'upload.updated',
      data: {
        id: uuid,
        status: 'quarantined',
        filename: 'x.mp3',
        assetId: null,
        duplicateOfAssetId: null,
        errorCode: 'probe_failed',
        error: 'Invalid data found when processing input',
      },
    };
    expect(realtimeEventSchema.parse(updated)).toEqual(updated);
  });
});
