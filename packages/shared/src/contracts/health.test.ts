import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './health.ts';

describe('healthResponseSchema', () => {
  it('accepts a valid payload', () => {
    expect(healthResponseSchema.parse({ status: 'ok', service: 'api' })).toEqual({
      status: 'ok',
      service: 'api',
    });
  });

  it('rejects an unknown service', () => {
    expect(healthResponseSchema.safeParse({ status: 'ok', service: 'nope' }).success).toBe(false);
  });
});
