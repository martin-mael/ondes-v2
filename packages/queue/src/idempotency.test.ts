import { describe, expect, it } from 'vitest';
import { defaultIdempotencyKey, stableStringify } from './idempotency.ts';

describe('idempotency keys', () => {
  it('ignores object key order, at any depth', () => {
    expect(stableStringify({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: 3 } })).toBe(
      '{"a":{"c":3,"d":[2,{"x":2,"y":1}]},"b":1}',
    );
    expect(defaultIdempotencyKey('ingest', { a: 1, b: 2 })).toBe(
      defaultIdempotencyKey('ingest', { b: 2, a: 1 }),
    );
  });

  it('differs by job name and payload', () => {
    const key = defaultIdempotencyKey('ingest', { a: 1 });
    expect(key).toMatch(/^ingest:[0-9a-f]{64}$/);
    expect(defaultIdempotencyKey('peaks', { a: 1 })).not.toBe(key);
    expect(defaultIdempotencyKey('ingest', { a: 2 })).not.toBe(key);
  });
});
