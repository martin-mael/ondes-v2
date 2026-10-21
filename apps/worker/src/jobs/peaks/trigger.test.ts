import type { JobPublisher } from '@ondes/queue';
import type { RealtimeEvent } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { peaksTrigger } from './trigger.ts';

const ids = {
  org: '0199f6a0-0000-7000-8000-000000000001',
  station: '0199f6a0-0000-7000-8000-000000000002',
  asset: '0199f6a0-0000-7000-8000-000000000003',
  upload: '0199f6a0-0000-7000-8000-000000000004',
};
const file = (sha: string) => ({
  fileId: '0199f6a0-0000-7000-8000-000000000005',
  storageKey: `org/${ids.org}/sha256/${sha}.flac`,
  sha256: sha,
  sizeBytes: 1000,
  codec: 'flac',
  sampleRate: 44100,
  channels: 2,
  durationSamples: 44100,
  flacBlockSize: 1024,
});

function recorder() {
  const calls: { name: string; payload: unknown; options: unknown }[] = [];
  const jobs: JobPublisher = {
    async enqueue(job, payload, options) {
      calls.push({ name: job.name, payload, options });
      return {} as Awaited<ReturnType<JobPublisher['enqueue']>>;
    },
    close: async () => {},
  };
  return { jobs, calls };
}

describe('peaksTrigger', () => {
  it('enqueues a keyed peaks job for each ingested asset', async () => {
    const { jobs, calls } = recorder();
    const event = {
      id: '0199f6a0-0000-7000-8000-000000000006',
      stationId: ids.station,
      at: new Date().toISOString(),
      type: 'asset.ingested',
      data: {
        orgId: ids.org,
        assetId: ids.asset,
        uploadId: ids.upload,
        master: file('b'.repeat(64)),
        playout: file('a'.repeat(64)),
      },
    } as RealtimeEvent;
    await peaksTrigger.onEvent(event, jobs);
    expect(calls).toEqual([
      {
        name: 'peaks',
        payload: {
          orgId: ids.org,
          stationId: ids.station,
          assetId: ids.asset,
          playoutSha256: 'a'.repeat(64),
        },
        options: {
          idempotencyKey: `peaks:${ids.asset}:${'a'.repeat(64)}:v1`,
          orgId: ids.org,
          stationId: ids.station,
        },
      },
    ]);
  });

  it('ignores other events', async () => {
    const { jobs, calls } = recorder();
    await peaksTrigger.onEvent(
      { type: 'upload.updated', stationId: ids.station } as RealtimeEvent,
      jobs,
    );
    expect(calls).toEqual([]);
  });
});
