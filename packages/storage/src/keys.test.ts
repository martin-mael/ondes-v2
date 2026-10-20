import { describe, expect, it } from 'vitest';
import { contentKey, orgPrefix, parseContentKey } from './keys.ts';

const hash = 'a'.repeat(64);

describe('contentKey', () => {
  it('builds org/<orgId>/sha256/<hash>.<ext>', () => {
    expect(contentKey({ orgId: 'org_1', sha256: hash, ext: 'flac' })).toBe(
      `org/org_1/sha256/${hash}.flac`,
    );
  });

  it('normalises the hash and extension', () => {
    expect(contentKey({ orgId: 'o', sha256: hash.toUpperCase(), ext: '.FLAC' })).toBe(
      `org/o/sha256/${hash}.flac`,
    );
  });

  it.each([
    { orgId: '../etc', sha256: hash, ext: 'flac' },
    { orgId: 'o', sha256: 'abc', ext: 'flac' },
    { orgId: 'o', sha256: hash, ext: 'fl/ac' },
    { orgId: 'o', sha256: hash, ext: '' },
  ])('rejects unsafe parts %o', (parts) => {
    expect(() => contentKey(parts)).toThrow();
  });

  it('round-trips through parseContentKey', () => {
    const parts = { orgId: '3f2c-uuid', sha256: hash, ext: 'mp3' };
    expect(parseContentKey(contentKey(parts))).toEqual(parts);
    expect(parseContentKey('org/o/peaks/x.json')).toBeNull();
  });

  it('exposes the org prefix', () => {
    expect(orgPrefix('o')).toBe('org/o/');
  });
});
