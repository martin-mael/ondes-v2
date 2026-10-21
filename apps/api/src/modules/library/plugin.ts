import type { FastifyInstance } from 'fastify';
import { actorOf, stationScopeOf } from '../../plugins/auth.ts';
import { type LibraryDeps, libraryRoutes, runRoute } from './routes.ts';

/**
 * Mounts the library routes (#17) on Fastify. Each route is guarded by
 * `requirePermission('library', read | write)` on its `:stationId`, which authenticates the
 * caller and resolves the station scope; the handler then gets that scope and the actor.
 * The routes carry their full `/api/v1/stations/:stationId/…` path: register without prefix.
 */
export async function libraryPlugin(app: FastifyInstance) {
  const deps: LibraryDeps = { db: app.db };
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
