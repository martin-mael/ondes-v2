import {
  createSegueSchema,
  islandListSchema,
  islandSchema,
  listIslandsQuerySchema,
  listSeguesQuerySchema,
  type Segue,
  segueListSchema,
  segueMediaQuerySchema,
  segueMediaResponseSchema,
  segueSchema,
  updateSegueSchema,
  uuidSchema,
} from '@ondes/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, stationScopeOf } from '../../plugins/auth.ts';
import { HttpError } from '../../plugins/errors.ts';
import { type EventSink, eventsOf, publishAll } from './events.ts';
import { segueMedia } from './media.ts';
import * as repo from './repo.ts';

// Segues and islands API (#55), under /api/v1/stations/:stationId. Writes are audited and
// re-sync the islands they touch (repo.ts), then publish `segue.changed` / `island.*`.
//
// Permissions: `voice_track:read` reads segues and islands. `voice_track:write` writes any
// segue. `voice_track:write_own` (presenters) writes a segue when A or B belongs to a show they
// host (the item's origin show slot), checked on the items before and after the change.

const stationParams = z.object({ stationId: uuidSchema });
const segueParams = stationParams.extend({ segueId: uuidSchema });
const islandParams = stationParams.extend({ islandId: uuidSchema });

export type SeguesRoutesOptions = { events?: EventSink | undefined };

export async function seguesRoutes(app: FastifyInstance, options: SeguesRoutesOptions) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = app.requirePermission('voice_track', 'read');
  const ctx = (request: FastifyRequest) => ({
    actor: actorOf(request),
    scope: stationScopeOf(request),
  });

  /**
   * `voice_track:write`, or `write_own` on items of a show the signed-in caller hosts (or on a
   * segue they created, so a presenter can still fix or drop their own detached segue).
   */
  async function requireWrite(
    request: FastifyRequest,
    itemIds: (string | null | undefined)[],
    createdBy?: string | null,
  ) {
    const permissions = request.permissions;
    if (permissions?.has('voice_track:write')) return;
    const auth = request.auth;
    const ids = itemIds.filter((id): id is string => !!id);
    if (
      permissions?.has('voice_track:write_own') &&
      auth?.kind === 'session' &&
      ((createdBy && createdBy === auth.user.id) ||
        (await repo.hostsItems(app.db, stationScopeOf(request), auth.user.id, ids)))
    ) {
      return;
    }
    throw new HttpError(403, 'forbidden', 'you can only voice-track the shows you host');
  }

  r.get(
    '/stations/:stationId/segues',
    {
      preHandler: read,
      schema: {
        params: stationParams,
        querystring: listSeguesQuerySchema,
        response: { 200: segueListSchema },
      },
    },
    async (request) => ({
      items: await repo.listSegues(app.db, stationScopeOf(request), request.query),
    }),
  );

  // The segue editor's (#58) lane media: A and B by log item, voices by asset.
  r.get(
    '/stations/:stationId/segues/media',
    {
      preHandler: read,
      schema: {
        params: stationParams,
        querystring: segueMediaQuerySchema,
        response: { 200: segueMediaResponseSchema },
      },
    },
    (request) => segueMedia(app.db, stationScopeOf(request), request.query),
  );

  r.get(
    '/stations/:stationId/segues/:segueId',
    { preHandler: read, schema: { params: segueParams, response: { 200: segueSchema } } },
    (request) => repo.getSegue(app.db, stationScopeOf(request), request.params.segueId),
  );

  r.post(
    '/stations/:stationId/segues',
    {
      preHandler: [
        read,
        async (request: FastifyRequest) => {
          const body = createSegueSchema.safeParse(request.body);
          // An invalid body is the validator's 400; the permission check needs the items.
          if (body.success) await requireWrite(request, [body.data.fromItemId, body.data.toItemId]);
        },
      ],
      schema: { params: stationParams, body: createSegueSchema, response: { 201: segueSchema } },
    },
    async (request, reply) => {
      const c = ctx(request);
      const { segue, sync } = await repo.createSegue(app.db, c, request.body);
      if (!segue) throw new Error('created segue missing');
      await publishAll(
        options.events,
        eventsOf(c.scope, sync, { change: 'created', segue: eventData(segue) }),
        request.log,
      );
      return reply.code(201).send(segue);
    },
  );

  r.put(
    '/stations/:stationId/segues/:segueId',
    {
      preHandler: [
        read,
        async (request: FastifyRequest) => {
          const { segueId } = request.params as { segueId: string };
          const current = await repo.getSegue(app.db, stationScopeOf(request), segueId);
          await requireWrite(request, [current.fromItemId, current.toItemId], current.createdBy);
          // write_own must hold on the segue's new place too, not only on its old one.
          const body = updateSegueSchema.safeParse(request.body);
          if (body.success && (body.data.fromItemId || body.data.toItemId)) {
            await requireWrite(request, [
              body.data.fromItemId ?? current.fromItemId,
              body.data.toItemId ?? current.toItemId,
            ]);
          }
        },
      ],
      schema: { params: segueParams, body: updateSegueSchema, response: { 200: segueSchema } },
    },
    async (request) => {
      const c = ctx(request);
      const { segue, sync } = await repo.updateSegue(
        app.db,
        c,
        request.params.segueId,
        request.body,
      );
      if (!segue) throw new Error('updated segue missing');
      await publishAll(
        options.events,
        eventsOf(c.scope, sync, { change: 'updated', segue: eventData(segue) }),
        request.log,
      );
      return segue;
    },
  );

  r.delete(
    '/stations/:stationId/segues/:segueId',
    {
      preHandler: [
        read,
        async (request: FastifyRequest) => {
          const { segueId } = request.params as { segueId: string };
          const current = await repo.getSegue(app.db, stationScopeOf(request), segueId);
          await requireWrite(request, [current.fromItemId, current.toItemId], current.createdBy);
        },
      ],
      schema: { params: segueParams },
    },
    async (request, reply) => {
      const c = ctx(request);
      const { sync, deleted } = await repo.deleteSegue(app.db, c, request.params.segueId);
      await publishAll(
        options.events,
        eventsOf(c.scope, sync, {
          change: 'deleted',
          segue: {
            segueId: deleted.id,
            status: null,
            problem: null,
            islandId: null,
            fromItemId: deleted.fromItemId,
            toItemId: deleted.toItemId,
          },
        }),
        request.log,
      );
      return reply.code(204).send();
    },
  );

  r.get(
    '/stations/:stationId/islands',
    {
      preHandler: read,
      schema: {
        params: stationParams,
        querystring: listIslandsQuerySchema,
        response: { 200: islandListSchema },
      },
    },
    async (request) => ({
      items: await repo.listIslands(app.db, stationScopeOf(request), request.query),
    }),
  );

  r.get(
    '/stations/:stationId/islands/:islandId',
    { preHandler: read, schema: { params: islandParams, response: { 200: islandSchema } } },
    (request) => repo.getIsland(app.db, stationScopeOf(request), request.params.islandId),
  );
}

function eventData(segue: Segue) {
  return {
    segueId: segue.id,
    status: segue.status,
    problem: segue.problem,
    islandId: segue.island?.id ?? null,
    fromItemId: segue.fromItemId,
    toItemId: segue.toItemId,
  };
}
