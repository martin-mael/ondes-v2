import { getUpload, listUploads, toUpload } from '@ondes/db';
import { type ListUploadsQuery, uuidSchema } from '@ondes/shared';
import { QuotaExceededError, type Storage } from '@ondes/storage';
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { actorOf, stationScopeOf } from '../../plugins/auth.ts';
import { HttpError } from '../../plugins/errors.ts';
import { isHost } from '../shows/repo.ts';
import { type RouteResult, toErrorResult } from './routes.ts';
import {
  abortUpload,
  completeUpload,
  createUploadSession,
  ingestJob,
  listUploadedParts,
  presignParts,
  removeUpload,
  retryUpload,
  type UploadDeps,
} from './upload-service.ts';

// Upload routes (#18), under /api/v1/stations/:stationId/uploads, each behind
// `requirePermission('library', read | write)`. See upload-service.ts for the flow.
//
// Presenters (#45) have `show:write_own` but not `library:write`: they may still upload the
// audio of their episodes, i.e. `episode` uploads for a show they host, and act on the uploads
// they started. With `voice_track:write_own` they may also upload the voice tracks they record
// in the segue editor (#59): `vt` uploads, and act on the ones they started.
// Attaching the asset to an episode is the shows api's check (`show:write_own` on the show).

export interface UploadPluginOptions {
  storage: Storage;
  /** Overrides the RabbitMQ publisher (tests). Default: `app.rabbit.jobs`. */
  enqueueIngest?: UploadDeps['enqueueIngest'];
  presignExpiresIn?: number;
}

const STATION = '/api/v1/stations/:stationId';
const paramsSchema = z.object({ uploadId: uuidSchema });

type Ctx = Parameters<typeof createUploadSession>[1];
type Handler = (deps: UploadDeps, ctx: Ctx, request: FastifyRequest) => Promise<RouteResult>;

const uploadId = (request: FastifyRequest) => paramsSchema.parse(request.params).uploadId;

/**
 * Guard of the write routes: `library:write`, or else, for a signed-in caller:
 * - `show:write_own` for an episode upload: a new one for a show the caller hosts (`showId` in
 *   the body; `show:write` may name any show), or one the caller started;
 * - `voice_track:write_own` (or `voice_track:write`) for a voice track recorded in the browser
 *   (#59): a new `vt` upload, or one the caller started.
 * Runs after body parsing (not a marked auth guard), which the create check needs.
 */
function uploadWriteGuard(app: FastifyInstance): preHandlerAsyncHookHandler {
  const libraryWrite = app.requirePermission('library', 'write');
  const showWriteOwn = app.requirePermission('show', 'write_own');
  const voiceWrite = app.requirePermission('voice_track', 'write');
  const voiceWriteOwn = app.requirePermission('voice_track', 'write_own');
  return async function guard(request, reply) {
    try {
      await libraryWrite.call(app, request, reply);
      return;
    } catch (error) {
      if (!(error instanceof HttpError && error.code === 'forbidden')) throw error;
      const auth = request.auth;
      if (auth?.kind !== 'session') throw error;
      const holds = async (...guards: preHandlerAsyncHookHandler[]) => {
        for (const g of guards) {
          try {
            await g.call(app, request, reply);
            return true;
          } catch (failure) {
            // Missing that permission: try the next. Anything else (db down, 2FA required,
            // not a member of the station) is the answer.
            if (!(failure instanceof HttpError && failure.code === 'forbidden')) throw failure;
          }
        }
        return false;
      };
      // The scope (and `request.permissions`) exist once one of these guards passed.
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        const body = request.body as { assetType?: unknown; showId?: unknown } | undefined;
        if (body?.assetType === 'vt' && (await holds(voiceWriteOwn, voiceWrite))) return;
        const showId = uuidSchema.safeParse(body?.showId);
        if (body?.assetType === 'episode' && showId.success && (await holds(showWriteOwn))) {
          if (request.permissions?.has('show:write')) return;
          const scope = stationScopeOf(request);
          if (await isHost(app.db, scope, showId.data, auth.user.id)) return;
        }
      } else if (await holds(showWriteOwn, voiceWriteOwn, voiceWrite)) {
        const found = await getUpload(app.db, stationScopeOf(request), params.data.uploadId);
        const held = request.permissions;
        const may =
          (found.assetType === 'episode' && held?.has('show:write_own')) ||
          (found.assetType === 'vt' &&
            (held?.has('voice_track:write_own') || held?.has('voice_track:write')));
        if (may && found.createdBy === auth.user.id) return;
      }
      throw error;
    }
  };
}

const routes: {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  action: 'read' | 'write';
  handler: Handler;
}[] = [
  {
    method: 'POST',
    url: `${STATION}/uploads`,
    action: 'write',
    handler: async (deps, ctx, request) => ({
      status: 201,
      body: await createUploadSession(deps, ctx, request.body),
    }),
  },
  {
    method: 'GET',
    url: `${STATION}/uploads`,
    action: 'read',
    handler: async (deps, ctx, request) => ({
      status: 200,
      body: await listUploads(deps.db, ctx.scope, (request.query ?? {}) as ListUploadsQuery),
    }),
  },
  {
    method: 'GET',
    url: `${STATION}/uploads/:uploadId`,
    action: 'read',
    handler: async (deps, ctx, request) => ({
      status: 200,
      body: toUpload(await getUpload(deps.db, ctx.scope, uploadId(request))),
    }),
  },
  {
    method: 'POST',
    url: `${STATION}/uploads/:uploadId/parts`,
    action: 'write',
    handler: async (deps, ctx, request) => ({
      status: 200,
      body: await presignParts(deps, ctx, uploadId(request), request.body),
    }),
  },
  {
    method: 'GET',
    url: `${STATION}/uploads/:uploadId/parts`,
    action: 'write',
    handler: async (deps, ctx, request) => ({
      status: 200,
      body: await listUploadedParts(deps, ctx, uploadId(request)),
    }),
  },
  {
    method: 'POST',
    url: `${STATION}/uploads/:uploadId/complete`,
    action: 'write',
    handler: async (deps, ctx, request) => ({
      status: 202,
      body: await completeUpload(deps, ctx, uploadId(request)),
    }),
  },
  {
    method: 'POST',
    url: `${STATION}/uploads/:uploadId/abort`,
    action: 'write',
    handler: async (deps, ctx, request) => ({
      status: 200,
      body: await abortUpload(deps, ctx, uploadId(request)),
    }),
  },
  {
    method: 'POST',
    url: `${STATION}/uploads/:uploadId/retry`,
    action: 'write',
    handler: async (deps, ctx, request) => ({
      status: 202,
      body: await retryUpload(deps, ctx, uploadId(request)),
    }),
  },
  {
    method: 'DELETE',
    url: `${STATION}/uploads/:uploadId`,
    action: 'write',
    handler: async (deps, ctx, request) => {
      await removeUpload(deps, ctx, uploadId(request));
      return { status: 204 };
    },
  },
];

function toUploadErrorResult(error: unknown): RouteResult {
  if (error instanceof QuotaExceededError) {
    return {
      status: 413,
      body: {
        error: 'quota_exceeded',
        message: error.message,
        details: { usedBytes: error.usedBytes, limitBytes: error.limitBytes },
      },
    };
  }
  return toErrorResult(error);
}

/** Mounts the upload routes. Registered by `buildApp` when it has a `storage`. */
export async function uploadPlugin(app: FastifyInstance, options: UploadPluginOptions) {
  const deps: UploadDeps = {
    db: app.db,
    storage: options.storage,
    presignExpiresIn: options.presignExpiresIn,
    enqueueIngest:
      options.enqueueIngest ??
      (async (payload) => {
        if (!app.hasDecorator('rabbit')) throw new Error('RabbitMQ is not configured');
        await app.rabbit.jobs.enqueue(ingestJob, payload, {
          orgId: payload.orgId,
          stationId: payload.stationId,
        });
      }),
  };
  const writeGuard = uploadWriteGuard(app);
  for (const route of routes) {
    app.route({
      method: route.method,
      url: route.url,
      preHandler: route.action === 'write' ? writeGuard : app.requirePermission('library', 'read'),
      handler: async (request, reply) => {
        let result: RouteResult;
        try {
          const ctx = { actor: actorOf(request), scope: stationScopeOf(request) };
          result = await route.handler(deps, ctx, request);
        } catch (error) {
          result = toUploadErrorResult(error);
        }
        return reply.code(result.status).send(result.body);
      },
    });
  }
}
