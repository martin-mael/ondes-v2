import { describe, expect, it } from 'vitest';
import { createSecretBox } from './crypto.ts';
import { hashPassword, verifyPassword } from './password.ts';

describe('secret box', () => {
  const box = createSecretBox('a'.repeat(32));

  it('encrypts and decrypts', () => {
    const sealed = box.encrypt('JBSWY3DPEHPK3PXP');
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(box.decrypt(sealed)).toBe('JBSWY3DPEHPK3PXP');
    expect(box.encrypt('x')).not.toBe(box.encrypt('x'));
  });

  it('refuses tampered or foreign ciphertexts', () => {
    const sealed = box.encrypt('secret');
    const [v, iv, tag, data] = sealed.split(':');
    const flipped = `${v}:${iv}:${tag}:${data?.startsWith('A') ? 'B' : 'A'}${data?.slice(1)}`;
    expect(() => box.decrypt(flipped)).toThrow();
    expect(() => createSecretBox('b'.repeat(32)).decrypt(sealed)).toThrow();
  });

  it('keys HMACs by the secret', () => {
    expect(box.hmac('code')).toBe(box.hmac('code'));
    expect(createSecretBox('b'.repeat(32)).hmac('code')).not.toBe(box.hmac('code'));
  });
});

describe('passwords', () => {
  it('hashes with argon2id', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'wrong horse battery')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});
