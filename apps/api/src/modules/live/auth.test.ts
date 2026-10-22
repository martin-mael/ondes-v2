import { liveAuthLogin } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { LoginFailureLimiter } from './auth.ts';
import { generatePassword, statusOf } from './repo.ts';
import { liveAuthUrl } from './url.ts';

describe('liveAuthLogin', () => {
  it('takes the Icecast user name as it is, lowercased', () => {
    expect(liveAuthLogin({ user: 'Nova', password: 'a:b' })).toEqual({
      username: 'nova',
      password: 'a:b',
    });
  });

  it('splits username:password for Shoutcast clients (no user, or a placeholder)', () => {
    for (const user of ['', 'source', 'SOURCE']) {
      expect(liveAuthLogin({ user, password: 'Nova:se:cret' })).toEqual({
        username: 'nova',
        password: 'se:cret',
      });
    }
    expect(liveAuthLogin({ user: 'source', password: 'plain' })).toEqual({
      username: 'source',
      password: 'plain',
    });
  });
});

describe('LoginFailureLimiter', () => {
  it('brakes a key after max failures to one probe per interval, then forgets them', () => {
    const limiter = new LoginFailureLimiter({ max: 3, windowMs: 1000, probeEveryMs: 100 });
    for (const at of [0, 10, 20]) limiter.fail('a', at);
    expect(limiter.allow('a', 30)).toBe(true); // the probe
    expect(limiter.allow('a', 40)).toBe(false);
    expect(limiter.allow('b', 40)).toBe(true);
    expect(limiter.allow('a', 140)).toBe(true); // the next probe
    expect(limiter.allow('a', 1100)).toBe(true); // failures expired
  });

  it('forgets a key on success', () => {
    const limiter = new LoginFailureLimiter({ max: 1, probeEveryMs: 1000 });
    limiter.fail('a', 0);
    limiter.succeed('a');
    expect(limiter.allow('a', 1)).toBe(true);
  });

  it('keys on station, username and address', () => {
    expect(LoginFailureLimiter.key('s', 'nova', '10.0.0.1')).not.toBe(
      LoginFailureLimiter.key('s', 'other', '10.0.0.1'),
    );
    expect(LoginFailureLimiter.key('s', 'nova', undefined)).toBe('s|nova|(no address)');
  });

  it('keeps at most maxKeys keys, dropping the least recently failed', () => {
    const limiter = new LoginFailureLimiter({ max: 1, maxKeys: 100, probeEveryMs: 1000 });
    for (let i = 0; i < 1000; i++) limiter.fail(`k${i}`, 0);
    expect(limiter.size).toBe(100);
    expect(limiter.allow('k0', 1)).toBe(true); // evicted
    expect(limiter.allow('k999', 1)).toBe(true); // probe
    expect(limiter.allow('k999', 2)).toBe(false);
  });
});

describe('streamers', () => {
  it('generates 24-character passwords without look-alikes or separators', () => {
    const passwords = new Set(Array.from({ length: 50 }, generatePassword));
    expect(passwords.size).toBe(50);
    for (const p of passwords) expect(p).toMatch(/^[a-km-np-zA-HJ-NP-Z2-9]{24}$/);
  });

  it('reports disabled before expired', () => {
    const past = new Date('2020-01-01T00:00:00Z');
    expect(statusOf({ enabled: true, expiresAt: null })).toBe('active');
    expect(statusOf({ enabled: true, expiresAt: past })).toBe('expired');
    expect(statusOf({ enabled: false, expiresAt: past })).toBe('disabled');
  });

  it('builds the live auth URL', () => {
    expect(liveAuthUrl('http://api:3000/', 'st 1')).toBe(
      'http://api:3000/internal/engine/stations/st%201/live-auth',
    );
  });
});
