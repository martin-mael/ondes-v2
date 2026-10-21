import type { DbClient } from '@ondes/db';

type Sql = DbClient['sql'];
type ReservedSql = Awaited<ReturnType<Sql['reserve']>>;

/**
 * Exactly one feeder per station across api replicas: a session-level Postgres advisory lock
 * per station, held on one connection this process reserves for it. Whoever holds a station's
 * lock feeds it; the others leave it alone. The lock goes away with the session, so a replica
 * that dies (or loses its database connection) frees its stations for the next round of
 * another replica.
 *
 * `holds()` is cheap (`select 1` on that connection) and runs before every change to an engine
 * queue: if the connection is gone, so are the locks, and this process stops feeding.
 */
export type FeederLeases = {
  /** Takes the station's lock if nobody holds it. True if this process holds it now. */
  acquire(stationId: string): Promise<boolean>;
  release(stationId: string): Promise<void>;
  /** Whether this process still holds the station's lock (its session is alive). */
  holds(stationId: string): Promise<boolean>;
  /** Stations held. Empty after the connection was lost. */
  held(): ReadonlySet<string>;
  close(): Promise<void>;
};

/** Advisory lock key of a station's feeder. */
export const feederLockKey = (stationId: string) => `ondes.feeder:${stationId}`;

export function createFeederLeases(
  sql: Sql,
  options: { onLost?: (stationIds: string[]) => void } = {},
): FeederLeases {
  let conn: ReservedSql | null = null;
  let connecting: Promise<ReservedSql> | null = null;
  const held = new Set<string>();
  let closed = false;

  async function connection(): Promise<ReservedSql> {
    if (conn) return conn;
    connecting ??= sql.reserve().finally(() => {
      connecting = null;
    });
    conn = await connecting;
    return conn;
  }

  /** The session failed: every lock is gone with it. */
  function lost() {
    const stations = [...held];
    held.clear();
    const old = conn;
    conn = null;
    // The error may not have closed the session: never hand a session that still holds locks
    // back to the pool.
    if (old) {
      void old`select pg_advisory_unlock_all()`.catch(() => {}).finally(() => old.release());
    }
    if (stations.length) options.onLost?.(stations);
  }

  async function query<T extends readonly object[]>(
    run: (c: ReservedSql) => Promise<T>,
  ): Promise<T> {
    const c = await connection();
    try {
      return await run(c);
    } catch (error) {
      lost();
      throw error;
    }
  }

  return {
    async acquire(stationId) {
      if (closed) return false;
      if (held.has(stationId)) return true;
      const [row] = await query(
        (c) =>
          c<
            { locked: boolean }[]
          >`select pg_try_advisory_lock(hashtextextended(${feederLockKey(stationId)}, 0)) as locked`,
      );
      if (row?.locked) held.add(stationId);
      return held.has(stationId);
    },

    async release(stationId) {
      if (!held.delete(stationId) || !conn) return;
      await query(
        (c) => c`select pg_advisory_unlock(hashtextextended(${feederLockKey(stationId)}, 0))`,
      ).catch(() => {});
    },

    async holds(stationId) {
      if (!held.has(stationId) || !conn) return false;
      try {
        await query((c) => c`select 1`);
      } catch {
        return false;
      }
      return held.has(stationId);
    },

    held: () => held,

    async close() {
      closed = true;
      held.clear();
      const c = conn;
      conn = null;
      // Releasing the connection back to the pool would keep the session (and its locks):
      // unlock them first.
      if (c) {
        await c`select pg_advisory_unlock_all()`.catch(() => {});
        c.release();
      }
    },
  };
}
