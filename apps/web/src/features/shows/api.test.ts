import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadEpisodeAudio } from './api.ts';

// The episode upload's wait on ingest: capped, and stopped by its signal.

const stationId = '01a15ddf-0000-7000-8000-0000000000b1';
const showId = '01a15ddf-0000-7000-8000-0000000005a1';
const uploadId = '01a15ddf-0000-7000-8000-0000000005d1';
const at = '2026-10-20T08:00:00.000Z';

const upload = (status: string) => ({
  id: uploadId,
  orgId: '01a15ddf-0000-7000-8000-0000000000a1',
  stationId,
  status,
  filename: 'ep.wav',
  sizeBytes: 4,
  contentType: 'audio/wav',
  assetType: 'episode',
  partSize: 16 * 1024 * 1024,
  partCount: 1,
  sha256: null,
  assetId: null,
  duplicateOfAssetId: null,
  errorCode: null,
  error: null,
  createdAt: at,
  updatedAt: at,
});

/** An api where ingest never finishes; counts the status reads. */
function stuckApi() {
  const reads = { count: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      const path = new URL(input, 'http://app.test').pathname;
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (path.endsWith('/parts')) {
        return json({ parts: [{ partNumber: 1, url: 'http://s3.test/p1' }], expiresIn: 900 });
      }
      if (path === '/p1') return new Response(null, { status: 200 });
      if (path.endsWith('/complete')) return json(upload('queued'), 202);
      if (path.endsWith(`/uploads/${uploadId}`)) {
        reads.count += 1;
        return json(upload('processing'));
      }
      return json(upload('uploading'), 201);
    }),
  );
  return reads;
}

const file = () => new File(['RIFF'], 'ep.wav', { type: 'audio/wav' });

afterEach(() => vi.unstubAllGlobals());

describe('uploadEpisodeAudio', () => {
  it('gives up waiting for ingest after the cap: still processing', async () => {
    const reads = stuckApi();
    await expect(
      uploadEpisodeAudio(stationId, showId, file(), () => {}, {
        pollMs: 5,
        processingTimeoutMs: 40,
      }),
    ).rejects.toMatchObject({ code: 'still_processing' });
    expect(reads.count).toBeGreaterThan(1);
  });

  it('reads the status again as soon as it is woken up', async () => {
    const reads = stuckApi();
    const controller = new AbortController();
    const waits: number[] = [];
    const run = uploadEpisodeAudio(stationId, showId, file(), () => {}, {
      signal: controller.signal,
      pollMs: 60_000,
      waitForChange: async (_id, ms) => {
        waits.push(ms);
        if (waits.length === 3) controller.abort();
      },
    });
    await expect(run).rejects.toBeDefined();
    expect(waits.every((ms) => ms <= 60_000)).toBe(true);
    // Woken right away each time: no 60 s poll in between.
    expect(reads.count).toBe(3);
  });
});
