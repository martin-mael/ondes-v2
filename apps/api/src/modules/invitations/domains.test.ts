import { describe, expect, it } from 'vitest';
import {
  emailDomain,
  hasVerificationRecord,
  isPublicEmailDomain,
  type TxtResolver,
} from './domains.ts';

const fakeResolver = (records: Record<string, string[][]>): TxtResolver => ({
  resolveTxt: async (host) => {
    const found = records[host];
    if (!found) throw Object.assign(new Error('no data'), { code: 'ENODATA' });
    return found;
  },
});

describe('isPublicEmailDomain', () => {
  it.each([
    'gmail.com',
    'outlook.com',
    'proton.me',
    'yahoo.fr',
    'laposte.net',
    'mail.gmail.com',
    'tutanota.com',
    'tuta.com',
  ])('refuses %s', (domain) => expect(isPublicEmailDomain(domain)).toBe(true));

  it('accepts an organization domain', () => {
    expect(isPublicEmailDomain('vandaleradio.org')).toBe(false);
  });
});

describe('hasVerificationRecord', () => {
  it('matches the record, joining TXT chunks', async () => {
    const resolver = fakeResolver({
      'example.org': [['v=spf1 -all'], ['ondes-verify=', 'abc123']],
    });
    expect(await hasVerificationRecord(resolver, 'example.org', 'abc123')).toBe(true);
    expect(await hasVerificationRecord(resolver, 'example.org', 'other')).toBe(false);
  });

  it('treats a missing record as not verified', async () => {
    expect(await hasVerificationRecord(fakeResolver({}), 'example.org', 'abc')).toBe(false);
  });

  it('reports DNS failures instead of answering "not verified"', async () => {
    const resolver: TxtResolver = {
      resolveTxt: async () => {
        throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
      },
    };
    await expect(hasVerificationRecord(resolver, 'example.org', 'abc')).rejects.toMatchObject({
      statusCode: 503,
    });
  });
});

it('emailDomain lowercases the domain part', () => {
  expect(emailDomain('Jane@VandaleRadio.org')).toBe('vandaleradio.org');
});
