import {
  createEpisodeSchema,
  createShowSchema,
  createShowSlotSchema,
  episodeListSchema,
  episodeSchema,
  listEpisodesQuerySchema,
  localDateSchema,
  putSlotExceptionSchema,
  showListSchema,
  showOccurrencesQuerySchema,
  showOccurrencesResponseSchema,
  showSchema,
  showSlotListSchema,
  showSlotSchema,
  updateEpisodeSchema,
  updateShowSchema,
  updateShowSlotSchema,
  uuidSchema,
} from '@ondes/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, stationScopeOf } from '../../plugins/auth.ts';
import { HttpError } from '../../plugins/errors.ts';
import * as repo from './repo.ts';

// Shows, slots and episodes API (#44), under /api/v1/stations/:stationId. Every mutation is
// audited (repo.ts).
//
// Permissions: `show:read` reads everything. `show:write` manages shows, slots, exceptions and
// episodes. `show:write_own` (presenters) edits a show the caller hosts and its episodes, but
// not its hosts, its slots, or the show's existence: those shape the station's grid.

const stationParams = z.object({ stationId: z.string() });
const showParams = stationParams.extend({ showId: uuidSchema });
const slotParams = showParams.extend({ slotId: uuidSchema });
const exceptionParams = slotParams.extend({ date: localDateSchema });
const episodeParams = showParams.extend({ episodeId: uuidSchema });

export async function showsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = app.requirePermission('show', 'read');
  const write = app.requirePermission('show', 'write');
  const ctx = (request: FastifyRequest) => ({
    actor: actorOf(request),
    scope: stationScopeOf(request),
  });

  /** `show:write`, or `show:write_own` on a show the signed-in caller hosts. 404 first. */
  async function requireShowWrite(request: FastifyRequest, showId: string) {
    const scope = stationScopeOf(request);
    await repo.getShow(app.db, scope, showId);
    const permissions = request.permissions;
    if (permissions?.has('show:write')) return;
    const auth = request.auth;
    if (
      permissions?.has('show:write_own') &&
      auth?.kind === 'session' &&
      (await repo.isHost(app.db, scope, showId, auth.user.id))
    ) {
      return;
    }
    throw new HttpError(403, 'forbidden', 'you can only edit the shows you host');
  }

  // --- Shows ---

  r.get(
    '/stations/:stationId/shows',
    { preHandler: read, schema: { params: stationParams, response: { 200: showListSchema } } },
    async (request) => ({ items: await repo.listShows(app.db, stationScopeOf(request)) }),
  );

  r.post(
    '/stations/:stationId/shows',
    {
      preHandler: write,
      schema: { params: stationParams, body: createShowSchema, response: { 201: showSchema } },
    },
    async (request, reply) =>
      reply.code(201).send(await repo.createShow(app.db, ctx(request), request.body)),
  );

  r.get(
    '/stations/:stationId/shows/:showId',
    { preHandler: read, schema: { params: showParams, response: { 200: showSchema } } },
    (request) => repo.getShow(app.db, stationScopeOf(request), request.params.showId),
  );

  r.patch(
    '/stations/:stationId/shows/:showId',
    {
      preHandler: read,
      schema: { params: showParams, body: updateShowSchema, response: { 200: showSchema } },
    },
    async (request) => {
      const { showId } = request.params;
      if (request.body.hostUserIds !== undefined && !request.permissions?.has('show:write')) {
        await repo.getShow(app.db, stationScopeOf(request), showId);
        throw new HttpError(403, 'forbidden', "changing a show's hosts needs show:write");
      }
      await requireShowWrite(request, showId);
      return repo.updateShow(app.db, ctx(request), showId, request.body);
    },
  );

  r.delete(
    '/stations/:stationId/shows/:showId',
    { preHandler: write, schema: { params: showParams } },
    async (request, reply) => {
      await repo.deleteShow(app.db, ctx(request), request.params.showId);
      return reply.code(204).send();
    },
  );

  // --- Slots ---

  r.get(
    '/stations/:stationId/shows/:showId/slots',
    { preHandler: read, schema: { params: showParams, response: { 200: showSlotListSchema } } },
    async (request) => ({
      items: await repo.listSlots(app.db, stationScopeOf(request), request.params.showId),
    }),
  );

  r.post(
    '/stations/:stationId/shows/:showId/slots',
    {
      preHandler: write,
      schema: { params: showParams, body: createShowSlotSchema, response: { 201: showSlotSchema } },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(await repo.createSlot(app.db, ctx(request), request.params.showId, request.body)),
  );

  r.get(
    '/stations/:stationId/shows/:showId/slots/:slotId',
    { preHandler: read, schema: { params: slotParams, response: { 200: showSlotSchema } } },
    (request) =>
      repo.getSlot(app.db, stationScopeOf(request), request.params.showId, request.params.slotId),
  );

  r.patch(
    '/stations/:stationId/shows/:showId/slots/:slotId',
    {
      preHandler: write,
      schema: { params: slotParams, body: updateShowSlotSchema, response: { 200: showSlotSchema } },
    },
    (request) =>
      repo.updateSlot(
        app.db,
        ctx(request),
        request.params.showId,
        request.params.slotId,
        request.body,
      ),
  );

  r.delete(
    '/stations/:stationId/shows/:showId/slots/:slotId',
    { preHandler: write, schema: { params: slotParams } },
    async (request, reply) => {
      await repo.deleteSlot(app.db, ctx(request), request.params.showId, request.params.slotId);
      return reply.code(204).send();
    },
  );

  r.put(
    '/stations/:stationId/shows/:showId/slots/:slotId/exceptions/:date',
    {
      preHandler: write,
      schema: {
        params: exceptionParams,
        body: putSlotExceptionSchema,
        response: { 200: showSlotSchema },
      },
    },
    (request) => {
      const { showId, slotId, date } = request.params;
      return repo.putException(app.db, ctx(request), showId, slotId, date, request.body);
    },
  );

  r.delete(
    '/stations/:stationId/shows/:showId/slots/:slotId/exceptions/:date',
    { preHandler: write, schema: { params: exceptionParams, response: { 200: showSlotSchema } } },
    (request) => {
      const { showId, slotId, date } = request.params;
      return repo.deleteException(app.db, ctx(request), showId, slotId, date);
    },
  );

  // --- Episodes ---

  r.get(
    '/stations/:stationId/shows/:showId/episodes',
    {
      preHandler: read,
      schema: {
        params: showParams,
        querystring: listEpisodesQuerySchema,
        response: { 200: episodeListSchema },
      },
    },
    async (request) => ({
      items: await repo.listEpisodes(
        app.db,
        stationScopeOf(request),
        request.params.showId,
        request.query.status,
      ),
    }),
  );

  r.post(
    '/stations/:stationId/shows/:showId/episodes',
    {
      preHandler: read,
      schema: { params: showParams, body: createEpisodeSchema, response: { 201: episodeSchema } },
    },
    async (request, reply) => {
      await requireShowWrite(request, request.params.showId);
      return reply
        .code(201)
        .send(await repo.createEpisode(app.db, ctx(request), request.params.showId, request.body));
    },
  );

  r.get(
    '/stations/:stationId/shows/:showId/episodes/:episodeId',
    { preHandler: read, schema: { params: episodeParams, response: { 200: episodeSchema } } },
    (request) =>
      repo.getEpisode(
        app.db,
        stationScopeOf(request),
        request.params.showId,
        request.params.episodeId,
      ),
  );

  r.patch(
    '/stations/:stationId/shows/:showId/episodes/:episodeId',
    {
      preHandler: read,
      schema: {
        params: episodeParams,
        body: updateEpisodeSchema,
        response: { 200: episodeSchema },
      },
    },
    async (request) => {
      const { showId, episodeId } = request.params;
      await requireShowWrite(request, showId);
      return repo.updateEpisode(app.db, ctx(request), showId, episodeId, request.body);
    },
  );

  r.delete(
    '/stations/:stationId/shows/:showId/episodes/:episodeId',
    { preHandler: read, schema: { params: episodeParams } },
    async (request, reply) => {
      const { showId, episodeId } = request.params;
      await requireShowWrite(request, showId);
      await repo.deleteEpisode(app.db, ctx(request), showId, episodeId);
      return reply.code(204).send();
    },
  );

  // --- Occurrences ---

  r.get(
    '/stations/:stationId/show-occurrences',
    {
      preHandler: read,
      schema: {
        params: stationParams,
        querystring: showOccurrencesQuerySchema,
        response: { 200: showOccurrencesResponseSchema },
      },
    },
    (request) => repo.getOccurrences(app.db, stationScopeOf(request), request.query),
  );
}
