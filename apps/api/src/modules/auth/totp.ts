import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// TOTP (RFC 6238): HMAC-SHA1, 30-second steps, 6 digits, the format every authenticator app
// reads. Codes from one step before or after are accepted, to absorb clock drift.

const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret, base32 (the size RFC 4226 recommends for SHA-1). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function timeStep(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 1000 / STEP_SECONDS);
}

/** HOTP value for one counter (RFC 4226 §5.3). */
export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function totpCode(secret: string, at: Date = new Date()): string {
  return hotp(base32Decode(secret), timeStep(at));
}

/**
 * Checks a code against the current step and its neighbours. Returns the matching step, so the
 * caller can refuse any step at or before the last one used (no replay), or `null`.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: { at?: Date; afterStep?: number | null } = {},
): number | null {
  const key = base32Decode(secret);
  const now = timeStep(options.at);
  for (const step of [now - 1, now, now + 1]) {
    if (options.afterStep != null && step <= options.afterStep) continue;
    const expected = Buffer.from(hotp(key, step));
    const given = Buffer.from(code);
    if (expected.length === given.length && timingSafeEqual(expected, given)) return step;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer = 'Ondes'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params}`;
}

/** Ten `xxxxx-xxxxx` codes (base32, 50 bits each). */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** Lowercase, no dash: what gets hashed. */
export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/-/g, '');
}
