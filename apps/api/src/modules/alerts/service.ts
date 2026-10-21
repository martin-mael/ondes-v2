import { randomUUID } from 'node:crypto';
import { auditDiff, type Db, getStation, type StationScope, withAudit } from '@ondes/db';
import type {
  Actor,
  Alert,
  AlertRealtimeEvent,
  AlertSeverity,
  AlertSnapshot,
  RaiseAlert,
  SilenceSettings,
  UpdateSilenceSettings,
} from '@ondes/shared';
import { type Mailer, sendTemplate } from '../../plugins/mail.ts';
import type { Logger } from '../engine/adapter/index.ts';
import { criticalAlertTemplate } from './emails.ts';
import * as repo from './repo.ts';

/**
 * The alert framework (#33), as other modules use it: raise, resolve, acknowledge, escalate.
 * It writes the alert, publishes `alert.*` on the real-time fanout, and emails the station's
 * alert managers when an alert becomes critical (raised critical, or escalated to it).
 *
 * Inside the api, use `app.alerts` (plugin.ts). Publishing and email failures are logged,
 * never thrown: the alert row is the source of truth.
 */
export type AlertService = {
  raise(scope: StationScope, input: RaiseAlert): Promise<repo.RaiseResult>;
  /** Resolves the open alert with this key. Null if none was open. */
  resolve(
    scope: StationScope,
    dedupeKey: string,
    options?: { reason?: string },
  ): Promise<Alert | null>;
  /** A user closes an alert by hand (API, audited). Null if it was already resolved. */
  resolveById(scope: StationScope, actor: Actor, alertId: string): Promise<Alert | null>;
  /** A user says "on it" (API, audited). Null if already acknowledged or resolved. */
  acknowledge(scope: StationScope, actor: Actor, alertId: string): Promise<Alert | null>;
  /** Applies the time-based escalations that are due. Run periodically by the plugin. */
  escalateDue(): Promise<number>;
  /** Saves a station's silence settings (API, audited) and tells the fanout (#35 re-renders). */
  updateSilenceSettings(
    scope: StationScope,
    actor: Actor,
    patch: UpdateSilenceSettings,
  ): Promise<SilenceSettings>;
};

export type AlertServiceOptions = {
  db: Db;
  /** Real-time publisher (the api's RabbitMQ events). Omitted: nothing is published. */
  publish?: (event: AlertRealtimeEvent) => Promise<void>;
  mailer: Mailer;
  /** Web app base URL, for links in emails. */
  appUrl: string;
  logger: Logger;
  now?: () => Date;
};

export function createAlertService(options: AlertServiceOptions): AlertService {
  const { db, mailer, appUrl, logger } = options;
  const now = options.now ?? (() => new Date());

  async function publish(event: AlertRealtimeEvent) {
    if (!options.publish) return;
    try {
      await options.publish(event);
    } catch (error) {
      logger.warn(
        { err: error, type: event.type, stationId: event.stationId },
        'Alert event publish failed',
      );
    }
  }

  const envelope = (scope: StationScope) => ({
    id: randomUUID(),
    stationId: scope.stationId,
    at: now().toISOString(),
  });

  async function notify(scope: StationScope, alert: Alert, escalated: boolean) {
    try {
      const [station, recipients] = await Promise.all([
        getStation(db, scope, scope.stationId),
        repo.alertRecipients(db, scope),
      ]);
      const link = `${appUrl}/stations/${scope.stationId}/alerts/${alert.id}`;
      await Promise.all(
        recipients.map((r) =>
          sendTemplate(mailer, r.email, criticalAlertTemplate, {
            name: r.name,
            stationName: station.name,
            alert,
            escalated,
            link,
          }),
        ),
      );
    } catch (error) {
      logger.error({ err: error, alertId: alert.id }, 'Alert email failed');
    }
  }

  async function escalated(scope: StationScope, alert: Alert, previousSeverity: AlertSeverity) {
    await publish({
      ...envelope(scope),
      type: 'alert.escalated',
      data: { ...snapshot(alert), previousSeverity },
    });
    if (alert.severity === 'critical') await notify(scope, alert, true);
  }

  return {
    async raise(scope, input) {
      const result = await repo.raiseAlert(db, scope, input, now());
      if (result.kind === 'raised') {
        logger.warn(
          { stationId: scope.stationId, type: result.alert.type, severity: result.alert.severity },
          'Alert raised',
        );
        await publish({ ...envelope(scope), type: 'alert.raised', data: snapshot(result.alert) });
        if (result.alert.severity === 'critical') await notify(scope, result.alert, false);
      } else if (result.kind === 'escalated') {
        await escalated(scope, result.alert, result.previousSeverity);
      }
      return result;
    },

    async resolve(scope, dedupeKey, opts = {}) {
      const alert = await repo.resolveAlert(
        db,
        scope,
        dedupeKey,
        opts.reason ?? 'recovered',
        now(),
      );
      if (alert) {
        logger.info({ stationId: scope.stationId, type: alert.type }, 'Alert resolved');
        await publish({ ...envelope(scope), type: 'alert.resolved', data: snapshot(alert) });
      }
      return alert;
    },

    async resolveById(scope, actor, alertId) {
      const alert = await withAudit(db, { actor, scope }, async (tx, audit) => {
        const row = await repo.resolveAlertById(tx, scope, alertId, 'manual', now());
        if (!row) throw NOTHING_CHANGED;
        await audit({ action: 'alert.resolve', entity: { type: 'alert', id: alertId } });
        return row;
      }).catch(unlessNothingChanged);
      if (alert)
        await publish({ ...envelope(scope), type: 'alert.resolved', data: snapshot(alert) });
      return alert;
    },

    async acknowledge(scope, actor, alertId) {
      const userId = actor.type === 'user' ? actor.userId : null;
      const alert = await withAudit(db, { actor, scope }, async (tx, audit) => {
        const row = await repo.acknowledgeAlert(tx, scope, alertId, userId, now());
        if (!row) throw NOTHING_CHANGED;
        await audit({ action: 'alert.acknowledge', entity: { type: 'alert', id: alertId } });
        return row;
      }).catch(unlessNothingChanged);
      if (alert) {
        await publish({ ...envelope(scope), type: 'alert.acknowledged', data: snapshot(alert) });
      }
      return alert;
    },

    async escalateDue() {
      const due = await repo.escalateDue(db, now());
      for (const { scope, alert, previousSeverity } of due) {
        await escalated(scope, alert, previousSeverity);
      }
      return due.length;
    },

    async updateSilenceSettings(scope, actor, patch) {
      const settings = await withAudit(db, { actor, scope }, async (tx, audit) => {
        const { before, after } = await repo.updateSilenceSettings(tx, scope, patch);
        await audit({
          action: 'silence_setting.update',
          entity: { type: 'silence_setting', id: scope.stationId },
          diff: auditDiff(before, after),
        });
        return after;
      });
      await publish({ ...envelope(scope), type: 'alert.silence_settings.updated', data: settings });
      return settings;
    },
  };
}

/** Rolls back an audited mutation that turned out to change nothing (no audit row). */
const NOTHING_CHANGED = Symbol('nothing changed');
function unlessNothingChanged(error: unknown): null {
  if (error === NOTHING_CHANGED) return null;
  throw error;
}

export function snapshot(alert: Alert): AlertSnapshot {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    alertId: alert.id,
    type: alert.type,
    severity: alert.severity,
    status: alert.status,
    dedupeKey: alert.dedupeKey,
    title: alert.title,
    message: alert.message,
    details: alert.details,
    occurrences: alert.occurrences,
    raisedAt: alert.raisedAt.toISOString(),
    acknowledgedAt: iso(alert.acknowledgedAt),
    acknowledgedBy: alert.acknowledgedBy,
    resolvedAt: iso(alert.resolvedAt),
    resolution: alert.resolution,
  };
}
