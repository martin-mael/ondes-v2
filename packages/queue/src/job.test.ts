import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineJob } from './job.ts';
import { jobType } from './publisher.ts';

describe('defineJob', () => {
  it('defaults to the bulk lane', () => {
    const job = defineJob('peaks', z.object({ trackId: z.string() }), () => {});
    expect(job.lane).toBe('bulk');
    expect(jobType('peaks', z.object({})).lane).toBe('bulk');
  });

  it('requires kebab-case names', () => {
    expect(() => defineJob('LogGenerate', z.object({}), () => {})).toThrow(/kebab-case/);
    expect(() => defineJob('log-generate', z.object({}), () => {})).not.toThrow();
  });
});
