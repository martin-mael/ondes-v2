import { describe, expect, it } from 'vitest';
import {
  apiKeyScopeSchema,
  createMembershipSchema,
  createStationSchema,
  createUserSchema,
  ianaTimezoneSchema,
  slugSchema,
} from './tenancy.ts';

describe('tenancy contracts', () => {
  it('accepts IANA timezones only', () => {
    expect(ianaTimezoneSchema.safeParse('Europe/Paris').success).toBe(true);
    expect(ianaTimezoneSchema.safeParse('UTC').success).toBe(true);
    expect(ianaTimezoneSchema.safeParse('CEST').success).toBe(false);
    expect(ianaTimezoneSchema.safeParse('Mars/Olympus_Mons').success).toBe(false);
  });

  it('validates slugs', () => {
    expect(slugSchema.safeParse('vandale-radio').success).toBe(true);
    for (const bad of ['Vandale', 'a', '-x', 'x--y', 'radio_1']) {
      expect(slugSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('bounds the loudness target', () => {
    const base = { slug: 'v', name: 'V', timezone: 'Europe/Paris' };
    expect(
      createStationSchema.safeParse({ ...base, slug: 'vv', loudnessTargetLufs: -16 }).success,
    ).toBe(true);
    expect(
      createStationSchema.safeParse({ ...base, slug: 'vv', loudnessTargetLufs: 3 }).success,
    ).toBe(false);
  });

  it('ties roles to their level', () => {
    const userId = '0199f6a0-0000-7000-8000-000000000000';
    expect(createMembershipSchema.safeParse({ level: 'org', userId, role: 'owner' }).success).toBe(
      true,
    );
    expect(
      createMembershipSchema.safeParse({ level: 'org', userId, role: 'programmer' }).success,
    ).toBe(false);
    expect(
      createMembershipSchema.safeParse({
        level: 'station',
        userId,
        role: 'admin',
        stationId: userId,
      }).success,
    ).toBe(false);
  });

  it('normalizes emails and validates API key scopes', () => {
    expect(createUserSchema.parse({ email: 'Dev@Ondes.Localhost', name: 'D' }).email).toBe(
      'dev@ondes.localhost',
    );
    expect(apiKeyScopeSchema.safeParse('log:read').success).toBe(true);
    expect(apiKeyScopeSchema.safeParse('library:*').success).toBe(true);
    expect(apiKeyScopeSchema.safeParse('everything').success).toBe(false);
  });
});
