import { describe, expect, it } from 'vitest';
import { recordingDate } from './build.ts';

// A recording's date is the station's local date of its first part (#67 review): a show
// that starts after midnight in Lyon is that day's, across both DST changes.

describe('live recording date', () => {
  const lyon = 'Europe/Paris';

  it('takes the local date after midnight, not the UTC one', () => {
    // 00:30 in Lyon (CEST, UTC+2) is 22:30 UTC the day before.
    expect(recordingDate(new Date('2026-07-10T22:30:00Z'), lyon)).toBe('2026-07-11');
    // 23:30 in Lyon (CET, UTC+1) is still that day.
    expect(recordingDate(new Date('2026-12-10T22:30:00Z'), lyon)).toBe('2026-12-10');
  });

  it('holds across the March change (last Sunday, 02:00 → 03:00)', () => {
    // Sunday 29 March 2026, 00:30 CET = Saturday 23:30 UTC.
    expect(recordingDate(new Date('2026-03-28T23:30:00Z'), lyon)).toBe('2026-03-29');
    // 03:30 CEST, just after the jump = 01:30 UTC.
    expect(recordingDate(new Date('2026-03-29T01:30:00Z'), lyon)).toBe('2026-03-29');
  });

  it('holds across the October change (last Sunday, 03:00 → 02:00)', () => {
    // Sunday 25 October 2026, 00:30 CEST = Saturday 22:30 UTC.
    expect(recordingDate(new Date('2026-10-24T22:30:00Z'), lyon)).toBe('2026-10-25');
    // 23:30 CET that Sunday = 22:30 UTC, still the 25th locally.
    expect(recordingDate(new Date('2026-10-25T22:30:00Z'), lyon)).toBe('2026-10-25');
  });

  it('falls back to UTC for an unknown station zone', () => {
    expect(recordingDate(new Date('2026-07-10T22:30:00Z'), 'UTC')).toBe('2026-07-10');
  });
});
