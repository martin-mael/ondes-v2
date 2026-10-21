import { PostgresJobRunStore, type StationScope } from '@ondes/db';
import {
  consumeEventsDurable,
  createJobWorker,
  type EventSubscription,
  type JobWorker,
} from '@ondes/queue';
import { type RealtimeEvent, realtimeEventSchema, type SilenceSettings } from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { alertEmailJob, alertEmailJobType } from './email-job.ts';
import { type AlertEngine, createEngineAlerts } from './engine-alerts.ts';
import { pruneSeenEvents } from './repo.ts';
import { alertRoutes } from './routes.ts';
import { type AlertService, createAlertService } from './service.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** The alert framework (#33): `app.alerts.raise(scope, …)` / `resolve(scope, key)`. */
    alerts: AlertService;
  }
}

/** Name of the durable event queue the alert side effects run from (ADR 0006). */
export const ALERTS_EVENT_QUEUE = 'alerts';

export type AlertsPluginOptions = {
  /** The station's engine adapter, if this replica holds it (#35's `app.stationEngines`). */
  engineFor?: (stationId: string) => AlertEngine | undefined;
  /** After a silence settings change: reconcile the station's engine (#35). */
  onSilenceSettingsUpdated?: (scope: StationScope, settings: SilenceSettings) => Promise<void>;
  /**
   * How often the sweep runs: due escalations, pending actions, reconcile. Default 5 s;
   * 0 turns it off (tests).
   */
  sweepIntervalMs?: number;
  /** Reconcile engine alerts not seen for this long. Default 30 s. */
  reconcileQuietMs?: number;
  reopenWithinSeconds?: number;
  emailCooldownSeconds?: number;
  /** Durable queue name (tests use their own). Default `alerts`. */
  eventQueue?: string;
};

/**
 * Alerts (#33): decorates `app.alerts` and mounts the API under `/api/v1`. With RabbitMQ:
 * - engine events reach the alerts through a durable, single-active-consumer queue
 *   (`consumeEventsDurable`): one replica at a time, in order per station, nothing lost
 *   across restarts;
 * - alert emails are `alert-email` jobs on the `notify` lane, consumed here;
 * - `alert.raised` / `reopened` / `escalated` on the fanout make every replica try the
 *   pending actions it can run (it holds the station's engine). The sweep is the fallback.
 */
export const alertsPlugin = fp(
  async (app: FastifyInstance, options: AlertsPluginOptions) => {
    const rabbit = app.hasDecorator('rabbit') ? app.rabbit : undefined;
    const alerts = createAlertService({
      db: app.db,
      publish: rabbit ? (event) => rabbit.events.publish(event) : undefined,
      enqueueEmail: rabbit
        ? async (job, scope) => {
            await rabbit.jobs.enqueue(alertEmailJobType, job, {
              orgId: scope.orgId,
              stationId: scope.stationId,
            });
          }
        : undefined,
      mailer: app.mailer,
      appUrl: app.auth.config.appUrl,
      logger: app.log,
      reopenWithinSeconds: options.reopenWithinSeconds,
      emailCooldownSeconds: options.emailCooldownSeconds,
      onSilenceSettingsUpdated: options.onSilenceSettingsUpdated,
    });
    app.decorate('alerts', alerts);
    await app.register(alertRoutes, { prefix: '/api/v1' });
    const engineAlerts = createEngineAlerts({
      db: app.db,
      alerts,
      engineFor: options.engineFor,
      logger: app.log,
    });

    let consumer: EventSubscription | undefined;
    let fanout: EventSubscription | undefined;
    let emailWorker: JobWorker | undefined;
    if (rabbit) {
      const { rabbit: connection, topology } = rabbit.queue;
      app.addHook('onReady', async () => {
        consumer = consumeEventsDurable(
          connection,
          topology,
          options.eventQueue ?? ALERTS_EVENT_QUEUE,
          realtimeEventSchema,
          (event) => engineAlerts.handle(event),
          {
            keyOf: (event: RealtimeEvent) => event.stationId,
            onError: (error, event) => {
              // Events of other domains this api doesn't know yet are skipped, not errors.
              if (!event) app.log.debug({ err: error }, 'Alerts consumer skipped a message');
              else app.log.error({ err: error, type: event.type }, 'Alert event handling failed');
            },
          },
        );
        fanout = rabbit.subscribeEvents(async (raw) => {
          const type = (raw as { type?: unknown } | null)?.type;
          const stationId = (raw as { stationId?: unknown } | null)?.stationId;
          if (
            typeof stationId === 'string' &&
            (type === 'alert.raised' || type === 'alert.reopened' || type === 'alert.escalated')
          ) {
            await alerts.runPendingActions(stationId).catch((error: unknown) => {
              app.log.error({ err: error, stationId }, 'Alert actions failed');
            });
          }
        });
        emailWorker = createJobWorker({
          rabbit: connection,
          topology,
          store: new PostgresJobRunStore(app.db),
          jobs: [alertEmailJob(alerts)],
          lanes: ['notify'],
          logger: app.log,
        });
        await Promise.all([consumer.ready, fanout.ready, emailWorker.ready]);
      });
    }

    const intervalMs = options.sweepIntervalMs ?? 5000;
    const reconcileEvery = Math.max(1, Math.round(30_000 / Math.max(intervalMs, 1)));
    let timer: NodeJS.Timeout | undefined;
    let sweeping = false;
    let tick = 0;
    async function sweep() {
      if (sweeping) return;
      sweeping = true;
      try {
        await alerts.escalateDue();
        await alerts.runPendingActions();
        if (tick % reconcileEvery === 0) await engineAlerts.reconcile(options.reconcileQuietMs);
        if (tick % (reconcileEvery * 120) === 0) {
          await pruneSeenEvents(app.db, new Date(Date.now() - 24 * 3600 * 1000));
        }
      } catch (error) {
        app.log.error({ err: error }, 'Alert sweep failed');
      } finally {
        tick++;
        sweeping = false;
      }
    }
    if (intervalMs > 0) {
      app.addHook('onReady', async () => {
        timer = setInterval(() => void sweep(), intervalMs);
        timer.unref();
      });
    }

    app.addHook('onClose', async () => {
      clearInterval(timer);
      await consumer?.close();
      await fanout?.close();
      await emailWorker?.close();
    });
  },
  { name: 'alerts', dependencies: ['db', 'mail', 'auth'] },
);
