import type { Storage } from '@ondes/storage';
import type { FastifyInstance } from 'fastify';
import { actorOf, stationScopeOf } from '../../plugins/auth.ts';
import { type LibraryDeps, libraryRoutes, runRoute } from './routes.ts';

export interface LibraryPluginOptions {
  storage: Pick<Storage, 'delete'>;
  onOrphanedObjects?: LibraryDeps['onOrphanedObjects'];
}

/**
 * Mounts the library routes (#17) on Fastify. Each route is guarded by
 * `requirePermission('library', read | write)` on its `:stationId`, which authenticates the
 * caller and resolves the station scope; the handler then gets that scope and the actor.
 * The routes carry their full `/api/v1/stations/:stationId/…` path: register without prefix.
 */
export async function libraryPlugin(app: FastifyInstance, options: LibraryPluginOptions) {
  const deps: LibraryDeps = {
    db: app.db,
    storage: options.storage,
    onOrphanedObjects:
      options.onOrphanedObjects ??
      ((keys) => app.log.warn({ keys }, 'library: objects left in the bucket after a delete')),
  };
  for (const route of libraryRoutes) {
    app.route({
      method: route.method,
      url: route.url,
      preHandler: app.requirePermission(route.permission.resource, route.permission.action),
      handler: async (request, reply) => {
        const result = await runRoute(
          route,
          deps,
          async () => ({ actor: actorOf(request), scope: stationScopeOf(request) }),
          request,
        );
        return reply.code(result.status).send(result.body);
      },
    });
  }
}
