import { asRunEntry, type Executor, type StationScope, station, whereStation } from '@ondes/db';
import {
  type AsRunOverlay,
  type AsRunOverlayQuery,
  asRunOverlayQuerySchema,
  asRunOverlaySchema,
  localDayBounds,
  uuidSchema,
} from '@ondes/shared';
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { stationScopeOf } from '../../plugins/auth.ts';
import { getLogRange } from '../log/repo.ts';
import { buildOverlay } from './overlay.ts';
import { toEntry } from './repo.ts';

// Log vs as-run (#53), under /api/v1/stations/:stationId/…
//   GET /asrun/overlay?date   log:read   the day's plan with what aired laid over it

/**
 * How far around the day as-run entries are read: an item planned late in the day can air
 * after midnight (and an early one before), and still belongs to its day's plan.
 */
const AIR_MARGIN_MS = 3 * 3600 * 1000;

export async function getAsRunOverlay(
  db: Executor,
  scope: StationScope,
  query: AsRunOverlayQuery,
  now = new Date(),
): Promise<AsRunOverlay> {
  const { date } = asRunOverlayQuerySchema.parse(query);
  const [row] = await db
    .select({ timezone: station.timezone })
    .from(station)
    .where(eq(station.id, scope.stationId));
  const { startsAt: from, endsAt: to } = localDayBounds(date, row?.timezone ?? 'UTC');
  const log = await getLogRange(db, scope, { from: from.toISOString(), to: to.toISOString() });
  const entries = await db
    .select()
    .from(asRunEntry)
    .where(
      and(
        whereStation(asRunEntry, scope),
        gte(asRunEntry.startedAt, new Date(from.getTime() - AIR_MARGIN_MS)),
        lt(asRunEntry.startedAt, new Date(to.getTime() + AIR_MARGIN_MS)),
      ),
    )
    .orderBy(asc(asRunEntry.startedAt), asc(asRunEntry.id));
  return {
    date,
    from: from.toISOString(),
    to: to.toISOString(),
    now: now.toISOString(),
    rows: buildOverlay({
      items: log.items,
      entries: entries.map(toEntry),
      from: from.getTime(),
      to: to.getTime(),
      now: now.getTime(),
    }),
  };
}

const stationParams = z.object({ stationId: uuidSchema });

export async function asRunOverlayRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/stations/:stationId/asrun/overlay',
    {
      preHandler: app.requirePermission('log', 'read'),
      schema: {
        params: stationParams,
        querystring: asRunOverlayQuerySchema,
        response: { 200: asRunOverlaySchema },
      },
    },
    async (request) => getAsRunOverlay(app.db, stationScopeOf(request), request.query),
  );
}
