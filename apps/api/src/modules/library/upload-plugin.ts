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
// they started.
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
 * Guard of the write routes: `library:write`, or else `show:write_own` for an episode upload:
 * a new one for a show the caller hosts (`showId` in the body; `show:write` may name any show),
 * or one the signed-in caller started. Runs after body parsing (not a marked auth guard), which
 * the create check needs.
 */
function uploadWriteGuard(app: FastifyInstance): preHandlerAsyncHookHandler {
  const libraryWrite = app.requirePermission('library', 'write');
  const showWriteOwn = app.requirePermission('show', 'write_own');
  return async function guard(request, reply) {
    try {
      await libraryWrite.call(app, request, reply);
      return;
    } catch (error) {
      if (!(error instanceof HttpError && error.code === 'forbidden')) throw error;
      const auth = request.auth;
      if (auth?.kind !== 'session') throw error;
      try {
        await showWriteOwn.call(app, request, reply);
      } catch {
        throw error;
      }
      const params = paramsSchema.safeParse(request.params);
      const scope = stationScopeOf(request);
      if (!params.success) {
        const body = request.body as { assetType?: unknown; showId?: unknown } | undefined;
        const showId = uuidSchema.safeParse(body?.showId);
        if (body?.assetType === 'episode' && showId.success) {
          if (request.permissions?.has('show:write')) return;
          if (await isHost(app.db, scope, showId.data, auth.user.id)) return;
        }
      } else {
        const found = await getUpload(app.db, scope, params.data.uploadId);
        if (found.assetType === 'episode' && found.createdBy === auth.user.id) return;
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
