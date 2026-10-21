import { describe, expect, it } from 'vitest';
import {
  createEngineSecretBox,
  engineSecretKeysFromEnv,
  generateEngineSecrets,
} from './secrets.ts';

const KEY = 'a-test-key-that-is-long-enough-0123456789';
const OTHER = 'another-test-key-long-enough-9876543210';

describe('engine secrets', () => {
  it('generates distinct 256-bit url-safe secrets', () => {
    const a = generateEngineSecrets();
    const b = generateEngineSecrets();
    for (const value of Object.values(a)) expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set([...Object.values(a), ...Object.values(b)]).size).toBe(6);
  });

  it('round-trips with the key id in the value and a fresh IV each time', () => {
    const box = createEngineSecretBox({ currentId: 'k1', keys: { k1: KEY } });
    const sealed = box.encrypt('hunter2');
    expect(sealed).toMatch(/^v1:k1:/);
    expect(sealed).not.toContain('hunter2');
    expect(box.encrypt('hunter2')).not.toBe(sealed);
    expect(box.decrypt(sealed)).toBe('hunter2');
    expect(box.isStale(sealed)).toBe(false);
  });

  it('rotates: a new current key still decrypts values sealed with the old one', () => {
    const old = createEngineSecretBox({ currentId: 'k1', keys: { k1: KEY } });
    const sealed = old.encrypt('hunter2');
    const rotated = createEngineSecretBox({ currentId: 'k2', keys: { k2: OTHER, k1: KEY } });
    expect(rotated.decrypt(sealed)).toBe('hunter2');
    expect(rotated.isStale(sealed)).toBe(true);
    expect(rotated.encrypt('x')).toMatch(/^v1:k2:/);
    // Without the old key, its values can't be read.
    expect(() =>
      createEngineSecretBox({ currentId: 'k2', keys: { k2: OTHER } }).decrypt(sealed),
    ).toThrow(/k1/);
  });

  it('refuses tampering, short keys and a missing current key', () => {
    const box = createEngineSecretBox({ currentId: 'k1', keys: { k1: KEY } });
    const [v, id, iv, tag, data] = box.encrypt('hunter2').split(':');
    const flipped = `${data?.[0] === 'A' ? 'B' : 'A'}${data?.slice(1)}`;
    expect(() => box.decrypt([v, id, iv, tag, flipped].join(':'))).toThrow();
    expect(() => createEngineSecretBox({ currentId: 'k1', keys: { k1: 'short' } })).toThrow();
    expect(() => createEngineSecretBox({ currentId: 'k9', keys: { k1: KEY } })).toThrow();
  });

  it('reads keys from the environment', () => {
    expect(() => engineSecretKeysFromEnv({})).toThrow(/ENGINE_SECRETS_KEY/);
    expect(engineSecretKeysFromEnv({ ENGINE_SECRETS_KEY: KEY })).toEqual({
      currentId: 'k1',
      keys: { k1: KEY },
    });
    expect(
      engineSecretKeysFromEnv({
        ENGINE_SECRETS_KEY: OTHER,
        ENGINE_SECRETS_KEY_ID: 'k2',
        ENGINE_SECRETS_PREVIOUS_KEYS: `k1:${KEY}`,
      }),
    ).toEqual({ currentId: 'k2', keys: { k2: OTHER, k1: KEY } });
  });
});
