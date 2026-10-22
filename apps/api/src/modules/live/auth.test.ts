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
  it('blocks a key after max failures within the window, then forgets them', () => {
    const limiter = new LoginFailureLimiter({ max: 3, windowMs: 1000 });
    for (const at of [0, 100, 200]) limiter.fail('a', at);
    expect(limiter.blocked('a', 300)).toBe(true);
    expect(limiter.blocked('b', 300)).toBe(false);
    expect(limiter.blocked('a', 1150)).toBe(false);
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
