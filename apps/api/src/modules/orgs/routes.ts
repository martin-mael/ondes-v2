import { myOrgsResponseSchema } from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sessionOf } from '../../plugins/auth.ts';
import { listUserOrgs } from './repo.ts';

// Orgs (#9): what the signed-in user can open. Org and station management routes come later.

export async function orgRoutes(app: FastifyInstance) {
  app
    .withTypeProvider<ZodTypeProvider>()
    .get(
      '/orgs',
      { preHandler: app.requireUser, schema: { response: { 200: myOrgsResponseSchema } } },
      async (request) => ({ orgs: await listUserOrgs(app.db, sessionOf(request).user.id) }),
    );
}
