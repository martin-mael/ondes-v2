import { randomUUID } from 'node:crypto';
import type { EngineHealth, EngineRealtimeEvent } from '@ondes/shared';
import type { EngineAdapter } from './adapter.ts';
import { EngineError } from './errors.ts';
import { type Logger, silentLogger } from './logger.ts';

/**
 * Engine up/down detection for one station: polls `GET /v1/health` and publishes
 * `engine.up` / `engine.down` on transitions. Engine liveness isn't a wire event (a dead
 * engine can't report its own death), so it is the adapter's job (ADR 0002).
 *
 * - `engine.up` when the first probe succeeds, when probes succeed again after a down, and
 *   when the `boot_id` changes (a restart faster than the down threshold).
 * - `engine.down` after `downAfter` consecutive failed probes (a single slow answer is not
 *   an outage).
 * Probes never overlap: the next one is scheduled when the previous one settles.
 */
export type EngineStatus = 'unknown' | 'up' | 'down';

export type EngineHealthMonitor = {
  start(): void;
  stop(): void;
  /** Runs one probe now (used by `start` and by tests). */
  probe(): Promise<EngineStatus>;
  status(): EngineStatus;
  /** Last health answer, null until the first successful probe. */
  last(): EngineHealth | null;
};

export type EngineHealthMonitorOptions = {
  stationId: string;
  engine: Pick<EngineAdapter, 'health'>;
  publish(event: EngineRealtimeEvent): Promise<void>;
  /**
   * Called when the engine is (back) up or reports a new boot, after `engine.up` is
   * published. The station wiring uses it to catch up on events. Errors are logged.
   */
  onUp?(health: EngineHealth, change: { previous: EngineStatus; bootChanged: boolean }): unknown;
  /** Delay between probes. Default 2 s. */
  intervalMs?: number;
  /** Consecutive failures before `engine.down`. Default 3. */
  downAfter?: number;
  now?: () => Date;
  logger?: Logger;
};

export function createEngineHealthMonitor(
  options: EngineHealthMonitorOptions,
): EngineHealthMonitor {
  const { stationId, engine } = options;
  const intervalMs = options.intervalMs ?? 2_000;
  const downAfter = options.downAfter ?? 3;
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? silentLogger;

  let status: EngineStatus = 'unknown';
  let last: EngineHealth | null = null;
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let inFlight: Promise<EngineStatus> | null = null;

  async function publish(event: EngineRealtimeEvent): Promise<void> {
    try {
      await options.publish(event);
    } catch (error) {
      logger.error({ stationId, type: event.type, err: error }, 'Publishing engine status failed');
    }
  }

  async function runProbe(): Promise<EngineStatus> {
    let health: EngineHealth;
    try {
      health = await engine.health();
    } catch (error) {
      failures++;
      if (failures >= downAfter && status !== 'down') {
        const previous = status;
        status = 'down';
        const reason =
          error instanceof EngineError
            ? error.status
              ? `http_${error.status}`
              : error.code
            : 'error';
        logger.warn({ stationId, previous, reason }, 'Engine down');
        await publish({
          id: randomUUID(),
          type: 'engine.down',
          stationId,
          at: now().toISOString(),
          data: { bootId: last?.boot_id ?? null, reason },
        });
      }
      return status;
    }

    failures = 0;
    const previous = status;
    const bootChanged = last !== null && last.boot_id !== health.boot_id;
    last = health;
    if (previous !== 'up' || bootChanged) {
      status = 'up';
      logger.info({ stationId, previous, bootId: health.boot_id, bootChanged }, 'Engine up');
      await publish({
        id: randomUUID(),
        type: 'engine.up',
        stationId,
        at: now().toISOString(),
        data: { bootId: health.boot_id, version: health.version },
      });
      try {
        await options.onUp?.(health, { previous, bootChanged });
      } catch (error) {
        logger.warn({ stationId, err: error }, 'Engine up callback failed');
      }
    }
    return status;
  }

  function probe(): Promise<EngineStatus> {
    inFlight ??= runProbe().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function loop(): void {
    if (!running) return;
    void probe().finally(() => {
      if (!running) return;
      timer = setTimeout(loop, intervalMs);
      timer.unref();
    });
  }

  return {
    start() {
      if (running) return;
      running = true;
      loop();
    },
    stop() {
      running = false;
      clearTimeout(timer);
    },
    probe,
    status: () => status,
    last: () => last,
  };
}
