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

// Revoking a streamer that is live (#63, ADR 0023; #64, ADR 0027). The auth callback only runs
// when a source connects, so disabling, deleting or expiring a streamer must also act on a
// connection that is already up:
// - the harbor pool (#64) reports which streamer the auth callback accepted on each input: every
//   input that streamer holds is hung up (`POST /v1/live/disconnect`), after closing the gate if
//   they are on air, and their live session ends (`revoked`);
// - an engine without that report (rendered before #64) falls back to #63's rule: the station's
//   most recent accepted login holds its single input, and revoking closes the gate.

/** The part of the engine adapter this needs (`app.engineLifecycle.adapterFor`). */
export type LiveEngine = {
  state(): Promise<Pick<EngineState, 'live'>>;
  setLive(enabled: boolean): Promise<void>;
  disconnectLive?(input: number): Promise<boolean>;
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
  /** Ends the streamer's open live session, if it holds it (the live switcher). */
  endSession?: (scope: StationScope, streamerId: string) => Promise<unknown>;
  /** How far back the sweep looks for expiries. Default 10 minutes. */
  windowMs?: number;
}): LiveRevoker {
  const { db, engineFor, logger } = options;
  const windowMs = options.windowMs ?? 10 * 60 * 1000;

  const audited = async (
    scope: StationScope,
    streamerId: string,
    diff: Record<string, { from: unknown; to: unknown }>,
  ) =>
    writeAudit(
      db,
      { actor: { type: 'system', name: 'live' }, scope },
      { action: 'streamer.revoke', entity: { type: 'streamer', id: streamerId }, diff },
    );

  const revoke: LiveRevoker['revoke'] = async (scope, streamerId, reason, wasHolder) => {
    if (!engineFor) return false;
    try {
      const engine = await engineFor(scope.stationId);
      if (!engine) return false;
      const { live } = await engine.state();
      // Harbor pool (#64): the engine says who holds each input.
      if (live.inputs && engine.disconnectLive) {
        const held = live.inputs.filter((i) => i.connected && i.streamer_id === streamerId);
        if (!held.length) return false;
        // Their session ends first, with its reason: once the gate is closed, the switcher's
        // sweep would otherwise record it as a plain return to automation.
        await options.endSession?.(scope, streamerId);
        // The gate lets them through: their input is selected, or none is (the first ready one).
        const through = live.selected == null || held.some((i) => i.input === live.selected);
        if (live.enabled && through) await engine.setLive(false);
        // Hang up every input they hold, even if one fails. A DJ still connected after this is
        // revoked again by the switcher's sweep (`onNotAllowed`), every few seconds.
        const hungUp: number[] = [];
        for (const i of held) {
          try {
            await engine.disconnectLive(i.input);
            hungUp.push(i.input);
          } catch (err) {
            logger.error(
              { err, stationId: scope.stationId, streamerId, input: i.input },
              'Hanging up a revoked streamer failed; the live sweep retries',
            );
          }
        }
        logger.warn(
          { stationId: scope.stationId, streamerId, reason, inputs: hungUp },
          'Live streamer revoked',
        );
        // A retry that changed nothing (the hang-up keeps failing) isn't audited again.
        if (hungUp.length || (live.enabled && through)) {
          await audited(scope, streamerId, {
            disconnected: { from: null, to: hungUp },
            reason: { from: null, to: reason },
          });
        }
        return hungUp.length === held.length;
      }
      const holding = wasHolder ?? (await liveHolder(db, scope.stationId)) === streamerId;
      if (!holding) return false;
      // Nobody connected, or not on air: nothing to take off (#65 checks before opening).
      if (!live.connected || !live.enabled) return false;
      await engine.setLive(false);
      logger.warn({ stationId: scope.stationId, streamerId, reason }, 'Live streamer revoked');
      await audited(scope, streamerId, {
        liveGate: { from: true, to: false },
        reason: { from: null, to: reason },
      });
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
      // Expired since the last window and connected before expiring. `revoke` checks with the
      // engine whether they still hold an input (with a pool, a later login doesn't mean
      // they left).
      const rows = await db
        .select({ id: streamer.id, orgId: streamer.orgId, stationId: streamer.stationId })
        .from(streamer)
        .where(
          and(
            lte(streamer.expiresAt, now),
            gt(streamer.expiresAt, new Date(now.getTime() - windowMs)),
            sql`${streamer.lastConnectedAt} < ${streamer.expiresAt}`,
          ),
        );
      let revoked = 0;
      for (const row of rows) {
        // Ids read from the row: the sweep runs for every station.
        const scope = unsafeScope(row.orgId, row.stationId);
        if (await revoke(scope, row.id, 'expired')) revoked++;
      }
      return revoked;
    },
  };
}
