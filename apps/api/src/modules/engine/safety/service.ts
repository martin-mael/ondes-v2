import {
  addSafetyAssets,
  alert,
  countSafetyAssets,
  type Db,
  type Executor,
  getFallbackSelection,
  isStationEngineRunning,
  listAssetIdsByTag,
  listFallbackAlertStations,
  recordOnAirSource,
  removeSafetyAsset,
  type StationScope,
  setEmergencyAsset,
  setSafetyAssets,
  station,
  unsafeScope,
  whereStation,
  withAudit,
} from '@ondes/db';
import {
  type Actor,
  type AddSafetyAssets,
  type AlertSeverity,
  addSafetyAssetsSchema,
  MAX_SAFETY_ASSETS,
  type RealtimeEvent,
  type SafetyStatus,
  type SetEmergencyAsset,
  type SetSafetyAssets,
  setEmergencyAssetSchema,
  setSafetyAssetsSchema,
  uuidSchema,
} from '@ondes/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { HttpError } from '../../../plugins/errors.ts';
import type { AlertService } from '../../alerts/service.ts';
import type { Logger } from '../adapter/index.ts';
import { needsRaise, SAFETY_ALERT_TYPES, safetyAlertResolution, safetyAlerts } from './alerts.ts';

// Safety playlist and emergency file (#34), api side. The selection is library assets; the
// worker's cache-sync pass pins their playout files in the station's cache, where the
// template's fallbacks read them (`/cache/safety/`, `/cache/emergency.flac`). The template
// picks up changes by itself (watched directory, emergency file re-read at every loop), so a
// change only needs a cache-sync pass, never an engine restart.

export type SafetyService = {
  status(scope: StationScope): Promise<SafetyStatus>;
  /** Replaces the safety playlist. */
  setAssets(scope: StationScope, actor: Actor, input: SetSafetyAssets): Promise<SafetyStatus>;
  /** Adds assets by id or by tag (a snapshot of the tag's assets). */
  addAssets(scope: StationScope, actor: Actor, input: AddSafetyAssets): Promise<SafetyStatus>;
  /** 404 when the asset isn't in the playlist. */
  removeAsset(scope: StationScope, actor: Actor, assetId: string): Promise<void>;
  setEmergency(scope: StationScope, actor: Actor, input: SetEmergencyAsset): Promise<SafetyStatus>;
  /** Engine events (durable consumer): what is on air, for safety mode. */
  handleEngineEvent(event: RealtimeEvent): Promise<void>;
  evaluateAlerts(
    scope: StationScope,
    options?: { now?: Date; engineRunning?: boolean; reader?: Executor },
  ): Promise<{ raised: number; resolved: number }>;
  /** `evaluateAlerts` for every station whose engine should run or that has one open. */
  evaluateAllAlerts(now?: Date): Promise<void>;
};

export type SafetyServiceOptions = {
  db: Db;
  alerts: AlertService;
  /** Runs a cache-sync pass for the station (`app.playoutCache.requestSync`). */
  requestSync?: (scope: StationScope) => Promise<void>;
  logger: Logger;
};

export function createSafetyService(options: SafetyServiceOptions): SafetyService {
  const { db, alerts, logger } = options;

  async function status(scope: StationScope): Promise<SafetyStatus> {
    const s = await getFallbackSelection(db, scope);
    const ready = s.safety.filter((a) => a.cache.state === 'ready');
    return {
      safety: {
        assets: s.safety,
        readyCount: ready.length,
        readyDurationMs: ready.reduce((sum, a) => sum + (a.durationMs ?? 0), 0),
      },
      emergency: s.emergency,
      syncedAt: s.syncedAt,
      onAir: s.onAir,
    };
  }

  /** After a change: get the files into the cache now, and update the alerts. */
  async function changed(scope: StationScope) {
    if (options.requestSync) {
      await options.requestSync(scope).catch((err: unknown) => {
        // The worker's 10 min sweep catches up.
        logger.error({ err, stationId: scope.stationId }, 'cache sync request failed');
      });
    }
    await evaluateAlerts(scope).catch((err: unknown) => {
      logger.error({ err, stationId: scope.stationId }, 'safety alert evaluation failed');
    });
  }

  async function evaluateAlerts(
    scope: StationScope,
    opts: { now?: Date; engineRunning?: boolean; reader?: Executor } = {},
  ) {
    const now = opts.now ?? new Date();
    const reader = opts.reader ?? db;
    const [selection, open, running] = await Promise.all([
      getFallbackSelection(reader, scope),
      reader
        .select({ dedupeKey: alert.dedupeKey, type: alert.type, severity: alert.severity })
        .from(alert)
        .where(
          and(
            whereStation(alert, scope),
            isNull(alert.resolvedAt),
            inArray(alert.type, [...SAFETY_ALERT_TYPES]),
          ),
        ),
      opts.engineRunning ?? isStationEngineRunning(reader, scope),
    ]);
    const desired = safetyAlerts({ selection, engineRunning: running, now });
    const openBy = new Map(open.map((o) => [o.dedupeKey, o]));
    const desiredKeys = new Set(desired.map((d) => d.dedupeKey));
    let raised = 0;
    let resolved = 0;
    for (const d of desired) {
      if (!needsRaise(d, openBy.get(d.dedupeKey)?.severity as AlertSeverity | undefined)) continue;
      await alerts.raise(scope, d, { occurredAt: now });
      raised++;
    }
    for (const o of open) {
      if (desiredKeys.has(o.dedupeKey)) continue;
      const reason = safetyAlertResolution(o.type, running);
      if (await alerts.resolve(scope, o.dedupeKey, { reason, occurredAt: now })) resolved++;
    }
    return { raised, resolved };
  }

  return {
    status,

    async setAssets(scope, actor, input) {
      const { assetIds } = setSafetyAssetsSchema.parse(input);
      await withAudit(db, { actor, scope }, async (tx, audit) => {
        const change = await setSafetyAssets(tx, scope, assetIds);
        await audit({
          action: 'safety_playlist.set',
          entity: { type: 'station', id: scope.stationId },
          diff: {
            added: { from: null, to: change.added },
            removed: { from: change.removed, to: null },
          },
        });
      });
      await changed(scope);
      return status(scope);
    },

    async addAssets(scope, actor, input) {
      const parsed = addSafetyAssetsSchema.parse(input);
      await withAudit(db, { actor, scope }, async (tx, audit) => {
        // Serializes concurrent additions, so the size limit holds.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`safety:${scope.stationId}`}, 0))`,
        );
        const room = MAX_SAFETY_ASSETS - (await countSafetyAssets(tx, scope));
        const ids = parsed.tag
          ? await listAssetIdsByTag(tx, scope, parsed.tag, MAX_SAFETY_ASSETS + 1)
          : (parsed.assetIds ?? []);
        const added = await addSafetyAssets(tx, scope, ids);
        if (added.length > room) {
          throw new HttpError(
            409,
            'safety_playlist_full',
            `a safety playlist holds at most ${MAX_SAFETY_ASSETS} assets`,
          );
        }
        await audit({
          action: 'safety_playlist.add',
          entity: { type: 'station', id: scope.stationId },
          diff: {
            assetIds: { from: null, to: added },
            ...(parsed.tag ? { tag: { from: null, to: parsed.tag } } : {}),
          },
        });
      });
      await changed(scope);
      return status(scope);
    },

    async removeAsset(scope, actor, assetId) {
      const notIn = new HttpError(404, 'not_found', 'asset not in the safety playlist');
      if (!uuidSchema.safeParse(assetId).success) throw notIn;
      await withAudit(db, { actor, scope }, async (tx, audit) => {
        // Nothing removed: roll back without an audit row.
        if (!(await removeSafetyAsset(tx, scope, assetId))) throw notIn;
        await audit({
          action: 'safety_playlist.remove',
          entity: { type: 'station', id: scope.stationId },
          diff: { assetIds: { from: [assetId], to: null } },
        });
      });
      await changed(scope);
    },

    async setEmergency(scope, actor, input) {
      const { assetId } = setEmergencyAssetSchema.parse(input);
      await withAudit(db, { actor, scope }, async (tx, audit) => {
        const { before } = await setEmergencyAsset(tx, scope, assetId);
        await audit({
          action: 'emergency_file.set',
          entity: { type: 'station', id: scope.stationId },
          diff: { assetId: { from: before, to: assetId } },
        });
      });
      await changed(scope);
      return status(scope);
    },

    async handleEngineEvent(event) {
      let source: Parameters<typeof recordOnAirSource>[2]['source'];
      if (event.type === 'engine.track.started') source = event.data.source;
      else if (event.type === 'engine.booted' || event.type === 'engine.down') source = null;
      else return;
      if (!uuidSchema.safeParse(event.stationId).success) return;
      const scope = await stationScopeById(db, event.stationId);
      if (!scope) return;
      await recordOnAirSource(db, scope, { source, at: new Date(event.at) });
    },

    evaluateAlerts,

    async evaluateAllAlerts(now = new Date()) {
      // One replica at a time: the others skip this round (same pattern as the cache alerts).
      await db.transaction(async (tx) => {
        const [lock] = await tx.execute<{ locked: boolean }>(
          sql`select pg_try_advisory_xact_lock(hashtextextended('safety-alerts', 0)) as locked`,
        );
        if (!lock?.locked) return;
        for (const s of await listFallbackAlertStations(tx, SAFETY_ALERT_TYPES)) {
          try {
            // The ids were just read from station-scoped rows.
            await evaluateAlerts(unsafeScope(s.orgId, s.stationId), {
              now,
              engineRunning: s.engineRunning,
              reader: tx,
            });
          } catch (err) {
            logger.error({ err, stationId: s.stationId }, 'safety alert evaluation failed');
          }
        }
      });
    },
  };
}

async function stationScopeById(db: Executor, stationId: string) {
  const [row] = await db
    .select({ orgId: station.orgId })
    .from(station)
    .where(eq(station.id, stationId));
  // The ids were just read from the station row.
  return row ? unsafeScope(row.orgId, stationId) : null;
}
