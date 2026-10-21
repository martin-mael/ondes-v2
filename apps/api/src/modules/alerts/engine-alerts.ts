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

/** The engine commands the silence action and the reconcile need. */
export type AlertEngine = Pick<EngineAdapter, 'skip' | 'clear' | 'state'>;

/** Silence action -> alert action name. */
export const silenceActions = {
  skip: 'engine.skip',
  safety: 'engine.safety',
} as const satisfies Record<Exclude<SilenceAction, 'none'>, string>;

export type EngineLookup = (
  stationId: string,
) => AlertEngine | undefined | Promise<AlertEngine | undefined>;

export type EngineAlertsOptions = {
  db: Db;
  alerts: AlertService;
  /**
   * The station's engine adapter, if this process can reach it: #35's
   * `app.engineLifecycle.adapterFor(stationId)` (any replica on the engine network).
   */
  engineFor?: EngineLookup;
  logger: Logger;
};

/**
 * Engine events (#28) -> alerts. Runs from the durable `alerts` consumer (one api replica at
 * a time, events in order per station, deduplicated on the event id):
 *
 * - `engine.blank.detected`: raise `engine.silence` with the station's silence action. With an
 *   action, the alert is a warning that escalates to critical after `escalateAfterSeconds` of
 *   continued silence; without one, critical at once.
 * - `engine.blank.recovered`, `engine.booted`: resolve it (a new boot has a fresh detector,
 *   which fires again if it is still silent).
 * - `engine.down` / `engine.up`: raise / resolve `engine.down`.
 *
 * Late events are ignored rather than applied out of order: an event from an older engine boot
 * than the newest one seen, a raise older than the key's last resolve, a resolve older than
 * the last raise. The action itself is registered with the alert service, so it runs on a
 * replica that holds the station's engine, once (claimed in the database), and only while
 * the alert is still open.
 */
export function createEngineAlerts(options: EngineAlertsOptions) {
  const { db, alerts, logger } = options;
  const engineFor: EngineLookup = options.engineFor ?? (() => undefined);

  async function requireEngine(stationId: string): Promise<AlertEngine> {
    const engine = await engineFor(stationId);
    if (!engine) throw new Error('engine not available on this replica');
    return engine;
  }

  alerts.registerAction(silenceActions.skip, {
    available: async (stationId) => (await engineFor(stationId)) !== undefined,
    async run(scope) {
      await (await requireEngine(scope.stationId)).skip();
    },
  });
  alerts.registerAction(silenceActions.safety, {
    available: async (stationId) => (await engineFor(stationId)) !== undefined,
    async run(scope) {
      // An empty queue makes the engine's fallback pick the safety playlist; the skip ends the
      // silent item now instead of at its end.
      const engine = await requireEngine(scope.stationId);
      await engine.clear();
      await engine.skip();
    },
  });

  async function handle(event: RealtimeEvent): Promise<void> {
    if (!event.type.startsWith('engine.')) return;
    // Engines of stations that aren't in the database (tests, a stale container) are ignored.
    if (!uuidSchema.safeParse(event.stationId).success) return;
    const scope = await repo.stationScopeById(db, event.stationId);
    if (!scope) return;
    const at = new Date(event.at);
    const opts = { eventId: event.id, occurredAt: at };

    switch (event.type) {
      case 'engine.booted':
        await repo.noteEngineBoot(db, scope, event.data.bootId, at);
        await alerts.resolve(scope, alertTypes.silence, { ...opts, reason: 'engine_restarted' });
        return;
      case 'engine.blank.detected': {
        if (await repo.isStaleBoot(db, scope, event.data.bootId, at)) return;
        const settings = await repo.getSilenceSettings(db, scope);
        const action = settings.action === 'none' ? undefined : silenceActions[settings.action];
        await alerts.raise(
          scope,
          {
            type: alertTypes.silence,
            severity: action ? 'warning' : 'critical',
            dedupeKey: alertTypes.silence,
            title: 'Silence on air',
            message: `The program output has been silent for ${settings.maxSeconds} s (below ${settings.thresholdDb} dBFS).`,
            details: { bootId: event.data.bootId, detectedAt: event.at },
            action,
            ...(action
              ? { escalate: { afterSeconds: settings.escalateAfterSeconds, to: 'critical' } }
              : {}),
          },
          opts,
        );
        return;
      }
      case 'engine.blank.recovered':
        if (await repo.isStaleBoot(db, scope, event.data.bootId, at)) return;
        await alerts.resolve(scope, alertTypes.silence, { ...opts, reason: 'recovered' });
        return;
      case 'engine.down':
        await alerts.raise(
          scope,
          {
            type: alertTypes.engineDown,
            severity: 'critical',
            dedupeKey: alertTypes.engineDown,
            title: 'Engine not responding',
            message: `The station engine stopped answering its health check (${event.data.reason}). The stream may be off air.`,
            details: { reason: event.data.reason, bootId: event.data.bootId },
          },
          opts,
        );
        return;
      case 'engine.restart_storm':
        await alerts.raise(
          scope,
          {
            type: alertTypes.engineRestartStorm,
            severity: 'critical',
            dedupeKey: alertTypes.engineRestartStorm,
            title: 'Engine crash loop: restarts stopped',
            message: `The station engine restarted ${event.data.restarts} times in ${event.data.windowSeconds} s, so the lifecycle stopped restarting it. It stays off air until someone restarts it.`,
            details: { restarts: event.data.restarts, windowSeconds: event.data.windowSeconds },
          },
          opts,
        );
        return;
      case 'engine.up':
        await repo.noteEngineBoot(db, scope, event.data.bootId, at);
        await alerts.resolve(scope, alertTypes.engineDown, { ...opts, reason: 'engine_up' });
        // A healthy engine after a storm means someone restarted it: the loop is over.
        await alerts.resolve(scope, alertTypes.engineRestartStorm, {
          ...opts,
          reason: 'engine_up',
        });
        return;
      default:
        return;
    }
  }

  /**
   * Closes engine alerts whose recovery event was lost (a message dropped while no api ran):
   * asks the station's engine, if this process can reach it, about alerts not seen for
   * `quietMs`. Answering at all resolves `engine.down`; not being blank resolves
   * `engine.silence`.
   */
  async function reconcile(quietMs = 30_000): Promise<number> {
    const quiet = await repo.quietOpenAlerts(
      db,
      [alertTypes.silence, alertTypes.engineDown],
      new Date(Date.now() - quietMs),
    );
    let resolved = 0;
    for (const { scope, alert } of quiet) {
      const engine = await engineFor(scope.stationId);
      if (!engine) continue;
      let blank: boolean;
      try {
        blank = (await engine.state()).blank;
      } catch {
        continue; // Still down, or unreachable: the health monitor reports it.
      }
      if (alert.type === alertTypes.silence && blank) continue;
      const closed = await alerts.resolve(scope, alert.dedupeKey, { reason: 'reconciled' });
      if (closed) {
        resolved++;
        logger.info({ stationId: scope.stationId, type: alert.type }, 'Alert reconciled');
      }
    }
    return resolved;
  }

  return { handle, reconcile };
}
