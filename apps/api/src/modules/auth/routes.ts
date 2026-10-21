import { listApiKeys, revokeApiKey } from '@ondes/db';
import {
  acceptedResponseSchema,
  apiKeySchema,
  createApiKeyRequestSchema,
  createApiKeyResponseSchema,
  createInvitationSchema,
  disableTotpSchema,
  emailOnlySchema,
  invitationSchema,
  loginResponseSchema,
  loginSchema,
  loginSecondFactorSchema,
  meSchema,
  orgAuthPolicySchema,
  recoveryCodesResponseSchema,
  resetPasswordSchema,
  signupSchema,
  stationRoleSchema,
  tokenOnlySchema,
  totpCodeOnlySchema,
  totpSetupResponseSchema,
  updateOrgAuthPolicySchema,
  uuidSchema,
} from '@ondes/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, orgScopeOf, sessionOf } from '../../plugins/auth.ts';
import { HttpError } from '../../plugins/errors.ts';
import * as service from './service.ts';

// Auth routes (#6). Account flows live under `/api/v1/auth`; tenant-scoped ones (invitations,
// API keys, the org's 2FA policy) under `/api/v1/orgs/:orgId/…` and `/api/v1/stations/:stationId/…`.

const orgParams = z.object({ orgId: z.string() });
const stationParams = z.object({ stationId: z.string() });
const invitationParams = z.object({ invitationId: uuidSchema });
const apiKeyParams = z.object({ apiKeyId: uuidSchema });

const stationInvitationSchema = z.object({
  email: z.email(),
  role: stationRoleSchema,
  expiresInDays: z.number().int().min(1).max(30).optional(),
});

export async function authRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const deps = (request: FastifyRequest): service.AuthDeps => ({
    db: app.db,
    mailer: app.mailer,
    auth: app.auth,
    log: request.log,
  });
  const client = (request: FastifyRequest): service.ClientInfo => ({
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  });
  const rateLimit = { rateLimit: app.auth.rateLimit };
  const accepted = (reply: FastifyReply) => reply.code(202).send({ status: 'accepted' as const });
  const loggedIn = (reply: FastifyReply, result: service.LoginResult) => {
    app.auth.setSessionCookie(reply, result.token, result.expiresAt);
    return result.status === 'ok'
      ? { status: 'ok' as const, me: result.me }
      : { status: result.status };
  };

  // --- Account ---------------------------------------------------------------------------

  r.post(
    '/auth/signup',
    {
      config: rateLimit,
      schema: { body: signupSchema, response: { 202: acceptedResponseSchema } },
    },
    async (request, reply) => {
      await service.signup(deps(request), request.body);
      return accepted(reply);
    },
  );

  r.post(
    '/auth/verify-email',
    { config: rateLimit, schema: { body: tokenOnlySchema } },
    async (request, reply) => {
      await service.verifyEmail(deps(request), request.body.token);
      return reply.code(204).send();
    },
  );

  r.post(
    '/auth/verify-email/resend',
    {
      config: rateLimit,
      schema: { body: emailOnlySchema, response: { 202: acceptedResponseSchema } },
    },
    async (request, reply) => {
      await service.resendVerification(deps(request), request.body.email);
      return accepted(reply);
    },
  );

  r.post(
    '/auth/login',
    { config: rateLimit, schema: { body: loginSchema, response: { 200: loginResponseSchema } } },
    async (request, reply) => {
      const previous =
        request.auth && request.auth.kind !== 'api_key' ? request.auth.session : null;
      const result = await service.login(deps(request), request.body, client(request), previous);
      return loggedIn(reply, result);
    },
  );

  r.post(
    '/auth/login/2fa',
    {
      config: rateLimit,
      schema: { body: loginSecondFactorSchema, response: { 200: loginResponseSchema } },
    },
    async (request, reply) => {
      const auth = request.auth;
      if (auth?.kind !== 'pending_2fa') {
        throw new HttpError(401, 'no_pending_login', 'sign in with your password first');
      }
      const result = await service.completeSecondFactor(
        deps(request),
        auth,
        request.body,
        client(request),
      );
      return loggedIn(reply, result);
    },
  );

  r.post('/auth/logout', async (request, reply) => {
    const auth = request.auth;
    if (auth?.kind === 'session' || auth?.kind === 'pending_2fa') {
      await service.logout(deps(request), auth.session);
    }
    app.auth.clearSessionCookie(reply);
    return reply.code(204).send();
  });

  r.get(
    '/auth/me',
    { preHandler: app.requireUser, schema: { response: { 200: meSchema } } },
    async (request) => service.me(deps(request), sessionOf(request).user.id),
  );

  r.post(
    '/auth/password/forgot',
    {
      config: rateLimit,
      schema: { body: emailOnlySchema, response: { 202: acceptedResponseSchema } },
    },
    async (request, reply) => {
      await service.forgotPassword(deps(request), request.body.email);
      return accepted(reply);
    },
  );

  r.post(
    '/auth/password/reset',
    { config: rateLimit, schema: { body: resetPasswordSchema } },
    async (request, reply) => {
      await service.resetPassword(deps(request), request.body.token, request.body.password);
      app.auth.clearSessionCookie(reply);
      return reply.code(204).send();
    },
  );

  // --- 2FA -------------------------------------------------------------------------------

  r.post(
    '/auth/2fa/setup',
    { preHandler: app.requireUser, schema: { response: { 200: totpSetupResponseSchema } } },
    async (request) => service.setupTotp(deps(request), sessionOf(request).user.id),
  );

  r.post(
    '/auth/2fa/enable',
    {
      config: rateLimit,
      preHandler: app.requireUser,
      schema: { body: totpCodeOnlySchema, response: { 200: recoveryCodesResponseSchema } },
    },
    async (request) => ({
      recoveryCodes: await service.enableTotp(
        deps(request),
        sessionOf(request).user.id,
        request.body.code,
      ),
    }),
  );

  r.post(
    '/auth/2fa/disable',
    { config: rateLimit, preHandler: app.requireUser, schema: { body: disableTotpSchema } },
    async (request, reply) => {
      await service.disableTotp(deps(request), sessionOf(request).user.id, request.body);
      return reply.code(204).send();
    },
  );

  r.post(
    '/auth/2fa/recovery-codes',
    {
      config: rateLimit,
      preHandler: app.requireUser,
      schema: { body: totpCodeOnlySchema, response: { 200: recoveryCodesResponseSchema } },
    },
    async (request) => ({
      recoveryCodes: await service.regenerateRecoveryCodes(
        deps(request),
        sessionOf(request).user.id,
        request.body.code,
      ),
    }),
  );

  // --- Invitations: accepting ------------------------------------------------------------

  r.post(
    '/invitations/accept',
    {
      config: rateLimit,
      preHandler: app.requireUser,
      schema: { body: tokenOnlySchema, response: { 200: invitationSchema } },
    },
    async (request) =>
      service.acceptInvitation(deps(request), sessionOf(request).user, request.body.token),
  );

  // --- Org security policy ---------------------------------------------------------------

  r.get(
    '/orgs/:orgId/auth-policy',
    {
      preHandler: app.requirePermission('org', 'read'),
      schema: { params: orgParams, response: { 200: orgAuthPolicySchema } },
    },
    async (request) => service.getAuthPolicy(deps(request), orgScopeOf(request)),
  );

  r.put(
    '/orgs/:orgId/auth-policy',
    {
      preHandler: app.requirePermission('org', 'update'),
      schema: {
        params: orgParams,
        body: updateOrgAuthPolicySchema,
        response: { 200: orgAuthPolicySchema },
      },
    },
    async (request) =>
      service.updateAuthPolicy(
        deps(request),
        { actor: actorOf(request), scope: orgScopeOf(request) },
        request.body,
        request.auth?.kind === 'session' ? request.auth.twoFactorEnabled : null,
      ),
  );

  // --- Invitations: managing -------------------------------------------------------------
  // Same handlers on org routes (any level, for owners/admins) and station routes (station
  // roles only, for station managers). The service re-checks the target scope either way.

  const caller = async (request: FastifyRequest) => {
    const auth = request.auth;
    if (auth?.kind !== 'session' && auth?.kind !== 'api_key') {
      throw new HttpError(401, 'unauthenticated', 'sign in first');
    }
    return service.callerFor(deps(request), auth, orgScopeOf(request));
  };
  const routeStationId = (request: FastifyRequest) => {
    const scope = orgScopeOf(request);
    return 'stationId' in scope ? (scope.stationId as string) : null;
  };

  r.get(
    '/orgs/:orgId/invitations',
    {
      preHandler: app.requirePermission('member', 'read'),
      schema: { params: orgParams, response: { 200: z.array(invitationSchema) } },
    },
    async (request) => service.listScopeInvitations(deps(request), orgScopeOf(request), null),
  );

  r.post(
    '/orgs/:orgId/invitations',
    {
      preHandler: app.requirePermission('member', 'invite'),
      schema: {
        params: orgParams,
        body: createInvitationSchema,
        response: { 201: invitationSchema },
      },
    },
    async (request, reply) => {
      const created = await service.createInvitation(
        deps(request),
        await caller(request),
        orgScopeOf(request),
        request.body,
      );
      return reply.code(201).send(created);
    },
  );

  r.get(
    '/stations/:stationId/invitations',
    {
      preHandler: app.requirePermission('member', 'read'),
      schema: { params: stationParams, response: { 200: z.array(invitationSchema) } },
    },
    async (request) =>
      service.listScopeInvitations(deps(request), orgScopeOf(request), routeStationId(request)),
  );

  r.post(
    '/stations/:stationId/invitations',
    {
      preHandler: app.requirePermission('member', 'invite'),
      schema: {
        params: stationParams,
        body: stationInvitationSchema,
        response: { 201: invitationSchema },
      },
    },
    async (request, reply) => {
      const stationId = routeStationId(request);
      if (!stationId) throw new Error('unreachable: station route without station scope');
      const created = await service.createInvitation(
        deps(request),
        await caller(request),
        orgScopeOf(request),
        { level: 'station', stationId, ...request.body },
      );
      return reply.code(201).send(created);
    },
  );

  for (const [prefix, params] of [
    ['/orgs/:orgId', orgParams],
    ['/stations/:stationId', stationParams],
  ] as const) {
    r.delete(
      `${prefix}/invitations/:invitationId`,
      {
        preHandler: app.requirePermission('member', 'invite'),
        schema: {
          params: params.extend(invitationParams.shape),
          response: { 200: invitationSchema },
        },
      },
      async (request) =>
        service.revokeInvitation(
          deps(request),
          await caller(request),
          orgScopeOf(request),
          request.params.invitationId,
          routeStationId(request),
        ),
    );

    r.post(
      `${prefix}/invitations/:invitationId/resend`,
      {
        preHandler: app.requirePermission('member', 'invite'),
        schema: {
          params: params.extend(invitationParams.shape),
          response: { 201: invitationSchema },
        },
      },
      async (request, reply) => {
        const sent = await service.resendInvitation(
          deps(request),
          await caller(request),
          orgScopeOf(request),
          request.params.invitationId,
          routeStationId(request),
        );
        return reply.code(201).send(sent);
      },
    );

    // --- API keys ------------------------------------------------------------------------

    r.get(
      `${prefix}/api-keys`,
      {
        preHandler: app.requirePermission('api_key', 'read'),
        schema: { params, response: { 200: z.array(apiKeySchema) } },
      },
      async (request) => {
        const stationId = routeStationId(request);
        const keys = await listApiKeys(app.db, orgScopeOf(request));
        return stationId ? keys.filter((k) => k.stationId === stationId) : keys;
      },
    );

    r.post(
      `${prefix}/api-keys`,
      {
        preHandler: app.requirePermission('api_key', 'manage'),
        schema: {
          params,
          body: createApiKeyRequestSchema,
          response: { 201: createApiKeyResponseSchema },
        },
      },
      async (request, reply) => {
        const stationId = routeStationId(request);
        if (stationId && request.body.stationId && request.body.stationId !== stationId) {
          throw new HttpError(400, 'station_mismatch', 'stationId must match the route');
        }
        const created = await service.createScopedApiKey(
          deps(request),
          await caller(request),
          orgScopeOf(request),
          stationId ? { ...request.body, stationId } : request.body,
        );
        return reply.code(201).send(created);
      },
    );

    r.delete(
      `${prefix}/api-keys/:apiKeyId`,
      {
        preHandler: app.requirePermission('api_key', 'manage'),
        schema: { params: params.extend(apiKeyParams.shape), response: { 200: apiKeySchema } },
      },
      async (request) => {
        const scope = orgScopeOf(request);
        const stationId = routeStationId(request);
        if (stationId) {
          const key = (await listApiKeys(app.db, scope)).find(
            (k) => k.id === request.params.apiKeyId,
          );
          if (key?.stationId !== stationId) {
            throw new HttpError(404, 'not_found', `api_key ${request.params.apiKeyId} not found`);
          }
        }
        return revokeApiKey(app.db, { actor: actorOf(request), scope }, request.params.apiKeyId);
      },
    );
  }
}
