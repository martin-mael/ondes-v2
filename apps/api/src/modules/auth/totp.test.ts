import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  hotp,
  normalizeRecoveryCode,
  totpCode,
  verifyTotp,
} from './totp.ts';

// RFC 6238 appendix B, SHA-1 key "12345678901234567890" (the 6 low digits of each vector).
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('totp', () => {
  it('matches the RFC 6238 test vectors', () => {
    expect(totpCode(RFC_SECRET, new Date(59_000))).toBe('287082');
    expect(totpCode(RFC_SECRET, new Date(1_111_111_109_000))).toBe('081804');
    expect(totpCode(RFC_SECRET, new Date(1_234_567_890_000))).toBe('005924');
    expect(totpCode(RFC_SECRET, new Date(20_000_000_000_000))).toBe('353130');
  });

  it('matches the RFC 4226 HOTP vectors', () => {
    const key = Buffer.from('12345678901234567890');
    expect([0, 1, 2, 9].map((c) => hotp(key, c))).toEqual(['755224', '287082', '359152', '520489']);
  });

  it('round-trips base32', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it('accepts one step of drift and refuses replays', () => {
    const at = new Date(1_700_000_000_000);
    const previous = totpCode(RFC_SECRET, new Date(at.getTime() - 30_000));
    const step = verifyTotp(RFC_SECRET, previous, { at });
    expect(step).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, previous, { at, afterStep: step })).toBeNull();
    const old = totpCode(RFC_SECRET, new Date(at.getTime() - 90_000));
    expect(verifyTotp(RFC_SECRET, old, { at })).toBeNull();
  });

  it('makes distinct recovery codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
    expect(normalizeRecoveryCode('ABCDE-fghij')).toBe('abcdefghij');
  });
});
