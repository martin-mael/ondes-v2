import {
  categoryDetailSchema,
  categoryListSchema,
  categoryPreviewQuerySchema,
  categoryPreviewSchema,
  createCategorySchema,
  draftPreviewSchema,
  updateCategorySchema,
  uuidSchema,
} from '@ondes/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, stationScopeOf } from '../../plugins/auth.ts';
import * as repo from './repo.ts';

// Categories API (#37), under /api/v1/stations/:stationId/categories. Reads need
// `rotation:read`, edits `rotation:write`; every edit writes an audit row. Membership is
// resolved on each read, so counts and previews follow tag edits immediately.

const stationParams = z.object({ stationId: z.string() });
const categoryParams = stationParams.extend({ categoryId: uuidSchema });

export async function rotationRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = app.requirePermission('rotation', 'read');
  const write = app.requirePermission('rotation', 'write');
  const ctx = (request: FastifyRequest) => ({
    actor: actorOf(request),
    scope: stationScopeOf(request),
  });

  r.get(
    '/stations/:stationId/categories',
    {
      preHandler: read,
      schema: { params: stationParams, response: { 200: categoryListSchema } },
    },
    (request) => repo.listCategories(app.db, stationScopeOf(request)),
  );

  r.post(
    '/stations/:stationId/categories',
    {
      preHandler: write,
      schema: {
        params: stationParams,
        body: createCategorySchema,
        response: { 201: categoryDetailSchema },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await repo.createCategory(app.db, ctx(request), request.body)),
  );

  // Draft preview: reads only, so `rotation:read` is enough.
  r.post(
    '/stations/:stationId/categories/preview',
    {
      preHandler: read,
      schema: {
        params: stationParams,
        body: draftPreviewSchema,
        response: { 200: categoryPreviewSchema },
      },
    },
    (request) => repo.previewDraft(app.db, stationScopeOf(request), request.body),
  );

  r.get(
    '/stations/:stationId/categories/:categoryId',
    {
      preHandler: read,
      schema: { params: categoryParams, response: { 200: categoryDetailSchema } },
    },
    (request) => repo.getCategory(app.db, stationScopeOf(request), request.params.categoryId),
  );

  r.get(
    '/stations/:stationId/categories/:categoryId/preview',
    {
      preHandler: read,
      schema: {
        params: categoryParams,
        querystring: categoryPreviewQuerySchema,
        response: { 200: categoryPreviewSchema },
      },
    },
    (request) =>
      repo.previewCategory(
        app.db,
        stationScopeOf(request),
        request.params.categoryId,
        request.query,
      ),
  );

  r.patch(
    '/stations/:stationId/categories/:categoryId',
    {
      preHandler: write,
      schema: {
        params: categoryParams,
        body: updateCategorySchema,
        response: { 200: categoryDetailSchema },
      },
    },
    (request) => repo.updateCategory(app.db, ctx(request), request.params.categoryId, request.body),
  );

  r.delete(
    '/stations/:stationId/categories/:categoryId',
    {
      preHandler: write,
      schema: { params: categoryParams },
    },
    async (request, reply) => {
      await repo.deleteCategory(app.db, ctx(request), request.params.categoryId);
      return reply.code(204).send();
    },
  );
}
