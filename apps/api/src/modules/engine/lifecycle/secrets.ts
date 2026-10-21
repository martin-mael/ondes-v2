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
  /** `ICECAST_SOURCE_PASSWORD`: this station's Icecast source password (its mounts' `<password>`). */
  icecastSourcePassword: string;
};

/** 256-bit random, base64url: safe in env vars, URLs, XML and Basic auth. */
export function generateEngineSecrets(): EngineSecrets {
  const secret = () => randomBytes(32).toString('base64url');
  return { controlToken: secret(), livePassword: secret(), icecastSourcePassword: secret() };
}

export type EngineSecretBox = {
  encrypt(plaintext: string): string;
  decrypt(sealed: string): string;
  /** The value was sealed with an older key: re-encrypt it. */
  isStale(sealed: string): boolean;
};

export type EngineSecretKeys = {
  /** Id of the key new values are sealed with; stored in each value. */
  currentId: string;
  /** Key material by id: the current key plus older ones still needed to decrypt. */
  keys: Record<string, string>;
};

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * AES-256-GCM, one key per id (HKDF of the configured key, so its length and encoding don't
 * matter). Values look like `v1:<keyId>:<iv>:<tag>:<ciphertext>`; rotate by adding a new
 * current key and keeping the old one until every value has been re-sealed (`isStale`).
 */
export function createEngineSecretBox(config: EngineSecretKeys): EngineSecretBox {
  const keys = new Map<string, Buffer>();
  for (const [id, secret] of Object.entries(config.keys)) {
    if (!KEY_ID.test(id)) throw new Error(`engine secrets: bad key id "${id}"`);
    if (secret.length < 32) throw new Error(`engine secrets: key "${id}" must be 32+ characters`);
    keys.set(id, Buffer.from(hkdfSync('sha256', secret, 'ondes-engine', 'engine-secrets', 32)));
  }
  const current = keys.get(config.currentId);
  if (!current) throw new Error(`engine secrets: no key for current id "${config.currentId}"`);

  return {
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', current, iv);
      const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return [
        'v1',
        config.currentId,
        ...[iv, cipher.getAuthTag(), data].map((p) => p.toString('base64url')),
      ].join(':');
    },
    decrypt(sealed) {
      const [version, id, iv, tag, data] = sealed.split(':');
      if (version !== 'v1' || !id || !iv || !tag || !data) throw new Error('unknown secret format');
      const key = keys.get(id);
      if (!key) throw new Error(`engine secrets: no key "${id}" to decrypt with`);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(data, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
    isStale: (sealed) => sealed.split(':')[1] !== config.currentId,
  };
}

/**
 * Keys from the environment: `ENGINE_SECRETS_KEY` (current), `ENGINE_SECRETS_KEY_ID`
 * (default `k1`), `ENGINE_SECRETS_PREVIOUS_KEYS` (`id:key,id:key`, for rotation).
 */
export function engineSecretKeysFromEnv(env: NodeJS.ProcessEnv): EngineSecretKeys {
  const key = env.ENGINE_SECRETS_KEY;
  if (!key || key.length < 32) throw new Error('ENGINE_SECRETS_KEY must be set (32+ characters)');
  const currentId = env.ENGINE_SECRETS_KEY_ID || 'k1';
  const keys: Record<string, string> = { [currentId]: key };
  for (const entry of (env.ENGINE_SECRETS_PREVIOUS_KEYS ?? '').split(',').filter(Boolean)) {
    const at = entry.indexOf(':');
    if (at < 1) throw new Error('ENGINE_SECRETS_PREVIOUS_KEYS must be id:key,id:key');
    keys[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return { currentId, keys };
}
