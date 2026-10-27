import { NotFoundError } from '@ondes/db';
import {
  createLiveEventSchema,
  createStreamerSchema,
  liveConnectionInfoSchema,
  liveEventListSchema,
  liveEventSchema,
  liveRequestListSchema,
  liveSessionSchema,
  liveStatusSchema,
  putLiveOnAirSchema,
  realtimeEventSchema,
  setStreamerPasswordSchema,
  streamerListSchema,
  streamerSchema,
  streamerWithPasswordSchema,
  updateLiveEventSchema,
  updateStreamerSchema,
  uuidSchema,
} from '@ondes/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, stationScopeOf } from '../../plugins/auth.ts';
import { HttpError } from '../../plugins/errors.ts';
import { listRunningStationScopes } from '../engine/lifecycle/repo.ts';
import {
  type FallbackDeps,
  generatorClockMusic,
  gridClockResolver,
} from '../shows/episode-check/fallback.ts';
import { createLiveAuthHandler, type LoginFailureLimiter } from './auth.ts';
import * as events from './events.ts';
import * as repo from './repo.ts';
import * as requests from './requests.ts';
import { createLiveRevoker, liveHolder } from './revoke.ts';
import { createLiveSlotCheck } from './slot-check.ts';
import { createLiveSwitcher, type LiveSwitchEngineLookup } from './switching.ts';
import { LIVE_AUTH_ROUTE } from './url.ts';

// Live streamers API (#63) and live switching (#64), under /api/v1/stations/:stationId/live,
// and the internal harbor auth route the station engines call.
// - `live:manage` (station managers) creates, edits and deletes streamers and sets passwords.
// - `live:read` lists streamers and reads the connection info. Without `live:manage`, a user
//   only sees the streamers linked to them, and with `live:broadcast` may reset their password.
// - `live:read` also reads the harbor pool's status; `engine:control` puts a connected DJ on
//   air, hands the air back to automation and hangs a DJ up (#64, ADR 0027).
// - Live slots, ad-hoc live and events (#65, ADR 0033): `live:read` lists the pending ad-hoc
//   requests and the events, `engine:control` approves or refuses a request, `live:manage`
//   writes events. The switch sweep also runs the missed-live-slot check (`slot-check.ts`).

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
   * The station's engine (the lifecycle's `adapterFor`): live switching, and taking a revoked
   * streamer off air. Unset: no engines here, nothing to switch or revoke.
   */
  engineFor?: LiveSwitchEngineLookup;
  /** How often expired streamers are swept off air. Default 30 s; 0 turns it off (tests). */
  sweepIntervalMs?: number;
  /**
   * How often each running station is checked for a DJ waiting in their live slot and for a
   * session the engine lost (#64). Default 5 s; 0 turns it off (tests).
   */
  switchIntervalMs?: number;
  /** What a missed live slot's fallback resolves with. Default: the station's grid and log. */
  fallback?: FallbackDeps;
};

const stationParams = z.object({ stationId: z.string() });
const streamerParams = stationParams.extend({ streamerId: uuidSchema });
const inputParams = stationParams.extend({ input: z.coerce.number().int().min(1).max(16) });
const requestParams = stationParams.extend({ requestId: uuidSchema });
const eventParams = stationParams.extend({ eventId: uuidSchema });
const candidatesSchema = z.object({
  users: z.array(z.object({ id: uuidSchema, name: z.string() })),
});

export const livePlugin = fp(
  async (app: FastifyInstance, options: LivePluginOptions) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const read = app.requirePermission('live', 'read');
    const manage = app.requirePermission('live', 'manage');
    const publicHost = options.publicHost || new URL(app.auth.config.appUrl).hostname;
    const control = app.requirePermission('engine', 'control');
    const BASE = '/api/v1/stations/:stationId/live';
    const rabbit = app.hasDecorator('rabbit') ? app.rabbit : undefined;
    const slotCheck = createLiveSlotCheck({
      db: app.db,
      alerts: app.hasDecorator('alerts') ? app.alerts : undefined,
      fallback: options.fallback ?? {
        resolveClock: gridClockResolver(app.db),
        clockMusic: generatorClockMusic(app.db),
      },
      logEvents: rabbit?.events,
      logger: app.log,
    });
    const switcher = createLiveSwitcher({
      db: app.db,
      engineFor: options.engineFor,
      publish: rabbit ? (event) => rabbit.events.publish(event) : undefined,
      logger: app.log,
      // A streamer still connected though they may not be: revoke again (retries a failed
      // hang-up, and catches an expiry the expiry sweep missed).
      onNotAllowed: (scope, streamerId, reason) => revoker.revoke(scope, streamerId, reason),
      onSlotLive: (scope, occurrence) => slotCheck.onSlotLive(scope, occurrence),
    });
    const revoker = createLiveRevoker({
      db: app.db,
      engineFor: options.engineFor,
      logger: app.log,
      endSession: (scope, streamerId) =>
        switcher.endSessionOf(
          { actor: { type: 'system', name: 'live' }, scope },
          streamerId,
          'revoked',
        ),
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

    r.get(
      `${BASE}/status`,
      { preHandler: read, schema: { params: stationParams, response: { 200: liveStatusSchema } } },
      async (request) => {
        const scope = stationScopeOf(request);
        const { enabled } = await repo.connectionInfo(app.db, scope, publicHost);
        return switcher.status(scope, enabled);
      },
    );

    // Puts the DJ connected on an input on air (a handover if another DJ is on).
    r.put(
      `${BASE}/on-air`,
      {
        preHandler: control,
        schema: {
          params: stationParams,
          body: putLiveOnAirSchema,
          response: { 200: liveSessionSchema },
        },
      },
      (request) => switcher.goLive(ctx(request), request.body.input, 'manual'),
    );

    // Back to automation: the return file, then the log at the current time.
    r.delete(
      `${BASE}/on-air`,
      { preHandler: control, schema: { params: stationParams } },
      async (request, reply) => {
        await switcher.returnToAutomation(ctx(request));
        return reply.code(204).send();
      },
    );

    // Hangs up the DJ on one input of the pool.
    r.post(
      `${BASE}/inputs/:input/disconnect`,
      {
        preHandler: control,
        schema: {
          params: inputParams,
          response: { 200: z.object({ disconnected: z.boolean() }) },
        },
      },
      async (request) => ({
        disconnected: await switcher.disconnect(ctx(request), request.params.input),
      }),
    );

    // Ad-hoc requests (#65): DJs connected outside their slots, waiting for a manager.
    r.get(
      `${BASE}/requests`,
      {
        preHandler: read,
        schema: { params: stationParams, response: { 200: liveRequestListSchema } },
      },
      async (request) => ({
        requests: await requests.listPending(app.db, stationScopeOf(request)),
      }),
    );

    r.post(
      `${BASE}/requests/:requestId/approve`,
      {
        preHandler: control,
        schema: { params: requestParams, response: { 200: liveSessionSchema } },
      },
      (request) => switcher.approve(ctx(request), request.params.requestId),
    );

    r.post(
      `${BASE}/requests/:requestId/refuse`,
      { preHandler: control, schema: { params: requestParams } },
      async (request, reply) => {
        await switcher.refuse(ctx(request), request.params.requestId);
        return reply.code(204).send();
      },
    );

    // Events (#65): one-off live blocks with a title.
    r.get(
      `${BASE}/events`,
      {
        preHandler: read,
        schema: { params: stationParams, response: { 200: liveEventListSchema } },
      },
      async (request) => ({ events: await events.listEvents(app.db, stationScopeOf(request)) }),
    );

    r.post(
      `${BASE}/events`,
      {
        preHandler: manage,
        schema: {
          params: stationParams,
          body: createLiveEventSchema,
          response: { 201: liveEventSchema },
        },
      },
      async (request, reply) =>
        reply.code(201).send(await events.createEvent(app.db, ctx(request), request.body)),
    );

    r.patch(
      `${BASE}/events/:eventId`,
      {
        preHandler: manage,
        schema: {
          params: eventParams,
          body: updateLiveEventSchema,
          response: { 200: liveEventSchema },
        },
      },
      (request) => events.updateEvent(app.db, ctx(request), request.params.eventId, request.body),
    );

    r.delete(
      `${BASE}/events/:eventId`,
      { preHandler: manage, schema: { params: eventParams } },
      async (request, reply) => {
        await events.deleteEvent(app.db, ctx(request), request.params.eventId);
        return reply.code(204).send();
      },
    );

    if (options.engineFor && rabbit) {
      const subscription = rabbit.subscribeEvents((raw) => {
        const event = realtimeEventSchema.safeParse(raw);
        if (event.success) void switcher.onEvent(event.data);
      });
      app.addHook('onClose', async () => {
        await subscription.close();
      });
    }

    const switchMs = options.switchIntervalMs ?? 5_000;
    if (options.engineFor && switchMs > 0) {
      let running = false;
      const timer = setInterval(() => {
        if (running) return;
        running = true;
        (async () => {
          for (const scope of await listRunningStationScopes(app.db)) {
            await switcher
              .sweep(scope)
              .catch((err: unknown) =>
                app.log.error({ err, stationId: scope.stationId }, 'Live switching sweep failed'),
              );
            await slotCheck
              .sweep(scope)
              .catch((err: unknown) =>
                app.log.error({ err, stationId: scope.stationId }, 'Live slot check failed'),
              );
          }
        })()
          .catch((err: unknown) => app.log.error({ err }, 'Live switching sweep failed'))
          .finally(() => {
            running = false;
          });
      }, switchMs);
      timer.unref();
      app.addHook('onClose', () => clearInterval(timer));
    }

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
