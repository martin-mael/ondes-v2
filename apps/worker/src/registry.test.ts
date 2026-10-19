import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discoverJobs } from './registry.ts';

const fixture = (path: string) => fileURLToPath(new URL(`./__fixtures__/${path}`, import.meta.url));

describe('discoverJobs', () => {
  it('loads the default export of every jobs/<job>/index.ts', async () => {
    const jobs = await discoverJobs(fixture('jobs'));
    expect(jobs.map((job) => [job.name, job.lane])).toEqual([['hello', 'high']]);
  });

  it('rejects a job whose name differs from its folder', async () => {
    await expect(discoverJobs(fixture('bad-name/jobs'))).rejects.toThrow(/must match its folder/);
  });

  it('accepts the real jobs folder', async () => {
    await expect(
      discoverJobs(fileURLToPath(new URL('./jobs/', import.meta.url))),
    ).resolves.toBeInstanceOf(Array);
  });
});
