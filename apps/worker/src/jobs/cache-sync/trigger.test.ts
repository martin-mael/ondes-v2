import type { RealtimeEvent } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { concernsCache } from './trigger.ts';

const now = Date.parse('2026-06-10T12:00:00Z');
const updated = (from: string, to: string): RealtimeEvent => ({
  id: '0199f6a0-0000-7000-8000-000000000001',
  stationId: '0199f6a0-0000-7000-8000-000000000002',
  at: new Date(now).toISOString(),
  type: 'log.updated',
  data: { from, to, days: [], cause: 'edit' },
});

describe('concernsCache', () => {
  it('syncs on log changes within the next week', () => {
    expect(concernsCache(updated('2026-06-10T14:00:00Z', '2026-06-10T15:00:00Z'), now)).toBe(true);
    // Still on air or just aired: pinned.
    expect(concernsCache(updated('2026-06-10T10:00:00Z', '2026-06-10T11:30:00Z'), now)).toBe(true);
  });

  it('ignores the past, the far future and other events', () => {
    expect(concernsCache(updated('2026-06-09T00:00:00Z', '2026-06-09T23:00:00Z'), now)).toBe(false);
    expect(concernsCache(updated('2026-06-20T00:00:00Z', '2026-06-20T23:00:00Z'), now)).toBe(false);
    expect(
      concernsCache(
        {
          id: '0199f6a0-0000-7000-8000-000000000001',
          stationId: 'x',
          at: new Date(now).toISOString(),
          type: 'engine.down',
          data: { bootId: null, reason: 'timeout' },
        },
        now,
      ),
    ).toBe(false);
  });
});
