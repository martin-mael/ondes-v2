import { describe, expect, it } from 'vitest';
import { localDayBounds, zonedInstant } from '../time/index.ts';
import {
  createPromoSchema,
  inDayparts,
  promoStatus,
  updatePromoSchema,
  validThroughout,
} from './promos.ts';

// Promo contracts (#60): validity windows, dayparts on the station clock (DST), status.

const TZ = 'Europe/Paris';

describe('validThroughout', () => {
  const window = {
    startAt: new Date('2026-11-01T10:00:00Z'),
    killAt: new Date('2026-11-02T10:00:00Z'),
  };
  it('holds from the start up to, not including, the kill instant', () => {
    expect(validThroughout(window, new Date('2026-11-01T10:00:00Z'))).toBe(true);
    expect(validThroughout(window, new Date('2026-11-01T09:59:59Z'))).toBe(false);
    expect(validThroughout(window, new Date('2026-11-02T09:59:59Z'))).toBe(true);
    expect(validThroughout(window, new Date('2026-11-02T10:00:00Z'))).toBe(false);
  });
  it('checks the whole range', () => {
    expect(
      validThroughout(window, new Date('2026-11-02T09:59:00Z'), new Date('2026-11-02T10:00:30Z')),
    ).toBe(false);
    expect(validThroughout({ startAt: null, killAt: null }, new Date(0))).toBe(true);
  });
  it('a kill date across the October DST change is an instant', () => {
    // 02:30 on 2026-10-25 happens twice; the first one (CEST) is the kill instant.
    const kill = zonedInstant('2026-10-25', '02:30', TZ);
    const w = { startAt: null, killAt: kill };
    expect(validThroughout(w, new Date(kill.getTime() - 1))).toBe(true);
    // The second 02:30 (CET), an hour later, is past it.
    expect(validThroughout(w, new Date(kill.getTime() + 3_600_000))).toBe(false);
  });
});

describe('inDayparts', () => {
  const mornings = [{ weekdays: [1, 2, 3, 4, 5], startHour: 6, endHour: 10 }];
  it('reads the local weekday and hour', () => {
    // 2026-11-04 is a Wednesday.
    expect(inDayparts(mornings, zonedInstant('2026-11-04', '06:00', TZ), TZ)).toBe(true);
    expect(inDayparts(mornings, zonedInstant('2026-11-04', '09:59', TZ), TZ)).toBe(true);
    expect(inDayparts(mornings, zonedInstant('2026-11-04', '10:00', TZ), TZ)).toBe(false);
    expect(inDayparts(mornings, zonedInstant('2026-11-07', '07:00', TZ), TZ)).toBe(false);
    expect(inDayparts([], zonedInstant('2026-11-07', '07:00', TZ), TZ)).toBe(true);
  });
  it('runs past midnight into the next weekday', () => {
    const nights = [{ weekdays: [5], startHour: 22, endHour: 2 }];
    // Friday 2026-11-06 23:00 and Saturday 01:00 are in; Saturday 23:00 isn't.
    expect(inDayparts(nights, zonedInstant('2026-11-06', '23:00', TZ), TZ)).toBe(true);
    expect(inDayparts(nights, zonedInstant('2026-11-07', '01:00', TZ), TZ)).toBe(true);
    expect(inDayparts(nights, zonedInstant('2026-11-07', '23:00', TZ), TZ)).toBe(false);
  });
  it('follows the wall clock on DST days', () => {
    const early = [{ weekdays: [7], startHour: 2, endHour: 3 }];
    // Last Sunday of March: 02:xx doesn't exist (01:59 CET is followed by 03:00 CEST), so
    // the 02–03 daypart covers nothing that day.
    const march = localDayBounds('2026-03-29', TZ).startsAt.getTime();
    for (let m = 0; m < 5 * 60; m += 15) {
      expect(inDayparts(early, new Date(march + m * 60_000), TZ)).toBe(false);
    }
    // Last Sunday of October: 02:xx happens twice, both are in.
    const october = localDayBounds('2026-10-25', TZ).startsAt.getTime();
    expect(inDayparts(early, new Date(october + 2.5 * 3_600_000), TZ)).toBe(true); // 02:30 CEST
    expect(inDayparts(early, new Date(october + 3.5 * 3_600_000), TZ)).toBe(true); // 02:30 CET
    expect(inDayparts(early, new Date(october + 4.5 * 3_600_000), TZ)).toBe(false); // 03:30 CET
  });
});

describe('promoStatus', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  it('derives the status from now', () => {
    expect(promoStatus({ enabled: true, startAt: null, killAt: null }, now)).toBe('active');
    expect(promoStatus({ enabled: false, startAt: null, killAt: null }, now)).toBe('disabled');
    expect(promoStatus({ enabled: true, startAt: null, killAt: now }, now)).toBe('expired');
    expect(
      promoStatus({ enabled: true, startAt: new Date(now.getTime() + 1), killAt: null }, now),
    ).toBe('scheduled');
  });
});

describe('promo inputs', () => {
  it('defaults and checks dates', () => {
    const parsed = createPromoSchema.parse({ assetId: '00000000-0000-7000-8000-000000000001' });
    expect(parsed).toMatchObject({ weight: 1, maxPlaysPerDay: null, dayparts: [], poolIds: [] });
    expect(
      createPromoSchema.safeParse({
        assetId: '00000000-0000-7000-8000-000000000001',
        startAt: '2026-11-02T00:00:00Z',
        killAt: '2026-11-01T00:00:00Z',
      }).success,
    ).toBe(false);
    expect(updatePromoSchema.safeParse({ version: 2 }).success).toBe(false);
    expect(updatePromoSchema.safeParse({ weight: 0 }).success).toBe(false);
    expect(
      createPromoSchema.safeParse({
        assetId: '00000000-0000-7000-8000-000000000001',
        dayparts: [{ weekdays: [1, 1], startHour: 6, endHour: 10 }],
      }).success,
    ).toBe(false);
  });
});
