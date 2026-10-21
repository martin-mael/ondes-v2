import { randomUUID } from 'node:crypto';
import {
  type Db,
  deleteAsset,
  getAssetDetail,
  LibraryConflictError,
  listAssets,
  listTags,
  NotFoundError,
  type StationScope,
  setAssetTags,
  updateAsset,
  updateCues,
} from '@ondes/db';
import {
  type Actor,
  type ListAssetsQuery,
  type RealtimeEvent,
  realtimeEventSchema,
  setAssetTagsSchema,
  updateAssetSchema,
  updateCuesSchema,
  uuidSchema,
} from '@ondes/shared';
import { z } from 'zod';

// Library read/update API (#17), under /api/v1/stations/:stationId/…
//
// Fastify arrives with #6. Until then the routes are plain handler functions plus
// `registerLibraryRoutes`, which mounts them on anything with a Fastify-like `route()`. The
// auth layer supplies `resolveContext`: it authenticates the caller, checks the permission
// for `:stationId` and returns the actor and the resolved station scope. Assets are created
// by ingest (#18), not here.

export interface LibraryDeps {
  db: Db;
  /**
   * Publishes `asset.updated` / `asset.deleted` after a committed change to how an asset plays
   * (#55: islands re-derive). Optional: without RabbitMQ nothing is published.
   */
  publish?: (event: RealtimeEvent) => Promise<void>;
}

/** Publishes after the commit; a failed publish doesn't fail the request (the change is stored). */
async function announce(
  deps: LibraryDeps,
  ctx: RequestContext,
  event:
    | { type: 'asset.updated'; data: { assetId: string; changes: AssetChange[] } }
    | { type: 'asset.deleted'; data: { assetId: string } },
) {
  if (!deps.publish) return;
  try {
    await deps.publish(
      realtimeEventSchema.parse({
        id: randomUUID(),
        stationId: ctx.scope.stationId,
        at: new Date().toISOString(),
        ...event,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({ msg: 'library event publish failed', type: event.type, err: String(error) }),
    );
  }
}

type AssetChange = 'cues' | 'loudness' | 'settings';

export interface RequestContext {
  actor: Actor;
  scope: StationScope;
}

/** `resource:action`, checked by the auth layer before the handler runs. */
export interface Permission {
  resource: 'library';
  action: 'read' | 'write';
}

export interface RouteRequest {
  params: unknown;
  query: unknown;
  body: unknown;
}

export interface RouteResult {
  status: number;
  body?: unknown;
}

export interface LibraryRoute {
  method: 'GET' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  permission: Permission;
  handler: (deps: LibraryDeps, ctx: RequestContext, request: RouteRequest) => Promise<RouteResult>;
}

const STATION = '/api/v1/stations/:stationId';
const assetParamsSchema = z.object({ assetId: uuidSchema });
const read: Permission = { resource: 'library', action: 'read' };
const write: Permission = { resource: 'library', action: 'write' };

const assetId = (request: RouteRequest) => assetParamsSchema.parse(request.params).assetId;

export const libraryRoutes: LibraryRoute[] = [
  {
    method: 'GET',
    url: `${STATION}/assets`,
    permission: read,
    // listAssets validates the query string itself.
    handler: async ({ db }, { scope }, request) => ({
      status: 200,
      body: await listAssets(db, scope, (request.query ?? {}) as ListAssetsQuery),
    }),
  },
  {
    method: 'GET',
    url: `${STATION}/assets/:assetId`,
    permission: read,
    handler: async ({ db }, { scope }, request) => ({
      status: 200,
      body: await getAssetDetail(db, scope, assetId(request)),
    }),
  },
  {
    method: 'PATCH',
    url: `${STATION}/assets/:assetId`,
    permission: write,
    handler: async (deps, ctx, request) => {
      const id = assetId(request);
      const body = await updateAsset(deps.db, ctx, id, updateAssetSchema.parse(request.body));
      await announce(deps, ctx, {
        type: 'asset.updated',
        data: { assetId: id, changes: ['settings'] },
      });
      return { status: 200, body };
    },
  },
  {
    method: 'DELETE',
    url: `${STATION}/assets/:assetId`,
    permission: write,
    handler: async (deps, ctx, request) => {
      const id = assetId(request);
      // Released objects are queued; the worker's storage sweep deletes them later.
      await deleteAsset(deps.db, ctx, id);
      await announce(deps, ctx, { type: 'asset.deleted', data: { assetId: id } });
      return { status: 204 };
    },
  },
  {
    method: 'PUT',
    url: `${STATION}/assets/:assetId/cues`,
    permission: write,
    handler: async (deps, ctx, request) => {
      const id = assetId(request);
      const body = await updateCues(deps.db, ctx, id, updateCuesSchema.parse(request.body));
      await announce(deps, ctx, {
        type: 'asset.updated',
        data: { assetId: id, changes: ['cues'] },
      });
      return { status: 200, body };
    },
  },
  {
    method: 'PUT',
    url: `${STATION}/assets/:assetId/tags`,
    permission: write,
    handler: async ({ db }, ctx, request) => ({
      status: 200,
      body: {
        tags: await setAssetTags(db, ctx, assetId(request), setAssetTagsSchema.parse(request.body)),
      },
    }),
  },
  {
    method: 'GET',
    url: `${STATION}/tags`,
    permission: read,
    handler: async ({ db }, { scope }) => ({
      status: 200,
      body: { tags: await listTags(db, scope) },
    }),
  },
];

/** Maps domain errors to HTTP. Anything else is rethrown (500, via the errors plugin). */
export function toErrorResult(error: unknown): RouteResult {
  if (error instanceof NotFoundError) {
    return { status: 404, body: { error: 'not_found', message: error.message } };
  }
  if (error instanceof z.ZodError) {
    return { status: 400, body: { error: 'invalid_request', issues: error.issues } };
  }
  if (error instanceof LibraryConflictError) {
    return { status: 409, body: { error: 'conflict', message: error.message } };
  }
  throw error;
}

/** Runs one route: context, handler, error mapping. */
export async function runRoute(
  route: LibraryRoute,
  deps: LibraryDeps,
  resolveContext: ResolveContext,
  request: RouteRequest,
): Promise<RouteResult> {
  try {
    const ctx = await resolveContext(request, route.permission);
    return await route.handler(deps, ctx, request);
  } catch (error) {
    return toErrorResult(error);
  }
}

/** Authenticates the caller and checks `permission` on the station in `request.params`. */
export type ResolveContext = (
  request: RouteRequest,
  permission: Permission,
) => Promise<RequestContext>;

/** The subset of Fastify's reply the routes use. */
export interface RouteReply {
  code(status: number): RouteReply;
  send(body?: unknown): unknown;
}

/** The subset of a Fastify instance the routes need (`app.route`). */
export interface RouteRegistrar {
  route(options: {
    method: LibraryRoute['method'];
    url: string;
    handler: (request: RouteRequest, reply: RouteReply) => Promise<unknown>;
  }): unknown;
}

/** Mounts the library routes: `registerLibraryRoutes(app, deps, auth.resolveStationContext)`. */
export function registerLibraryRoutes(
  app: RouteRegistrar,
  deps: LibraryDeps,
  resolveContext: ResolveContext,
): void {
  for (const route of libraryRoutes) {
    app.route({
      method: route.method,
      url: route.url,
      handler: async (request, reply) => {
        const result = await runRoute(route, deps, resolveContext, request);
        return reply.code(result.status).send(result.body);
      },
    });
  }
}
