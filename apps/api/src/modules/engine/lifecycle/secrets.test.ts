import { describe, expect, it } from 'vitest';
import { createEngineSecretBox, generateEngineSecrets } from './secrets.ts';

const KEY = 'a-test-key-that-is-long-enough-0123456789';

describe('engine secrets', () => {
  it('generates distinct 256-bit url-safe secrets', () => {
    const a = generateEngineSecrets();
    const b = generateEngineSecrets();
    for (const value of Object.values(a)) expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set([...Object.values(a), ...Object.values(b)]).size).toBe(6);
  });

  it('round-trips through the box, with a fresh IV each time', () => {
    const box = createEngineSecretBox(KEY);
    const sealed = box.encrypt('hunter2');
    expect(sealed).not.toContain('hunter2');
    expect(box.encrypt('hunter2')).not.toBe(sealed);
    expect(box.decrypt(sealed)).toBe('hunter2');
  });

  it('refuses another key, tampering and short keys', () => {
    const sealed = createEngineSecretBox(KEY).encrypt('hunter2');
    expect(() => createEngineSecretBox(`${KEY}x`).decrypt(sealed)).toThrow();
    const [v, iv, tag, data] = sealed.split(':');
    const flipped = `${data?.[0] === 'A' ? 'B' : 'A'}${data?.slice(1)}`;
    expect(() => createEngineSecretBox(KEY).decrypt([v, iv, tag, flipped].join(':'))).toThrow();
    expect(() => createEngineSecretBox('short')).toThrow();
  });
});
