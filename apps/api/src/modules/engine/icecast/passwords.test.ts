import { describe, expect, it } from 'vitest';
import { engineIcecastSourcePassword, icecastSourcePassword } from './passwords.ts';

describe('icecastSourcePassword', () => {
  const master = 'a-master-password-of-some-length';

  it('is stable per station and differs between stations', () => {
    const a = icecastSourcePassword(master, 'station-a');
    expect(icecastSourcePassword(master, 'station-a')).toBe(a);
    expect(icecastSourcePassword(master, 'station-b')).not.toBe(a);
    expect(icecastSourcePassword(`${master}x`, 'station-a')).not.toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a).not.toContain(master);
  });

  it('refuses a short master', () => {
    expect(() => icecastSourcePassword('short', 'station-a')).toThrow(/16 characters/);
    expect(() => icecastSourcePassword('', 'station-a')).toThrow();
  });

  it("gives engines the derived password only when the api owns Icecast's config", () => {
    const env = { ICECAST_SOURCE_PASSWORD: master };
    expect(engineIcecastSourcePassword(env, 'st')).toBe(master);
    expect(engineIcecastSourcePassword({ ...env, ICECAST_CONFIG_PATH: '/x.xml' }, 'st')).toBe(
      icecastSourcePassword(master, 'st'),
    );
    expect(() => engineIcecastSourcePassword({}, 'st')).toThrow();
  });
});
