import {
  assetActivitySchema,
  libraryBulkResultSchema,
  libraryBulkSchema,
  libraryFacetsQuerySchema,
  libraryFacetsSchema,
  librarySearchPageSchema,
  librarySearchSchema,
  uuidSchema,
} from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, stationScopeOf } from '../../plugins/auth.ts';
import { bulkEdit } from './search-bulk.ts';
import { assetActivity, libraryFacets, searchLibrary } from './search-repo.ts';

// Library screen api (#23), under /api/v1/stations/:stationId/library. Search and facets are
// POSTs because filters nest; they only read (`library:read`). Bulk edits need
// `library:write` and audit every asset they change.

const stationParams = z.object({ stationId: z.string() });
const assetParams = stationParams.extend({ assetId: uuidSchema });

export async function librarySearchRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = app.requirePermission('library', 'read');
  const write = app.requirePermission('library', 'write');

  r.post(
    '/stations/:stationId/library/search',
    {
      preHandler: read,
      schema: {
        params: stationParams,
        body: librarySearchSchema,
        response: { 200: librarySearchPageSchema },
      },
    },
    (request) => searchLibrary(app.db, stationScopeOf(request), request.body),
  );

  r.post(
    '/stations/:stationId/library/facets',
    {
      preHandler: read,
      schema: {
        params: stationParams,
        body: libraryFacetsQuerySchema,
        response: { 200: libraryFacetsSchema },
      },
    },
    (request) => libraryFacets(app.db, stationScopeOf(request), request.body),
  );

  r.post(
    '/stations/:stationId/library/bulk',
    {
      preHandler: write,
      schema: {
        params: stationParams,
        body: libraryBulkSchema,
        response: { 200: libraryBulkResultSchema },
      },
    },
    (request) =>
      bulkEdit(app.db, { actor: actorOf(request), scope: stationScopeOf(request) }, request.body),
  );

  r.get(
    '/stations/:stationId/library/assets/:assetId/activity',
    {
      preHandler: read,
      schema: { params: assetParams, response: { 200: assetActivitySchema } },
    },
    (request) => assetActivity(app.db, stationScopeOf(request), request.params.assetId),
  );
}
