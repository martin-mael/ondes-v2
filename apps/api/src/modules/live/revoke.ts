import {
  type Db,
  type Executor,
  type StationScope,
  streamer,
  unsafeScope,
  writeAudit,
} from '@ondes/db';
import type { EngineState } from '@ondes/shared';
import { and, desc, eq, gt, isNotNull, lte, sql } from 'drizzle-orm';

// Revoking a streamer that is live (#63, ADR 0023). The auth callback only runs when a source
// connects, so disabling, deleting or expiring a streamer must also act on a connection that
// is already up. Today that means closing the live gate (`POST /v1/live {enabled:false}`): the
// DJ is off air at once, and automation takes the air back. Disconnecting the source itself
// needs an engine command that the harbor pool (#64) adds; it plugs in behind `LiveEngine`.
//
// Which streamer holds the live input: the station has one, and the engine doesn't report who
// connected, so it's the station's most recent accepted login (`last_connected_at`), while the
// engine says a source is connected.

/** The part of the engine adapter this needs (`app.engineLifecycle.adapterFor`). */
export type LiveEngine = {
  state(): Promise<Pick<EngineState, 'live'>>;
  setLive(enabled: boolean): Promise<void>;
};
export type LiveEngineLookup = (stationId: string) => Promise<LiveEngine | undefined>;

export type RevokeReason = 'disabled' | 'expired' | 'deleted';

type Logger = { warn(obj: object, msg: string): void; error(obj: object, msg: string): void };

/** The streamer whose login was accepted last on the station, if any. */
export async function liveHolder(db: Executor, stationId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: streamer.id })
    .from(streamer)
    .where(and(eq(streamer.stationId, stationId), isNotNull(streamer.lastConnectedAt)))
    .orderBy(desc(streamer.lastConnectedAt))
    .limit(1);
  return row?.id;
}

export type LiveRevoker = {
  /**
   * Takes `streamerId` off air if it holds the station's live input. `wasHolder`: decided by
   * the caller beforehand (a deleted streamer has no row left). True if the gate was closed.
   */
  revoke(
    scope: StationScope,
    streamerId: string,
    reason: RevokeReason,
    wasHolder?: boolean,
  ): Promise<boolean>;
  /** Revokes the holders whose expiry passed in the last `windowMs`. */
  sweep(now?: Date): Promise<number>;
};

export function createLiveRevoker(options: {
  db: Db;
  engineFor?: LiveEngineLookup;
  logger: Logger;
  /** How far back the sweep looks for expiries. Default 10 minutes. */
  windowMs?: number;
}): LiveRevoker {
  const { db, engineFor, logger } = options;
  const windowMs = options.windowMs ?? 10 * 60 * 1000;

  const revoke: LiveRevoker['revoke'] = async (scope, streamerId, reason, wasHolder) => {
    if (!engineFor) return false;
    const holding = wasHolder ?? (await liveHolder(db, scope.stationId)) === streamerId;
    if (!holding) return false;
    try {
      const engine = await engineFor(scope.stationId);
      if (!engine) return false;
      const { live } = await engine.state();
      // Nobody connected, or not on air: nothing to take off (#65 checks before opening).
      if (!live.connected || !live.enabled) return false;
      await engine.setLive(false);
      logger.warn({ stationId: scope.stationId, streamerId, reason }, 'Live streamer revoked');
      await writeAudit(
        db,
        { actor: { type: 'system', name: 'live' }, scope },
        {
          action: 'streamer.revoke',
          entity: { type: 'streamer', id: streamerId },
          diff: { liveGate: { from: true, to: false }, reason: { from: null, to: reason } },
        },
      );
      return true;
    } catch (err) {
      logger.error(
        { err, stationId: scope.stationId, streamerId },
        'Revoking a live streamer failed',
      );
      return false;
    }
  };

  return {
    revoke,
    async sweep(now = new Date()) {
      if (!engineFor) return 0;
      // Expired since the last window, connected before expiring, and still the holder.
      const rows = await db
        .select({ id: streamer.id, orgId: streamer.orgId, stationId: streamer.stationId })
        .from(streamer)
        .where(
          and(
            lte(streamer.expiresAt, now),
            gt(streamer.expiresAt, new Date(now.getTime() - windowMs)),
            sql`${streamer.lastConnectedAt} < ${streamer.expiresAt}`,
            sql`not exists (select 1 from ${streamer} o where o.station_id = ${streamer.stationId}
              and o.last_connected_at > ${streamer.lastConnectedAt})`,
          ),
        );
      let revoked = 0;
      for (const row of rows) {
        // Ids read from the row: the sweep runs for every station.
        const scope = unsafeScope(row.orgId, row.stationId);
        if (await revoke(scope, row.id, 'expired', true)) revoked++;
      }
      return revoked;
    },
  };
}
