import type { FallbackSelection } from '@ondes/db';
import { type AlertSeverity, alertTypes, SAFETY_MODE_GRACE_MS } from '@ondes/shared';

// Fallback alerts (#34). Pure: the alerts a station should have open right now, from its
// selection, the worker's record of the cache and what the engine has on air. The service
// (service.ts) raises them and resolves the open ones that are no longer wanted.

export type DesiredAlert = {
  type: string;
  severity: AlertSeverity;
  dedupeKey: string;
  title: string;
  message?: string;
  details: Record<string, unknown>;
};

/** Every alert type this module raises; open alerts of these types are reconciled. */
export const SAFETY_ALERT_TYPES = [
  alertTypes.engineSafetyMode,
  alertTypes.engineSafetyEmpty,
  alertTypes.engineEmergencyMissing,
] as const;

export type SafetyAlertInput = {
  selection: Pick<FallbackSelection, 'safety' | 'emergency' | 'onAir' | 'onDisk'>;
  /** Only stations whose engine should run get alerts; the others have theirs resolved. */
  engineRunning: boolean;
  now: Date;
};

/** Which emergency file the engine's cache holds (see `SafetyStatus.inEngine`). */
export function emergencyInEngine(
  s: Pick<FallbackSelection, 'emergency' | 'onDisk'>,
): 'selected' | 'previous' | 'none' {
  const onDisk = s.onDisk.emergencySha256;
  if (!onDisk) return 'none';
  return s.emergency?.sha256 === onDisk ? 'selected' : 'previous';
}

/**
 * The alerts follow what the engine's cache holds, not the selection alone: a replaced
 * playlist keeps its old files until the next sync, so nothing is raised in between.
 */
export function safetyAlerts(input: SafetyAlertInput): DesiredAlert[] {
  if (!input.engineRunning) return [];
  const { safety, emergency, onAir, onDisk } = input.selection;
  const out: DesiredAlert[] = [];

  if (onDisk.safetyReady === 0) {
    out.push({
      type: alertTypes.engineSafetyEmpty,
      severity: 'warning',
      dedupeKey: alertTypes.engineSafetyEmpty,
      title: 'No safety playlist in the engine',
      message:
        safety.length === 0
          ? 'The station has no safety playlist: if the log runs dry, the engine falls back to the emergency file.'
          : "None of the safety playlist's files is in the engine's cache yet.",
      details: {
        selected: safety.length,
        ready: onDisk.safetyReady,
        states: countStates(safety),
      },
    });
  }

  const inEngine = emergencyInEngine(input.selection);
  const stuck = emergency?.cache.state === 'failed' || emergency?.cache.state === 'no_file';
  if (inEngine === 'none') {
    out.push({
      type: alertTypes.engineEmergencyMissing,
      severity: 'warning',
      dedupeKey: alertTypes.engineEmergencyMissing,
      title: 'No emergency file in the engine',
      message: emergency
        ? `The emergency file isn't in the engine's cache (${emergency.cache.state}).`
        : 'The station has no emergency file: with nothing else to play, the engine plays silence.',
      details: emergency
        ? { assetId: emergency.assetId, state: emergency.cache.state, error: emergency.cache.error }
        : { assetId: null },
    });
  } else if (inEngine === 'previous' && emergency && stuck) {
    out.push({
      type: alertTypes.engineEmergencyMissing,
      severity: 'warning',
      dedupeKey: alertTypes.engineEmergencyMissing,
      title: 'Previous emergency file still in use',
      message: `The new emergency file can't be put in the engine's cache (${emergency.cache.state}); the previous one keeps playing.`,
      details: {
        assetId: emergency.assetId,
        state: emergency.cache.state,
        error: emergency.cache.error,
        inUseSha256: onDisk.emergencySha256,
      },
    });
  }

  if (
    onAir &&
    (onAir.source === 'safety' || onAir.source === 'emergency') &&
    input.now.getTime() - onAir.startedAt.getTime() >= SAFETY_MODE_GRACE_MS
  ) {
    const onEmergency = onAir.source === 'emergency';
    out.push({
      type: alertTypes.engineSafetyMode,
      severity: onEmergency ? 'critical' : 'warning',
      dedupeKey: alertTypes.engineSafetyMode,
      title: onEmergency
        ? 'Safety mode: the engine is looping the emergency file'
        : 'Safety mode: the engine is playing the safety playlist',
      message: 'The log ran dry or its items aren’t cached: the station is off its schedule.',
      details: { source: onAir.source, since: onAir.startedAt.toISOString() },
    });
  }
  return out;
}

function countStates(assets: FallbackSelection['safety']) {
  const out: Record<string, number> = {};
  for (const a of assets) out[a.cache.state] = (out[a.cache.state] ?? 0) + 1;
  return out;
}

/** Why an open fallback alert that is no longer wanted closes. */
export function safetyAlertResolution(type: string, engineRunning: boolean): string {
  if (!engineRunning) return 'engine_stopped';
  return type === alertTypes.engineSafetyMode ? 'back_on_schedule' : 'fallback_ok';
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

/** Whether a desired alert must be raised: not open yet, or open at a lower severity. */
export function needsRaise(desired: DesiredAlert, open: AlertSeverity | undefined): boolean {
  return open === undefined || SEVERITY_RANK[desired.severity] > SEVERITY_RANK[open];
}
