import { NotFoundError } from '@ondes/db';
import {
  createStreamerSchema,
  liveConnectionInfoSchema,
  setStreamerPasswordSchema,
  streamerListSchema,
  streamerSchema,
  streamerWithPasswordSchema,
  updateStreamerSchema,
  uuidSchema,
} from '@ondes/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, stationScopeOf } from '../../plugins/auth.ts';
import { HttpError } from '../../plugins/errors.ts';
import { createLiveAuthHandler, type LoginFailureLimiter } from './auth.ts';
import * as repo from './repo.ts';
import { createLiveRevoker, type LiveEngineLookup, liveHolder } from './revoke.ts';
import { LIVE_AUTH_ROUTE } from './url.ts';

// Live streamers API (#63), under /api/v1/stations/:stationId/live, and the internal harbor
// auth route the station engines call.
// - `live:manage` (station managers) creates, edits and deletes streamers and sets passwords.
// - `live:read` lists streamers and reads the connection info. Without `live:manage`, a user
//   only sees the streamers linked to them, and with `live:broadcast` may reset their password.

export type LivePluginOptions = {
  /** Host name DJs connect to. Default: the app URL's host. */
  publicHost?: string;
  /**
   * The station's engine token, which the harbor auth route checks (the engine lifecycle's
   * `tokenFor`). Unset: no engines here, no route.
   */
  tokenFor?: (stationId: string) => string | undefined | Promise<string | undefined>;
  limiter?: LoginFailureLimiter;
  /**
   * The station's engine (the lifecycle's `adapterFor`), to take a revoked streamer off air.
   * Unset: no engines here, nothing to revoke.
   */
  engineFor?: LiveEngineLookup;
  /** How often expired streamers are swept off air. Default 30 s; 0 turns it off (tests). */
  sweepIntervalMs?: number;
};

const stationParams = z.object({ stationId: z.string() });
const streamerParams = stationParams.extend({ streamerId: uuidSchema });
const candidatesSchema = z.object({
  users: z.array(z.object({ id: uuidSchema, name: z.string() })),
});

export const livePlugin = fp(
  async (app: FastifyInstance, options: LivePluginOptions) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const read = app.requirePermission('live', 'read');
    const manage = app.requirePermission('live', 'manage');
    const publicHost = options.publicHost || new URL(app.auth.config.appUrl).hostname;
    const BASE = '/api/v1/stations/:stationId/live';
    const revoker = createLiveRevoker({
      db: app.db,
      engineFor: options.engineFor,
      logger: app.log,
    });
    const ctx = (request: FastifyRequest) => ({
      actor: actorOf(request),
      scope: stationScopeOf(request),
    });
    const canManage = (request: FastifyRequest) => !!request.permissions?.has('live:manage');
    /** Non-managers see their own streamers only (null: none, for an API key). */
    const ownerOf = (request: FastifyRequest): string | null | undefined => {
      if (canManage(request)) return undefined;
      const auth = request.auth;
      return auth?.kind === 'session' ? auth.user.id : null;
    };
    /** The streamer, if the caller may see it (404 otherwise, never 403). */
    const visible = async (request: FastifyRequest, streamerId: string) => {
      const s = await repo.getStreamer(app.db, stationScopeOf(request), streamerId);
      const owner = ownerOf(request);
      if (owner !== undefined && (owner === null || s.user?.id !== owner)) {
        throw new NotFoundError('streamer', streamerId);
      }
      return s;
    };

    r.get(
      `${BASE}/streamers`,
      {
        preHandler: read,
        schema: { params: stationParams, response: { 200: streamerListSchema } },
      },
      async (request) => ({
        streamers: await repo.listStreamers(app.db, stationScopeOf(request), ownerOf(request)),
      }),
    );

    r.get(
      `${BASE}/streamers/user-candidates`,
      {
        preHandler: manage,
        schema: { params: stationParams, response: { 200: candidatesSchema } },
      },
      async (request) => ({
        users: await repo.listUserCandidates(app.db, stationScopeOf(request)),
      }),
    );

    r.post(
      `${BASE}/streamers`,
      {
        preHandler: manage,
        schema: {
          params: stationParams,
          body: createStreamerSchema,
          response: { 201: streamerWithPasswordSchema },
        },
      },
      async (request, reply) =>
        reply.code(201).send(await repo.createStreamer(app.db, ctx(request), request.body)),
    );

    r.get(
      `${BASE}/streamers/:streamerId`,
      { preHandler: read, schema: { params: streamerParams, response: { 200: streamerSchema } } },
      (request) => visible(request, request.params.streamerId),
    );

    r.patch(
      `${BASE}/streamers/:streamerId`,
      {
        preHandler: manage,
        schema: {
          params: streamerParams,
          body: updateStreamerSchema,
          response: { 200: streamerSchema },
        },
      },
      async (request) => {
        const updated = await repo.updateStreamer(
          app.db,
          ctx(request),
          request.params.streamerId,
          request.body,
        );
        // Disabled or expired while live: off air now, not at the next connection.
        if (updated.status !== 'active') {
          await revoker.revoke(stationScopeOf(request), updated.id, updated.status);
        }
        return updated;
      },
    );

    // Managers, or the DJ linked to the streamer (`live:broadcast`).
    r.post(
      `${BASE}/streamers/:streamerId/password`,
      {
        preHandler: read,
        schema: {
          params: streamerParams,
          body: setStreamerPasswordSchema,
          response: { 200: streamerWithPasswordSchema },
        },
      },
      async (request) => {
        await visible(request, request.params.streamerId);
        if (!canManage(request) && !request.permissions?.has('live:broadcast')) {
          throw new HttpError(403, 'forbidden', 'missing permission live:broadcast');
        }
        return repo.setStreamerPassword(
          app.db,
          ctx(request),
          request.params.streamerId,
          request.body,
        );
      },
    );

    r.delete(
      `${BASE}/streamers/:streamerId`,
      { preHandler: manage, schema: { params: streamerParams } },
      async (request, reply) => {
        const { streamerId } = request.params;
        const scope = stationScopeOf(request);
        const wasHolder = (await liveHolder(app.db, scope.stationId)) === streamerId;
        await repo.deleteStreamer(app.db, ctx(request), streamerId);
        if (wasHolder) await revoker.revoke(scope, streamerId, 'deleted', true);
        return reply.code(204).send();
      },
    );

    r.get(
      `${BASE}/connection`,
      {
        preHandler: read,
        schema: { params: stationParams, response: { 200: liveConnectionInfoSchema } },
      },
      (request) => repo.connectionInfo(app.db, stationScopeOf(request), publicHost),
    );

    const sweepMs = options.sweepIntervalMs ?? 30_000;
    if (options.engineFor && sweepMs > 0) {
      let running = false;
      const timer = setInterval(() => {
        if (running) return;
        running = true;
        revoker
          .sweep()
          .catch((err: unknown) => app.log.error({ err }, 'Live expiry sweep failed'))
          .finally(() => {
            running = false;
          });
      }, sweepMs);
      timer.unref();
      app.addHook('onClose', () => clearInterval(timer));
    }

    // Internal only (the engines' live_auth_url): never route /internal through Caddy.
    if (options.tokenFor) {
      const handle = createLiveAuthHandler({
        db: app.db,
        tokenFor: options.tokenFor,
        limiter: options.limiter,
        logger: app.log,
      });
      app.post(LIVE_AUTH_ROUTE, async (request, reply) => {
        const { stationId } = stationParams.parse(request.params);
        const res = await handle({ stationId, headers: request.headers, body: request.body });
        reply.code(res.status);
        return res.body;
      });
    }
  },
  { name: 'live', dependencies: ['db', 'auth'] },
);
