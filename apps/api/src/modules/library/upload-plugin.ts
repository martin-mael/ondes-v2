import { getUpload, listUploads, toUpload } from '@ondes/db';
import { type ListUploadsQuery, uuidSchema } from '@ondes/shared';
import { QuotaExceededError, type Storage } from '@ondes/storage';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorOf, stationScopeOf } from '../../plugins/auth.ts';
import { type RouteResult, toErrorResult } from './routes.ts';
import {
  abortUpload,
  completeUpload,
  createUploadSession,
  ingestJob,
  listUploadedParts,
  presignParts,
  removeUpload,
  type UploadDeps,
} from './upload-service.ts';

// Upload routes (#18), under /api/v1/stations/:stationId/uploads, each behind
// `requirePermission('library', read | write)`. See upload-service.ts for the flow.

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
  for (const route of routes) {
    app.route({
      method: route.method,
      url: route.url,
      preHandler: app.requirePermission('library', route.action),
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
