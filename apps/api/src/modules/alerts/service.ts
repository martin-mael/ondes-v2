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
 * The alert framework (#33), as other modules use it: raise, resolve, acknowledge, escalate,
 * and automatic actions. It writes the alert, publishes `alert.*` on the real-time fanout
 * (best effort, for the UI), and emails the station's alert managers when an alert becomes
 * critical: through the durable `alert-email` job when the api has RabbitMQ, inline otherwise.
 *
 * Inside the api, use `app.alerts` (plugin.ts). Publishing failures are logged, never
 * thrown: the alert row is the source of truth.
 */
export type AlertService = {
  /**
   * Raises (or reopens, or bumps) an alert. `occurredAt`: when the problem was observed (an
   * event's time); a raise older than the key's last resolve is `stale` and ignored.
   * `eventId`: the event that caused it; the same event applied twice is a `duplicate`.
   */
  raise(scope: StationScope, input: RaiseAlert, options?: EventOptions): Promise<RaiseOutcome>;
  /** Resolves the open alert with this key. Null if none was open (or the resolve is stale). */
  resolve(
    scope: StationScope,
    dedupeKey: string,
    options?: EventOptions & { reason?: string },
  ): Promise<Alert | null>;
  /** Records an event as applied without raising or resolving. False on a redelivery. */
  claimEvent(eventId: string, stationId: string): Promise<boolean>;
  /** A user closes an alert by hand (API, audited). Null if it was already resolved. */
  resolveById(scope: StationScope, actor: Actor, alertId: string): Promise<Alert | null>;
  /** A user says "on it" (API, audited). Null if already acknowledged or resolved. */
  acknowledge(scope: StationScope, actor: Actor, alertId: string): Promise<Alert | null>;
  /** Registers the runner of an automatic action (`RaiseAlert.action`), by name. */
  registerAction(name: string, runner: AlertActionRunner): void;
  /** Runs the pending actions this process can run (of one station, or all). */
  runPendingActions(stationId?: string): Promise<void>;
  /** Applies the time-based escalations that are due. Run periodically by the plugin. */
  escalateDue(): Promise<number>;
  /** The `alert-email` job's work: email the alert's managers once per severity. */
  sendEmail(job: AlertEmailJob): Promise<void>;
  /** Saves a station's silence settings (API, audited) and tells the engine lifecycle. */
  updateSilenceSettings(
    scope: StationScope,
    actor: Actor,
    patch: UpdateSilenceSettings,
  ): Promise<SilenceSettings>;
};

export type EventOptions = { occurredAt?: Date; eventId?: string };
export type RaiseOutcome = repo.RaiseResult | { kind: 'duplicate' };

/**
 * Runs an automatic action. `available` says whether this process can run it now for the
 * station (e.g. it can reach the station's engine): the action waits, recorded as
 * pending, for a replica that can. `run` throws on failure.
 */
export type AlertActionRunner = {
  available(stationId: string): boolean | Promise<boolean>;
  run(scope: StationScope, alert: Alert): Promise<void>;
};

export type AlertEmailJob = { alertId: string; severity: AlertSeverity; escalated: boolean };

export type AlertServiceOptions = {
  db: Db;
  /** Real-time publisher (the api's RabbitMQ events). Omitted: nothing is published. */
  publish?: (event: AlertRealtimeEvent) => Promise<void>;
  /** Durable email path (the `alert-email` job). Omitted: emails are sent inline. */
  enqueueEmail?: (job: AlertEmailJob, scope: StationScope) => Promise<void>;
  mailer: Mailer;
  /** Web app base URL, for links in emails. */
  appUrl: string;
  logger: Logger;
  /** A key resolved less than this long ago reopens instead of raising anew. Default 300. */
  reopenWithinSeconds?: number;
  /** No email for an alert if another of its (station, type) was emailed within. Default 900. */
  emailCooldownSeconds?: number;
  /** After a silence settings change (#35: reconcile the station's engine). */
  onSilenceSettingsUpdated?: (scope: StationScope, settings: SilenceSettings) => Promise<void>;
  now?: () => Date;
};

export function createAlertService(options: AlertServiceOptions): AlertService {
  const { db, mailer, appUrl, logger } = options;
  const now = options.now ?? (() => new Date());
  const reopenWithinMs = (options.reopenWithinSeconds ?? 300) * 1000;
  const cooldownMs = (options.emailCooldownSeconds ?? 900) * 1000;
  const runners = new Map<string, AlertActionRunner>();

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

  /** The alert just became critical: email its managers (once per alert and severity). */
  async function notify(scope: StationScope, alert: Alert, escalated: boolean) {
    // Acknowledged means someone is on it: escalation raises the severity, without email.
    if (escalated && alert.acknowledgedAt) return;
    const job: AlertEmailJob = { alertId: alert.id, severity: alert.severity, escalated };
    try {
      if (options.enqueueEmail) await options.enqueueEmail(job, scope);
      else await service.sendEmail(job);
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

  async function runAction(alertId: string, stationId: string, name: string) {
    const runner = runners.get(name);
    if (!runner || !(await runner.available(stationId))) return;
    const claimed = await repo.claimAction(db, alertId, now());
    if (!claimed) return;
    try {
      await runner.run(claimed.scope, claimed.alert);
      await repo.finishAction(db, alertId, { state: 'done', error: null }, now());
      logger.info({ stationId, alertId, action: name }, 'Alert action done');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await repo.finishAction(db, alertId, { state: 'failed', error: message }, now());
      logger.error({ err: error, stationId, alertId, action: name }, 'Alert action failed');
    }
  }

  async function inTransaction<T>(
    fn: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<T>,
  ) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await db.transaction(fn);
      } catch (error) {
        // A concurrent raise of the same key won: retry against its row.
        if (error !== repo.RAISE_RACE || attempt >= 3) throw error;
      }
    }
  }

  const service: AlertService = {
    async raise(scope, input, opts = {}) {
      const result = await inTransaction(async (tx): Promise<RaiseOutcome> => {
        if (opts.eventId && !(await repo.claimEvent(tx, opts.eventId, scope.stationId))) {
          return { kind: 'duplicate' };
        }
        return repo.raiseIn(tx, scope, input, {
          now: now(),
          occurredAt: opts.occurredAt,
          reopenWithinMs,
        });
      });
      if (result.kind === 'raised' || result.kind === 'reopened') {
        const { alert } = result;
        logger.warn(
          {
            stationId: scope.stationId,
            type: alert.type,
            severity: alert.severity,
            kind: result.kind,
          },
          'Alert raised',
        );
        await publish({
          ...envelope(scope),
          type: result.kind === 'raised' ? 'alert.raised' : 'alert.reopened',
          data: snapshot(alert),
        });
        if (alert.action) await runAction(alert.id, scope.stationId, alert.action.name);
        if (alert.severity === 'critical') await notify(scope, alert, false);
      } else if (result.kind === 'escalated') {
        await escalated(scope, result.alert, result.previousSeverity);
      }
      return result;
    },

    async resolve(scope, dedupeKey, opts = {}) {
      const result = await db.transaction(async (tx) => {
        if (opts.eventId && !(await repo.claimEvent(tx, opts.eventId, scope.stationId))) {
          return null;
        }
        return repo.resolveIn(tx, scope, dedupeKey, opts.reason ?? 'recovered', {
          now: now(),
          occurredAt: opts.occurredAt,
        });
      });
      if (result === 'stale') {
        logger.info({ stationId: scope.stationId, dedupeKey }, 'Stale resolve ignored');
        return null;
      }
      if (result) {
        logger.info({ stationId: scope.stationId, type: result.type }, 'Alert resolved');
        await publish({ ...envelope(scope), type: 'alert.resolved', data: snapshot(result) });
      }
      return result;
    },

    claimEvent: (eventId, stationId) => repo.claimEvent(db, eventId, stationId),

    async resolveById(scope, actor, alertId) {
      const alert = await withAudit(db, { actor, scope }, async (tx, audit) => {
        const row = await repo.resolveAlertById(tx, scope, alertId, 'manual', now());
        if (!row) throw NOTHING_CHANGED;
        await audit({ action: 'alert.resolve', entity: { type: 'alert', id: alertId } });
        return row;
      }).catch(unlessNothingChanged);
      if (alert) {
        await publish({ ...envelope(scope), type: 'alert.resolved', data: snapshot(alert) });
      }
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

    registerAction(name, runner) {
      runners.set(name, runner);
    },

    async runPendingActions(stationId) {
      for (const pending of await repo.pendingActions(db, stationId)) {
        await runAction(pending.alertId, pending.stationId, pending.name);
      }
    },

    async escalateDue() {
      const due = await repo.escalateDue(db, now());
      for (const { scope, alert, previousSeverity } of due) {
        await escalated(scope, alert, previousSeverity);
        // A failed action got one more attempt (repo.escalateDue put it back to pending).
        if (alert.action?.state === 'pending') {
          await runAction(alert.id, scope.stationId, alert.action.name);
        }
      }
      return due.length;
    },

    async sendEmail(job) {
      const found = await repo.findAlert(db, job.alertId);
      if (!found) return;
      const { scope, alert } = found;
      const suppress = (reason: string) =>
        repo.recordNotification(db, alert, job.severity, {
          email: '',
          status: 'suppressed',
          reason,
        });
      if (alert.status === 'resolved') return suppress('resolved');
      if (job.escalated && alert.acknowledgedAt) return suppress('acknowledged');
      const done = await repo.notificationsOf(db, alert.id, job.severity);
      if (done.suppressed) return;
      if (
        done.sent.size === 0 &&
        (await repo.emailedRecently(
          db,
          alert,
          job.severity,
          new Date(now().getTime() - cooldownMs),
        ))
      ) {
        return suppress('cooldown');
      }
      const [station, recipients] = await Promise.all([
        getStation(db, scope, scope.stationId),
        repo.alertRecipients(db, scope),
      ]);
      const link = `${appUrl}/stations/${scope.stationId}/alerts/${alert.id}`;
      for (const r of recipients) {
        if (done.sent.has(r.email)) continue;
        await sendTemplate(mailer, r.email, criticalAlertTemplate, {
          name: r.name,
          stationName: station.name,
          alert,
          escalated: job.escalated,
          link,
        });
        await repo.recordNotification(db, alert, job.severity, { email: r.email, status: 'sent' });
      }
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
      if (options.onSilenceSettingsUpdated) {
        await options.onSilenceSettingsUpdated(scope, settings).catch((error: unknown) => {
          logger.error({ err: error, stationId: scope.stationId }, 'Engine reconcile failed');
        });
      }
      return settings;
    },
  };
  return service;
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
    action: alert.action
      ? {
          name: alert.action.name,
          state: alert.action.state,
          attempts: alert.action.attempts,
          error: alert.action.error,
        }
      : null,
  };
}
