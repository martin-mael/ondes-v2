import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import {
  type ClockMusicSource,
  type ClockResolver,
  gridClockResolver,
  noClockMusic,
} from './fallback.ts';
import { createEpisodeCheckService, type EpisodeCheckService } from './service.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** Missing-episode alerts and fallbacks (#47): the steps the worker recorded, worked off. */
    episodeCheck: EpisodeCheckService;
  }
}

export type EpisodeCheckPluginOptions = {
  /** For the `clock_music` fallback. Default: the station's clock grid (#40). */
  resolveClock?: ClockResolver;
  /** #50's clock music, for the `clock_music` fallback. Default: none (stub). */
  clockMusic?: ClockMusicSource;
  /** How often pending steps are worked off. Default 15 s; 0 turns it off (tests). */
  intervalMs?: number;
};

/**
 * Missing-episode alerts and fallbacks (#47, ADR 0022): decorates `app.episodeCheck` and runs
 * its sweep on every replica (claims are `SKIP LOCKED`): pending steps every tick, the
 * reconcile (alerts to resolve, episodes to restore) every fourth. Registered after alerts.
 */
export const episodeCheckPlugin = fp(
  async (app: FastifyInstance, options: EpisodeCheckPluginOptions) => {
    const service = createEpisodeCheckService({
      db: app.db,
      alerts: app.alerts,
      mailer: app.mailer,
      appUrl: app.auth.config.appUrl,
      logger: app.log,
      logEvents: app.hasDecorator('rabbit') ? app.rabbit.events : undefined,
      fallback: {
        resolveClock: options.resolveClock ?? gridClockResolver(app.db),
        clockMusic: options.clockMusic ?? noClockMusic,
      },
    });
    app.decorate('episodeCheck', service);

    const intervalMs = options.intervalMs ?? 15_000;
    if (intervalMs > 0) {
      let running = false;
      let tick = 0;
      const timer = setInterval(() => {
        if (running) return;
        running = true;
        (async () => {
          await service.processPending();
          if (tick++ % 4 === 0) await service.reconcile();
        })()
          .catch((err: unknown) => app.log.error({ err }, 'episode check sweep failed'))
          .finally(() => {
            running = false;
          });
      }, intervalMs);
      timer.unref();
      app.addHook('onClose', async () => clearInterval(timer));
    }
  },
  { name: 'episode-check', dependencies: ['alerts', 'mail', 'auth'] },
);
