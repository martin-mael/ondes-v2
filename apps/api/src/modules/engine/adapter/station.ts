import type { EngineRealtimeEvent, EngineState } from '@ondes/shared';
import { createEngineAdapter, type EngineAdapter, type EngineAdapterOptions } from './adapter.ts';
import {
  createEngineHealthMonitor,
  type EngineHealthMonitor,
  type EngineHealthMonitorOptions,
} from './health.ts';
import { createEngineEventIngest, type EngineEventIngest, type ResyncReason } from './ingest.ts';
import { type Logger, silentLogger } from './logger.ts';

/**
 * Everything the api runs for one station's engine: the command adapter, the event ingest
 * and the health monitor, wired so that an engine coming back up (or restarting) triggers
 * an event catch-up and a state reconcile.
 */
export type StationEngine = {
  readonly stationId: string;
  readonly adapter: EngineAdapter;
  readonly ingest: EngineEventIngest;
  readonly health: EngineHealthMonitor;
  start(): void;
  stop(): void;
};

export type StationEngineOptions = EngineAdapterOptions & {
  /** Real-time publisher, e.g. the api's RabbitMQ `events.publish`. */
  publish(event: EngineRealtimeEvent): Promise<void>;
  /** Engine state after a restart, a gap or a catch-up, for the feeder (#29). */
  onResync?(state: EngineState, reason: ResyncReason): void | Promise<void>;
  health?: Pick<EngineHealthMonitorOptions, 'intervalMs' | 'downAfter'>;
  logger?: Logger;
};

export function createStationEngine(options: StationEngineOptions): StationEngine {
  const { stationId, publish, onResync } = options;
  const logger = options.logger ?? silentLogger;
  const adapter = createEngineAdapter(options);
  const ingest = createEngineEventIngest({ stationId, engine: adapter, publish, onResync, logger });
  const health = createEngineHealthMonitor({
    ...options.health,
    stationId,
    engine: adapter,
    publish,
    logger,
    async onUp() {
      try {
        await ingest.catchUp();
      } catch (error) {
        logger.warn({ stationId, err: error }, 'Engine event catch-up failed');
      }
    },
  });
  return {
    stationId,
    adapter,
    ingest,
    health,
    start: () => health.start(),
    stop: () => health.stop(),
  };
}

/** The api's station engines, by station id. The events route looks ingests up here. */
export class StationEngines {
  readonly #engines = new Map<string, StationEngine>();

  add(engine: StationEngine): void {
    this.#engines.get(engine.stationId)?.stop();
    this.#engines.set(engine.stationId, engine);
  }

  get(stationId: string): StationEngine | undefined {
    return this.#engines.get(stationId);
  }

  remove(stationId: string): void {
    this.#engines.get(stationId)?.stop();
    this.#engines.delete(stationId);
  }

  startAll(): void {
    for (const engine of this.#engines.values()) engine.start();
  }

  stopAll(): void {
    for (const engine of this.#engines.values()) engine.stop();
  }

  ingestFor = (stationId: string): EngineEventIngest | undefined =>
    this.#engines.get(stationId)?.ingest;
}
