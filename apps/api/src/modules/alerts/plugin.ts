import type { EventSubscription } from '@ondes/queue';
import { realtimeEventSchema } from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { createEngineAlertHandler, type SilenceActionEngine } from './engine-alerts.ts';
import { alertRoutes } from './routes.ts';
import { type AlertService, createAlertService } from './service.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** The alert framework (#33): `app.alerts.raise(scope, …)` / `resolve(scope, key)`. */
    alerts: AlertService;
  }
}

export type AlertsPluginOptions = {
  /** The station's engine adapter, for the silence action (wired from #35's registry). */
  engineFor?: (stationId: string) => SilenceActionEngine | undefined;
  /** How often due escalations are applied. Default 5 s; 0 turns the sweep off (tests). */
  escalationIntervalMs?: number;
};

/**
 * Alerts (#33): decorates `app.alerts`, mounts the API under `/api/v1`, turns engine events
 * from the RabbitMQ fanout into alerts (when `app.rabbit` is registered) and runs the
 * escalation sweep.
 */
export const alertsPlugin = fp(
  async (app: FastifyInstance, options: AlertsPluginOptions) => {
    const rabbit = app.hasDecorator('rabbit') ? app.rabbit : undefined;
    const alerts = createAlertService({
      db: app.db,
      publish: rabbit ? (event) => rabbit.events.publish(event) : undefined,
      mailer: app.mailer,
      appUrl: app.auth.config.appUrl,
      logger: app.log,
    });
    app.decorate('alerts', alerts);
    await app.register(alertRoutes, { prefix: '/api/v1' });

    let subscription: EventSubscription | undefined;
    if (rabbit) {
      const handle = createEngineAlertHandler({
        db: app.db,
        alerts,
        engineFor: options.engineFor,
        logger: app.log,
      });
      app.addHook('onReady', async () => {
        subscription = rabbit.subscribeEvents(async (raw) => {
          const parsed = realtimeEventSchema.safeParse(raw);
          if (!parsed.success) return;
          try {
            await handle(parsed.data);
          } catch (error) {
            app.log.error({ err: error, type: parsed.data.type }, 'Engine alert handling failed');
          }
        });
        await subscription.ready;
      });
    }

    const intervalMs = options.escalationIntervalMs ?? 5000;
    let timer: NodeJS.Timeout | undefined;
    let sweeping = false;
    if (intervalMs > 0) {
      app.addHook('onReady', async () => {
        timer = setInterval(async () => {
          if (sweeping) return;
          sweeping = true;
          try {
            await alerts.escalateDue();
          } catch (error) {
            app.log.error({ err: error }, 'Alert escalation sweep failed');
          } finally {
            sweeping = false;
          }
        }, intervalMs);
        timer.unref();
      });
    }

    app.addHook('onClose', async () => {
      clearInterval(timer);
      await subscription?.close();
    });
  },
  { name: 'alerts', dependencies: ['db', 'mail', 'auth'] },
);
