import { describe, expect, it } from 'vitest';
import { islandAlertResolution } from './island-alerts.ts';

const now = new Date('2026-10-23T12:00:00Z');
const row = (over: Partial<Parameters<typeof islandAlertResolution>[0] & object> = {}) => ({
  id: 'i',
  status: 'failed',
  retryAt: null,
  error: 'bad source',
  hash: 'h',
  segueIds: [],
  headItemId: 'a',
  tailItemId: 'b',
  airsAt: new Date('2026-10-23T13:00:00Z'),
  airsUntil: new Date('2026-10-23T13:03:00Z'),
  ...over,
});

describe('islandAlertResolution', () => {
  it('wants an alert for a final failure still to air', () => {
    expect(islandAlertResolution(row(), now)).toBeNull();
    // On air right now still counts.
    expect(
      islandAlertResolution(row({ airsUntil: new Date('2026-10-23T12:01:00Z') }), now),
    ).toBeNull();
  });

  it('says why there is none otherwise', () => {
    expect(islandAlertResolution(undefined, now)).toBe('removed');
    expect(islandAlertResolution(row({ status: 'ready' }), now)).toBe('rendered');
    expect(islandAlertResolution(row({ status: 'pending' }), now)).toBe('rendering');
    expect(islandAlertResolution(row({ status: 'rendering' }), now)).toBe('rendering');
    expect(islandAlertResolution(row({ retryAt: new Date('2026-10-23T12:05:00Z') }), now)).toBe(
      'retrying',
    );
    expect(islandAlertResolution(row({ airsUntil: now }), now)).toBe('slot_over');
    expect(islandAlertResolution(row({ airsAt: null, airsUntil: null }), now)).toBe('slot_over');
  });
});
