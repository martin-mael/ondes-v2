import type { Db } from '@ondes/db';
import {
  alertTypes,
  type RealtimeEvent,
  type SilenceAction,
  type SilenceSettings,
  uuidSchema,
} from '@ondes/shared';
import type { EngineAdapter, Logger } from '../engine/adapter/index.ts';
import * as repo from './repo.ts';
import type { AlertService } from './service.ts';

/**
 * The station template's `blank` settings (#27, `stationEngineSettingsSchema.blank`) from the
 * station's silence settings: what `updateSilenceSettings` writes to `station.engine_settings.blank`.
 */
export function engineBlankSettings(settings: SilenceSettings) {
  return { maxSeconds: settings.maxSeconds, thresholdDb: settings.thresholdDb };
}

/** The engine commands the silence action needs. */
export type SilenceActionEngine = Pick<EngineAdapter, 'skip' | 'clear'>;

export type EngineAlertsOptions = {
  db: Db;
  alerts: AlertService;
  /** The station's engine adapter, if this api runs it (#35's registry). */
  engineFor?: (stationId: string) => SilenceActionEngine | undefined;
  logger: Logger;
};

/** What the action did, stored in the alert's `details.action`. */
export type SilenceActionOutcome = {
  action: SilenceAction;
  result: 'done' | 'failed' | 'no_engine' | 'none';
  error?: string;
};

/**
 * Turns engine events from the fanout (#28) into alerts:
 *
 * - `engine.blank.detected`: raise `engine.silence` and run the station's silence action
 *   (skip, or fall back to the safety playlist). With an action, the alert is a warning that
 *   escalates to critical after `escalateAfterSeconds` of continued silence. Without one, it
 *   is critical at once.
 * - `engine.blank.recovered`, `engine.booted`: resolve it (a new boot starts a new blank
 *   detector: silence on the new boot is detected again).
 * - `engine.down` / `engine.up`: raise / resolve `engine.down`.
 *
 * The action runs only when this call opened the alert, so a redelivered event or a second
 * api replica never skips twice.
 */
export function createEngineAlertHandler(options: EngineAlertsOptions) {
  const { db, alerts, logger } = options;

  async function runSilenceAction(
    stationId: string,
    action: SilenceAction,
  ): Promise<SilenceActionOutcome> {
    if (action === 'none') return { action, result: 'none' };
    const engine = options.engineFor?.(stationId);
    if (!engine) return { action, result: 'no_engine' };
    try {
      // Safety: an empty queue makes the engine's fallback pick the safety playlist; the
      // skip ends the silent item now instead of at its end.
      if (action === 'safety') await engine.clear();
      await engine.skip();
      return { action, result: 'done' };
    } catch (error) {
      logger.error({ err: error, stationId, action }, 'Silence action failed');
      return { action, result: 'failed', error: (error as Error).message };
    }
  }

  return async function handle(event: RealtimeEvent): Promise<void> {
    if (!event.type.startsWith('engine.')) return;
    // Engines of stations that aren't in the database (tests, a stale container) are ignored.
    if (!uuidSchema.safeParse(event.stationId).success) return;
    const scope = await repo.stationScopeById(db, event.stationId);
    if (!scope) return;

    switch (event.type) {
      case 'engine.blank.detected': {
        const settings = await repo.getSilenceSettings(db, scope);
        const acts = settings.action !== 'none';
        const result = await alerts.raise(scope, {
          type: alertTypes.silence,
          severity: acts ? 'warning' : 'critical',
          dedupeKey: alertTypes.silence,
          title: 'Silence on air',
          message: `The program output has been silent for ${settings.maxSeconds} s (below ${settings.thresholdDb} dBFS).`,
          details: { bootId: event.data.bootId, detectedAt: event.at },
          ...(acts
            ? { escalate: { afterSeconds: settings.escalateAfterSeconds, to: 'critical' } }
            : {}),
        });
        if (result.kind !== 'raised') return;
        const outcome = await runSilenceAction(event.stationId, settings.action);
        await repo.mergeAlertDetails(db, scope, result.alert.id, { action: outcome });
        return;
      }
      case 'engine.blank.recovered':
        await alerts.resolve(scope, alertTypes.silence, { reason: 'recovered' });
        return;
      case 'engine.booted':
        await alerts.resolve(scope, alertTypes.silence, { reason: 'engine_restarted' });
        return;
      case 'engine.down':
        await alerts.raise(scope, {
          type: alertTypes.engineDown,
          severity: 'critical',
          dedupeKey: alertTypes.engineDown,
          title: 'Engine not responding',
          message: `The station engine stopped answering its health check (${event.data.reason}). The stream may be off air.`,
          details: { reason: event.data.reason, bootId: event.data.bootId },
        });
        return;
      case 'engine.up':
        await alerts.resolve(scope, alertTypes.engineDown, { reason: 'engine_up' });
        return;
      default:
        return;
    }
  };
}
