import { type Db, type Executor, island, logItem, type StationScope, unsafeScope } from '@ondes/db';
import { alertTypes, type RealtimeEvent, uuidSchema } from '@ondes/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Logger } from '../engine/adapter/index.ts';
import * as repo from './repo.ts';
import type { AlertService } from './service.ts';

// Failed island renders (#71, from #56's renderer). An island is `failed` with a `retry_at` while
// the renderer still retries it, and with none once it gives up (a bad input, or its retries are
// spent): only the latter is an alert, one per island, while its head item is still to air. The
// feeder airs a failed island's items with the plain crossfade and the voices laid over
// (ADR 0024), so it is a warning, not an outage.
//
// Driven by `island.updated` / `island.removed` from the durable alerts consumer; the renderer
// publishes them best effort, so `reconcile` (the alerts sweep, every 30 s) also raises the ones
// whose event was lost and closes the ones that no longer apply.

export const islandAlertKey = (islandId: string) => `${alertTypes.islandRenderFailed}:${islandId}`;

type IslandState = {
  id: string;
  status: string;
  retryAt: Date | null;
  error: string | null;
  hash: string;
  segueIds: string[];
  headItemId: string;
  tailItemId: string;
  /** The head item's planned start; null when it is gone. */
  airsAt: Date | null;
  airsUntil: Date | null;
};

const columns = {
  id: island.id,
  status: island.status,
  retryAt: island.retryAt,
  error: island.error,
  hash: island.hash,
  segueIds: island.segueIds,
  headItemId: island.headItemId,
  tailItemId: island.tailItemId,
  airsAt: logItem.plannedStart,
  airsUntil: sql<Date | null>`${logItem.plannedStart} + make_interval(secs => ${logItem.plannedDurationMs} / 1000.0)`,
};

async function loadIsland(
  db: Executor,
  scope: StationScope,
  islandId: string,
): Promise<IslandState | undefined> {
  const [row] = await db
    .select(columns)
    .from(island)
    .leftJoin(logItem, eq(logItem.id, island.headItemId))
    .where(
      and(
        eq(island.id, islandId),
        eq(island.orgId, scope.orgId),
        eq(island.stationId, scope.stationId),
      ),
    );
  return row ? normalise(row) : undefined;
}

function normalise(row: IslandState): IslandState {
  // `airsUntil` comes back from raw SQL as a string.
  return { ...row, airsUntil: row.airsUntil ? new Date(row.airsUntil) : null };
}

/** Why there should be no alert for this island, or null when there should be one. */
export function islandAlertResolution(row: IslandState | undefined, now: Date): string | null {
  if (!row) return 'removed';
  if (row.status === 'ready') return 'rendered';
  if (row.status !== 'failed') return 'rendering';
  if (row.retryAt !== null) return 'retrying';
  if (!row.airsUntil || row.airsUntil <= now) return 'slot_over';
  return null;
}

export type IslandAlertsOptions = {
  db: Db;
  alerts: AlertService;
  logger: Logger;
  now?: () => Date;
};

export function createIslandAlerts(options: IslandAlertsOptions) {
  const { db, alerts, logger } = options;
  const now = options.now ?? (() => new Date());

  async function apply(
    scope: StationScope,
    islandId: string,
    row: IslandState | undefined,
    opts: { eventId?: string; occurredAt?: Date } = {},
  ) {
    const key = islandAlertKey(islandId);
    const resolution = islandAlertResolution(row, now());
    if (resolution !== null || !row) {
      return alerts.resolve(scope, key, { ...opts, reason: resolution ?? 'removed' });
    }
    return alerts.raise(
      scope,
      {
        type: alertTypes.islandRenderFailed,
        severity: 'warning',
        dedupeKey: key,
        title: 'Voice track transition failed to render',
        message: `A segue's island couldn't be rendered (${(row.error ?? 'unknown error').slice(0, 300)}). It will air as a plain crossfade with the voice laid over.`,
        details: {
          islandId: row.id,
          hash: row.hash,
          segueIds: row.segueIds,
          headItemId: row.headItemId,
          tailItemId: row.tailItemId,
          airsAt: row.airsAt?.toISOString() ?? null,
          error: row.error,
          // For the web app to render in the viewer's language (ADR 0035).
          i18n: {
            key: 'islandRenderFailed',
            params: { error: row.error ?? '', airsAt: row.airsAt?.toISOString() ?? null },
          },
        },
      },
      opts,
    );
  }

  async function handle(event: RealtimeEvent): Promise<void> {
    if (event.type !== 'island.updated' && event.type !== 'island.removed') return;
    if (!uuidSchema.safeParse(event.stationId).success) return;
    const scope = await repo.stationScopeById(db, event.stationId);
    if (!scope) return;
    // The row, not the event, decides: the event may be older than the row's state.
    const row = await loadIsland(db, scope, event.data.islandId);
    await apply(scope, event.data.islandId, row);
  }

  /**
   * Raises the alerts of islands that gave up and still have to air (their event was lost),
   * and closes the open ones that no longer apply. Returns how many it changed.
   */
  async function reconcile(): Promise<number> {
    let changed = 0;
    const failed = await db
      .select({ ...columns, orgId: island.orgId, stationId: island.stationId })
      .from(island)
      .innerJoin(logItem, eq(logItem.id, island.headItemId))
      .where(
        and(
          eq(island.status, 'failed'),
          isNull(island.retryAt),
          sql`${logItem.plannedStart} + make_interval(secs => ${logItem.plannedDurationMs} / 1000.0) > ${now().toISOString()}::timestamptz`,
        ),
      )
      .limit(500);
    const open = await repo.quietOpenAlerts(db, [alertTypes.islandRenderFailed], now());
    const openKeys = new Set(open.map(({ alert }) => `${alert.stationId}:${alert.dedupeKey}`));
    for (const row of failed) {
      const scope = unsafeScope(row.orgId, row.stationId);
      if (openKeys.has(`${row.stationId}:${islandAlertKey(row.id)}`)) continue;
      const result = await apply(scope, row.id, normalise(row));
      if (result && 'kind' in result && result.kind !== 'duplicate' && result.kind !== 'stale') {
        changed++;
      }
    }
    for (const { scope, alert } of open) {
      const islandId = alert.details.islandId;
      if (typeof islandId !== 'string' || !uuidSchema.safeParse(islandId).success) continue;
      const row = await loadIsland(db, scope, islandId);
      if (islandAlertResolution(row, now()) === null) continue;
      if (await apply(scope, islandId, row)) {
        changed++;
        logger.info({ stationId: scope.stationId, islandId }, 'Island alert reconciled');
      }
    }
    return changed;
  }

  return { handle, reconcile };
}
