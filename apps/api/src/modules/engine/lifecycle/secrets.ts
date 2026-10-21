import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Per-station engine secrets: generated once, stored encrypted in `station_engine`, and
 * passed to the station's container as environment variables (the template reads them;
 * ADR 0007 keeps secrets out of the rendered script).
 */
export type EngineSecrets = {
  /** `ENGINE_CONTROL_TOKEN`: bearer for the control API and for the engine's event posts. */
  controlToken: string;
  /** `ENGINE_LIVE_PASSWORD`: shared live password, when no live auth webhook is set. */
  livePassword: string;
  /** Icecast source password generated for this station (see README.md). */
  icecastSourcePassword: string;
};

/** 256-bit random, base64url: safe in env vars, URLs and Basic auth. */
export function generateEngineSecrets(): EngineSecrets {
  const secret = () => randomBytes(32).toString('base64url');
  return { controlToken: secret(), livePassword: secret(), icecastSourcePassword: secret() };
}

export type EngineSecretBox = {
  encrypt(plaintext: string): string;
  decrypt(sealed: string): string;
};

/**
 * AES-256-GCM with a key derived from the api's secret (AUTH_SECRET) by HKDF, under its own
 * label, so it never shares a key with the auth module's TOTP encryption.
 */
export function createEngineSecretBox(secret: string): EngineSecretBox {
  if (secret.length < 32) throw new Error('engine secrets: the key must be 32+ characters');
  const key = Buffer.from(hkdfSync('sha256', secret, 'ondes-engine', 'engine-secrets', 32));
  return {
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return ['v1', iv, cipher.getAuthTag(), data]
        .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
        .join(':');
    },
    decrypt(sealed) {
      const [version, iv, tag, data] = sealed.split(':');
      if (version !== 'v1' || !iv || !tag || !data) throw new Error('unknown secret format');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(data, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
