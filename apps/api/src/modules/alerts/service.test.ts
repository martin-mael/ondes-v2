import type { Alert } from '@ondes/shared';
import { realtimeEventSchema } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { criticalAlertTemplate } from './emails.ts';
import { snapshot } from './service.ts';

const alert: Alert = {
  id: '0199f6a0-0000-7000-8000-000000000001',
  orgId: '0199f6a0-0000-7000-8000-000000000002',
  stationId: '0199f6a0-0000-7000-8000-000000000003',
  type: 'engine.silence',
  severity: 'critical',
  status: 'open',
  dedupeKey: 'engine.silence',
  title: 'Silence on air',
  message: 'Silent for 10 s.',
  details: { action: { action: 'skip', result: 'done' } },
  occurrences: 1,
  raisedAt: new Date('2026-10-25T00:30:00Z'),
  lastSeenAt: new Date('2026-10-25T00:30:00Z'),
  escalatedAt: null,
  escalateAt: null,
  escalateTo: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  resolvedAt: null,
  resolution: null,
};

describe('alert events', () => {
  it('snapshots are valid alert.* events', () => {
    const event = {
      id: '0199f6a0-0000-7000-8000-000000000004',
      stationId: alert.stationId,
      at: '2026-10-25T00:30:01.000Z',
      type: 'alert.escalated',
      data: { ...snapshot(alert), previousSeverity: 'warning' },
    };
    expect(realtimeEventSchema.parse(event)).toEqual(event);
    expect(snapshot(alert).raisedAt).toBe('2026-10-25T00:30:00.000Z');
  });
});

describe('critical alert email', () => {
  it('names the station and links to the alert', () => {
    const vars = { name: 'Sam', stationName: 'Vandale', alert, link: 'https://app.test/x' };
    const raised = criticalAlertTemplate.render({ ...vars, escalated: false });
    expect(raised.subject).toBe('[Vandale] Silence on air');
    expect(raised.text).toContain('Critical alert on Vandale: Silence on air');
    expect(raised.text).toContain('Silent for 10 s.');
    expect(raised.text).toContain('https://app.test/x');
    const escalated = criticalAlertTemplate.render({ ...vars, escalated: true });
    expect(escalated.text).toContain('An alert on Vandale is now critical: Silence on air');
  });
});
