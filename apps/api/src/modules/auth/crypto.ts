import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

// Secrets helpers for auth. Link and session tokens are 256-bit random, so a plain SHA-256 is
// enough to store them; low-entropy secrets (recovery codes) get an HMAC keyed by AUTH_SECRET.

/** 256-bit random token, base64url (43 chars). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface SecretBox {
  hmac(value: string): string;
  encrypt(plaintext: string): string;
  decrypt(sealed: string): string;
}

/** Keys derived from AUTH_SECRET with HKDF: one for HMACs, one for AES-256-GCM. */
export function createSecretBox(secret: string): SecretBox {
  const derive = (info: string) => Buffer.from(hkdfSync('sha256', secret, 'ondes-auth', info, 32));
  const hmacKey = derive('hmac');
  const encKey = derive('totp-encryption');
  return {
    hmac: (value) => createHmac('sha256', hmacKey).update(value).digest('hex'),
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encKey, iv);
      const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return ['v1', iv, tag, data]
        .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
        .join(':');
    },
    decrypt(sealed) {
      const [version, iv, tag, data] = sealed.split(':');
      if (version !== 'v1' || !iv || !tag || !data) throw new Error('unknown secret format');
      const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(data, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
