import type { FallbackAsset, FallbackCacheState } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { emergencyInEngine, needsRaise, safetyAlertResolution, safetyAlerts } from './alerts.ts';

const now = new Date('2026-10-25T01:30:00Z');

function asset(state: FallbackCacheState, sha = 'a'): FallbackAsset {
  return {
    assetId: crypto.randomUUID(),
    type: 'song',
    title: 't',
    artists: [],
    durationMs: 180_000,
    sha256: state === 'no_file' ? null : sha.repeat(64),
    cache: { state, error: state === 'failed' ? 'io' : null, errorMessage: null },
    addedAt: now,
  };
}

const emergency = asset('ready', 'e');
const healthy = {
  safety: [asset('ready')],
  emergency,
  onDisk: { safetyReady: 1, emergencySha256: emergency.sha256 },
  onAir: null,
};
type Selection = Parameters<typeof safetyAlerts>[0]['selection'];
const types = (selection: Selection, engineRunning = true) =>
  safetyAlerts({ selection, engineRunning, now }).map((a) => `${a.type}/${a.severity}`);

describe('safetyAlerts', () => {
  it('raises nothing for a healthy station', () => {
    expect(types(healthy)).toEqual([]);
  });

  it('raises nothing for a station whose engine is stopped', () => {
    const selection = {
      ...healthy,
      safety: [],
      emergency: null,
      onDisk: { safetyReady: 0, emergencySha256: null },
    };
    expect(types(selection, false)).toEqual([]);
  });

  it('warns when the engine holds no safety file', () => {
    expect(
      types({ ...healthy, safety: [], onDisk: { ...healthy.onDisk, safetyReady: 0 } }),
    ).toEqual(['engine.safety_empty/warning']);
    const selection = {
      ...healthy,
      safety: [asset('pending'), asset('failed'), asset('no_file')],
      onDisk: { ...healthy.onDisk, safetyReady: 0 },
    };
    const [alert] = safetyAlerts({ selection, engineRunning: true, now });
    expect(alert?.details).toMatchObject({
      selected: 3,
      ready: 0,
      states: { pending: 1, failed: 1, no_file: 1 },
    });
  });

  it("doesn't flap while a replaced playlist waits for its sync", () => {
    // The new files are pending, the old ones are still on disk.
    const selection = { ...healthy, safety: [asset('pending', 'b'), asset('pending', 'c')] };
    expect(types(selection)).toEqual([]);
  });

  it('warns when the engine holds no emergency file', () => {
    const none = { ...healthy.onDisk, emergencySha256: null };
    expect(types({ ...healthy, emergency: null, onDisk: none })).toEqual([
      'engine.emergency_missing/warning',
    ]);
    for (const state of ['pending', 'failed', 'no_file'] as const) {
      expect(types({ ...healthy, emergency: asset(state, 'f'), onDisk: none })).toEqual([
        'engine.emergency_missing/warning',
      ]);
    }
  });

  it('says when the previous emergency file is still in use', () => {
    // Pending: the sync will place it; no alert meanwhile.
    expect(types({ ...healthy, emergency: asset('pending', 'f') })).toEqual([]);
    for (const state of ['failed', 'no_file'] as const) {
      const [alert] = safetyAlerts({
        selection: { ...healthy, emergency: asset(state, 'f') },
        engineRunning: true,
        now,
      });
      expect(alert).toMatchObject({
        type: 'engine.emergency_missing',
        title: 'Previous emergency file still in use',
        details: { state, inUseSha256: emergency.sha256 },
      });
    }
  });

  it('raises safety mode once the engine has been on a fallback for the grace period', () => {
    const on = (source: 'safety' | 'emergency' | 'queue', ms: number) => ({
      ...healthy,
      onAir: { source, startedAt: new Date(now.getTime() - ms) },
    });
    expect(types(on('safety', 29_000))).toEqual([]);
    expect(types(on('safety', 30_000))).toEqual(['engine.safety_mode/warning']);
    expect(types(on('emergency', 60_000))).toEqual(['engine.safety_mode/critical']);
    expect(types(on('queue', 600_000))).toEqual([]);
  });
});

describe('emergencyInEngine', () => {
  it('tells the selected, a previous or no emergency file apart', () => {
    expect(emergencyInEngine(healthy)).toBe('selected');
    expect(emergencyInEngine({ ...healthy, emergency: asset('failed', 'f') })).toBe('previous');
    expect(emergencyInEngine({ ...healthy, emergency: null })).toBe('previous');
    expect(
      emergencyInEngine({ ...healthy, onDisk: { safetyReady: 1, emergencySha256: null } }),
    ).toBe('none');
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
