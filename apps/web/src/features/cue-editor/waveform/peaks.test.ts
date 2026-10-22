import { encodePeaks } from '@ondes/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../app/api/client.ts';
import { fetchPeaks, peaksQuery } from './peaks.ts';

// Fetching peaks: the versioned URL, decoding, and the errors (404 while none exist, not
// retried; other statuses and network failures).

const bytes = encodePeaks({
  sampleRate: 44_100,
  channels: 1,
  lengthSamples: 4096,
  levels: [{ samplesPerPoint: 4096, points: 1, values: new Int8Array([-3, 4]) }],
});

function stubFetch(reply: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => reply());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchPeaks', () => {
  it('fetches the versioned file and decodes it', async () => {
    const fetchMock = stubFetch(() => new Response(new Blob([bytes.slice()])));
    const peaks = await fetchPeaks('st/1', 'a 1', 'f'.repeat(64));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `/api/v1/stations/st%2F1/assets/a%201/peaks?v=${'f'.repeat(64)}`,
    );
    expect(peaks.lengthSamples).toBe(4096);
    expect(Array.from(peaks.levels[0]?.values ?? [])).toEqual([-3, 4]);
  });

  it('maps a 404 to not_found, and does not retry it', async () => {
    stubFetch(() => new Response(null, { status: 404 }));
    const error = await fetchPeaks('s', 'a').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: 'not_found' });
    const retry = peaksQuery('s', 'a').retry as (count: number, error: unknown) => boolean;
    expect(retry(0, error)).toBe(false);
    expect(retry(0, new ApiError(500, 'http_error', 'boom'))).toBe(true);
    expect(retry(2, new ApiError(500, 'http_error', 'boom'))).toBe(false);
  });

  it('maps other statuses and network failures', async () => {
    stubFetch(() => new Response(null, { status: 503 }));
    await expect(fetchPeaks('s', 'a')).rejects.toMatchObject({ status: 503, code: 'http_error' });
    stubFetch(() => Promise.reject(new TypeError('offline')));
    await expect(fetchPeaks('s', 'a')).rejects.toMatchObject({ status: 0, code: 'network' });
  });
});
