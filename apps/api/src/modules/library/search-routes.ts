import {
  assetActivitySchema,
  libraryBulkResultSchema,
  libraryBulkSchema,
  libraryFacetsQuerySchema,
  libraryFacetsSchema,
  libraryRandomResultSchema,
  libraryRandomSchema,
  librarySearchPageSchema,
  librarySearchSchema,
  uuidSchema,
} from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, stationScopeOf } from '../../plugins/auth.ts';
import { type BulkDeps, bulkEdit } from './search-bulk.ts';
import { assetActivity, libraryFacets, randomLibraryItem, searchLibrary } from './search-repo.ts';

// Library screen api (#23), under /api/v1/stations/:stationId/library. Search, facets and the
// random pick (#24) are POSTs because filters nest; they only read (`library:read`). Bulk
// edits need `library:write` and audit every asset they change.

const stationParams = z.object({ stationId: uuidSchema });
const assetParams = stationParams.extend({ assetId: uuidSchema });

export interface LibrarySearchRoutesOptions {
  /** Announces bulk changes (`asset.updated`, `asset.deleted`) after the commit (#55). */
  publish?: BulkDeps['publish'];
}

export async function librarySearchRoutes(
  app: FastifyInstance,
  options: LibrarySearchRoutesOptions,
) {
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
    '/stations/:stationId/library/random',
    {
      preHandler: read,
      schema: {
        params: stationParams,
        body: libraryRandomSchema,
        response: { 200: libraryRandomResultSchema },
      },
    },
    (request) => randomLibraryItem(app.db, stationScopeOf(request), request.body),
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
      bulkEdit(
        { db: app.db, publish: options.publish },
        { actor: actorOf(request), scope: stationScopeOf(request) },
        request.body,
      ),
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
