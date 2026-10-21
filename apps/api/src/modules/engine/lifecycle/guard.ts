/**
 * Restart-storm guard: counts a station's engine restarts (Docker's own restarts of a crashed
 * container and the lifecycle's restarts) in a sliding window. Past `maxRestarts`, the guard
 * trips: the lifecycle stops restarting that engine, stops the container and publishes
 * `engine.restart_storm`, until someone restarts it by hand (`reset`).
 *
 * In memory: an api restart forgets the counts, which at worst allows one more window of
 * restarts. Settings changes don't count (a restart because `config_version` changed is
 * planned, not a crash).
 */
export type RestartGuardOptions = {
  /** Restarts allowed in the window. Default 5. */
  maxRestarts?: number;
  /** Default 10 minutes. */
  windowSeconds?: number;
  now?: () => number;
};

export class RestartGuard {
  readonly maxRestarts: number;
  readonly windowSeconds: number;
  readonly #now: () => number;
  readonly #restarts = new Map<string, number[]>();
  readonly #tripped = new Set<string>();

  constructor(options: RestartGuardOptions = {}) {
    this.maxRestarts = options.maxRestarts ?? 5;
    this.windowSeconds = options.windowSeconds ?? 600;
    this.#now = options.now ?? Date.now;
  }

  /** Records `count` restarts now. Returns the restarts in the window and whether it tripped. */
  record(
    stationId: string,
    count = 1,
  ): { restarts: number; tripped: boolean; justTripped: boolean } {
    const now = this.#now();
    const since = now - this.windowSeconds * 1000;
    const times = (this.#restarts.get(stationId) ?? []).filter((t) => t > since);
    for (let i = 0; i < count; i++) times.push(now);
    this.#restarts.set(stationId, times);
    const wasTripped = this.#tripped.has(stationId);
    if (times.length > this.maxRestarts) this.#tripped.add(stationId);
    const tripped = this.#tripped.has(stationId);
    return { restarts: times.length, tripped, justTripped: tripped && !wasTripped };
  }

  /** Restarts counted in the current window. */
  count(stationId: string): number {
    const since = this.#now() - this.windowSeconds * 1000;
    return (this.#restarts.get(stationId) ?? []).filter((t) => t > since).length;
  }

  isTripped(stationId: string): boolean {
    return this.#tripped.has(stationId);
  }

  /** A person restarted the engine: start counting again. */
  reset(stationId: string): void {
    this.#restarts.delete(stationId);
    this.#tripped.delete(stationId);
  }
}
