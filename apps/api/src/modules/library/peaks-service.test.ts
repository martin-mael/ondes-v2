import { type AssetFile, peaksStorageKey } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { currentPeaksFile, etagMatches } from './peaks-service.ts';

const org = '0199f6a0-0000-7000-8000-000000000001';
const file = (role: AssetFile['role'], sha256: string, storageKey: string) =>
  ({ role, sha256, storageKey }) as AssetFile;
const playoutSha = 'a'.repeat(64);

describe('currentPeaksFile', () => {
  it('returns the peaks file computed from the current playout copy', () => {
    const peaks = file('peaks', 'b'.repeat(64), peaksStorageKey(org, playoutSha));
    const playout = file('playout', playoutSha, 'x');
    expect(currentPeaksFile([playout, peaks], org)).toEqual({ peaks, playout });
  });

  it('ignores peaks of a replaced playout copy or an older format', () => {
    const old = file('peaks', 'b'.repeat(64), peaksStorageKey(org, 'c'.repeat(64)));
    expect(currentPeaksFile([file('playout', playoutSha, 'x'), old], org)).toBeUndefined();
    const v0 = file('peaks', 'b'.repeat(64), peaksStorageKey(org, playoutSha, 0));
    expect(currentPeaksFile([file('playout', playoutSha, 'x'), v0], org)).toBeUndefined();
    expect(currentPeaksFile([file('playout', playoutSha, 'x')], org)).toBeUndefined();
  });
});

describe('etagMatches', () => {
  it('matches strong, weak, listed and wildcard tags', () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"x", "abc"', '"abc"')).toBe(true);
    expect(etagMatches('*', '"abc"')).toBe(true);
    expect(etagMatches('"abcd"', '"abc"')).toBe(false);
    expect(etagMatches(undefined, '"abc"')).toBe(false);
  });
});
