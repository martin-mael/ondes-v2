import type { StationScope } from '@ondes/db';
import { type RealtimeEvent, realtimeEventSchema } from '@ondes/shared';
import { type Logger, silentLogger } from '../adapter/logger.ts';
import {
  createStationFeeder,
  type FeederDeps,
  FeederNotOwnerError,
  type FeederOptions,
  type StationFeeder,
} from './feeder.ts';
import type { FeederLeases } from './leases.ts';

/**
 * Runs the feeders of this api process: one per station whose engine should run and whose
 * lease (leases.ts) this process holds. Every `leaseIntervalMs` it lists the stations, takes
 * the free leases and drops the stations that stopped; every `tickMs` it syncs each feeder;
 * engine and log events from the fanout sync the station's feeder right away.
 *
 * The fanout is best-effort (ADR 0006): a missed event only delays a sync to the next tick,
 * since each sync re-reads the engine state and the log. Only the lease holder acts on it, so
 * a side effect never runs once per replica.
 */
export type FeederService = {
  /** Lease round + one sync of each feeder; the timers call this too. */
  refresh(): Promise<void>;
  /** A real-time event (the api's fanout subscription). */
  onEvent(event: unknown): void;
  feeder(stationId: string): StationFeeder | undefined;
  start(): void;
  close(): Promise<void>;
};

export type FeederServiceOptions = {
  leases: FeederLeases;
  /** Stations whose engine should run (`listRunningStationScopes`). */
  stations(): Promise<StationScope[]>;
  /** Everything a station's feeder needs but its scope and ownership check. */
  depsFor(scope: StationScope): Omit<FeederDeps, 'scope' | 'owns' | 'logger' | 'options'>;
  options?: FeederOptions;
  /** Default 5 s. */
  tickMs?: number;
  /** Default 10 s. */
  leaseIntervalMs?: number;
  logger?: Logger;
};

export function createFeederService(options: FeederServiceOptions): FeederService {
  const { leases } = options;
  const logger = options.logger ?? silentLogger;
  const feeders = new Map<string, StationFeeder>();
  const timers: NodeJS.Timeout[] = [];
  let leasing: Promise<void> | null = null;
  let closed = false;

  function drop(stationId: string) {
    feeders.get(stationId)?.stop();
    feeders.delete(stationId);
  }

  async function sync(feeder: StationFeeder) {
    try {
      await feeder.sync();
    } catch (error) {
      if (error instanceof FeederNotOwnerError) {
        drop(feeder.stationId);
        return;
      }
      logger.warn({ err: error, stationId: feeder.stationId }, 'Feeder sync failed');
    }
  }

  async function leaseRound() {
    const scopes = await options.stations();
    const wanted = new Set(scopes.map((s) => s.stationId));
    for (const stationId of [...feeders.keys()]) {
      if (!wanted.has(stationId) || !leases.held().has(stationId)) {
        drop(stationId);
        await leases.release(stationId);
      }
    }
    for (const scope of scopes) {
      if (closed || feeders.has(scope.stationId)) continue;
      if (!(await leases.acquire(scope.stationId))) continue;
      logger.info({ stationId: scope.stationId }, 'Feeding the station from this api');
      const feeder = createStationFeeder({
        ...options.depsFor(scope),
        scope,
        owns: () => leases.holds(scope.stationId),
        logger,
        options: options.options,
      });
      feeders.set(scope.stationId, feeder);
      void sync(feeder);
    }
  }

  function lease(): Promise<void> {
    leasing ??= leaseRound()
      .catch((err: unknown) => logger.warn({ err }, 'Feeder lease round failed'))
      .finally(() => {
        leasing = null;
      });
    return leasing;
  }

  return {
    async refresh() {
      await lease();
      await Promise.all([...feeders.values()].map(sync));
    },

    onEvent(event) {
      const parsed = realtimeEventSchema.safeParse(event);
      if (!parsed.success) return;
      const e: RealtimeEvent = parsed.data;
      feeders.get(e.stationId)?.onEvent(e);
    },

    feeder: (stationId) => feeders.get(stationId),

    start() {
      const every = (ms: number, fn: () => unknown) => {
        const timer = setInterval(() => void fn(), ms);
        timer.unref();
        timers.push(timer);
      };
      every(options.leaseIntervalMs ?? 10_000, lease);
      every(options.tickMs ?? 5_000, () => Promise.all([...feeders.values()].map(sync)));
      void lease();
    },

    async close() {
      closed = true;
      for (const timer of timers) clearInterval(timer);
      for (const stationId of [...feeders.keys()]) drop(stationId);
      await leasing;
      await leases.close();
    },
  };
}
