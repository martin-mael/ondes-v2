import type { FallbackAsset, FallbackCacheState } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { needsRaise, safetyAlertResolution, safetyAlerts } from './alerts.ts';

const now = new Date('2026-10-25T01:30:00Z');

function asset(state: FallbackCacheState, id = crypto.randomUUID()): FallbackAsset {
  return {
    assetId: id,
    type: 'song',
    title: 't',
    artists: [],
    durationMs: 180_000,
    sha256: state === 'no_file' ? null : 'a'.repeat(64),
    cache: { state, error: state === 'failed' ? 'io' : null, errorMessage: null },
    addedAt: now,
  };
}

const healthy = { safety: [asset('ready')], emergency: asset('ready'), onAir: null };
const types = (input: Parameters<typeof safetyAlerts>[0]) =>
  safetyAlerts(input).map((a) => `${a.type}/${a.severity}`);

describe('safetyAlerts', () => {
  it('raises nothing for a healthy station', () => {
    expect(safetyAlerts({ selection: healthy, engineRunning: true, now })).toEqual([]);
  });

  it('raises nothing for a station whose engine is stopped', () => {
    const selection = { safety: [], emergency: null, onAir: null };
    expect(safetyAlerts({ selection, engineRunning: false, now })).toEqual([]);
  });

  it('warns when no safety file is ready, selected or not', () => {
    const none = { ...healthy, safety: [] };
    expect(types({ selection: none, engineRunning: true, now })).toEqual([
      'engine.safety_empty/warning',
    ]);
    const pending = { ...healthy, safety: [asset('pending'), asset('failed'), asset('no_file')] };
    const [alert] = safetyAlerts({ selection: pending, engineRunning: true, now });
    expect(alert?.details).toMatchObject({
      selected: 3,
      ready: 0,
      states: { pending: 1, failed: 1, no_file: 1 },
    });
    // One ready file is enough.
    const one = { ...healthy, safety: [asset('pending'), asset('ready')] };
    expect(safetyAlerts({ selection: one, engineRunning: true, now })).toEqual([]);
  });

  it('warns when the emergency file is missing or not cached', () => {
    expect(types({ selection: { ...healthy, emergency: null }, engineRunning: true, now })).toEqual(
      ['engine.emergency_missing/warning'],
    );
    for (const state of ['pending', 'failed', 'no_file'] as const) {
      const selection = { ...healthy, emergency: asset(state) };
      expect(types({ selection, engineRunning: true, now })).toEqual([
        'engine.emergency_missing/warning',
      ]);
    }
  });

  it('raises safety mode once the engine has been on a fallback for the grace period', () => {
    const on = (source: 'safety' | 'emergency' | 'queue', ms: number) => ({
      ...healthy,
      onAir: { source, startedAt: new Date(now.getTime() - ms) },
    });
    expect(types({ selection: on('safety', 29_000), engineRunning: true, now })).toEqual([]);
    expect(types({ selection: on('safety', 30_000), engineRunning: true, now })).toEqual([
      'engine.safety_mode/warning',
    ]);
    expect(types({ selection: on('emergency', 60_000), engineRunning: true, now })).toEqual([
      'engine.safety_mode/critical',
    ]);
    expect(types({ selection: on('queue', 600_000), engineRunning: true, now })).toEqual([]);
  });
});

describe('needsRaise', () => {
  const desired = (severity: 'warning' | 'critical') => ({
    type: 'engine.safety_mode',
    severity,
    dedupeKey: 'engine.safety_mode',
    title: 't',
    details: {},
  });

  it('raises when not open, or open at a lower severity', () => {
    expect(needsRaise(desired('warning'), undefined)).toBe(true);
    expect(needsRaise(desired('warning'), 'warning')).toBe(false);
    expect(needsRaise(desired('critical'), 'warning')).toBe(true);
    expect(needsRaise(desired('warning'), 'critical')).toBe(false);
  });
});

describe('safetyAlertResolution', () => {
  it('says why an alert closes', () => {
    expect(safetyAlertResolution('engine.safety_mode', true)).toBe('back_on_schedule');
    expect(safetyAlertResolution('engine.safety_empty', true)).toBe('fallback_ok');
    expect(safetyAlertResolution('engine.safety_mode', false)).toBe('engine_stopped');
  });
});
