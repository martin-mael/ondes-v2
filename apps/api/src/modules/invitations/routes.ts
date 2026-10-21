import {
  addDomainCandidatesSchema,
  approveJoinRequestSchema,
  createInviteLinkResponseSchema,
  createInviteLinkSchema,
  createOrgDomainSchema,
  createStationInviteLinkSchema,
  domainCandidateSchema,
  invitationListInputSchema,
  invitationListPreviewSchema,
  invitationListQuerySchema,
  invitationListResultSchema,
  invitationWithInviterSchema,
  inviteLinkInfoSchema,
  inviteLinkSchema,
  inviteLinkTokenSchema,
  joinableOrgSchema,
  joinInviteLinkResponseSchema,
  joinOrgResponseSchema,
  joinRequestSchema,
  joinRequestStatusSchema,
  orgDomainSchema,
  sendInvitationListSchema,
  tokenOnlySchema,
  updateOrgDomainSchema,
  uuidSchema,
  verifyOrgDomainSchema,
} from '@ondes/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { orgScopeOf, sessionOf } from '../../plugins/auth.ts';
import { HttpError } from '../../plugins/errors.ts';
import { callerFor } from '../auth/service.ts';
import { systemResolver, type TxtResolver } from './domains.ts';
import * as service from './service.ts';

// Team onboarding routes (#113), under `/api/v1`:
// - `/orgs/:orgId/domains…`, `/orgs/:orgId/join-requests…`: owners/admins only (`member:manage`
//   on the org, which station roles never hold).
// - `{/orgs/:orgId | /stations/:stationId}/invitation-lists…` and `/invite-links…`: org routes
//   for any scope, station routes for station managers (their station only).
// - `/me/joinable-orgs…`, `/invite-links/join`: the signed-in user. `/domains/confirm` and
//   `/invite-links/info`: anonymous, the token is the proof.

export interface InvitationsOptions {
  /** DNS resolver for TXT verification. Tests pass a fake. */
  resolver?: TxtResolver;
  limits?: Partial<service.InvitationsLimits>;
  /**
   * How often verified domains are re-checked (DNS record, email confirmation age). Default a
   * day; `0` turns the background re-check off (tests call `service.recheckDomains`).
   */
  recheckIntervalMs?: number;
}

const HOUR_MS = 60 * 60 * 1000;

const orgParams = z.object({ orgId: z.string() });
const stationParams = z.object({ stationId: z.string() });
const domainParams = orgParams.extend({ domainId: uuidSchema });
const requestParams = orgParams.extend({ requestId: uuidSchema });

export async function invitationsRoutes(app: FastifyInstance, options: InvitationsOptions) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const resolver = options.resolver ?? systemResolver;
  const limits = { ...service.DEFAULT_LIMITS, ...options.limits };
  const deps = (request: FastifyRequest): service.InvitationsDeps => ({
    db: app.db,
    mailer: app.mailer,
    auth: app.auth,
    log: request.log,
    resolver,
  });
  const rateLimit = { rateLimit: app.auth.rateLimit };
  const caller = async (request: FastifyRequest) => {
    const auth = request.auth;
    if (auth?.kind !== 'session' && auth?.kind !== 'api_key') {
      throw new HttpError(401, 'unauthenticated', 'sign in first');
    }
    return callerFor(deps(request), auth, orgScopeOf(request));
  };
  const routeStationId = (request: FastifyRequest) => {
    const scope = orgScopeOf(request);
    return 'stationId' in scope ? (scope.stationId as string) : null;
  };

  const appDeps: service.InvitationsDeps = {
    db: app.db,
    mailer: app.mailer,
    auth: app.auth,
    log: app.log,
    resolver,
  };
  app.auth.onUserVerified(({ user }) => service.autoJoin(appDeps, user));

  // Background re-check of verified domains. Each replica ticks; a domain is claimed by one.
  const recheckEvery = options.recheckIntervalMs ?? 24 * HOUR_MS;
  if (recheckEvery > 0) {
    const tick = () =>
      service
        .recheckDomains(appDeps, { everyMs: recheckEvery })
        .catch((err) => app.log.error({ err }, 'domain re-check failed'));
    const timer = setInterval(tick, Math.min(recheckEvery, HOUR_MS));
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  // --- Email-domain rules (org level) ----------------------------------------------------

  // Owners and admins themselves: API keys can't manage domain rules or decide requests.
  const manage = { preHandler: [app.requireUser, app.requirePermission('member', 'manage')] };

  r.get(
    '/orgs/:orgId/domains',
    { ...manage, schema: { params: orgParams, response: { 200: z.array(orgDomainSchema) } } },
    async (request) => service.listDomains(deps(request), orgScopeOf(request)),
  );

  r.post(
    '/orgs/:orgId/domains',
    {
      ...manage,
      schema: {
        params: orgParams,
        body: createOrgDomainSchema,
        response: { 201: orgDomainSchema },
      },
    },
    async (request, reply) => {
      const created = await service.addDomain(
        deps(request),
        await caller(request),
        orgScopeOf(request),
        request.body,
      );
      return reply.code(201).send(created);
    },
  );

  r.patch(
    '/orgs/:orgId/domains/:domainId',
    {
      ...manage,
      schema: {
        params: domainParams,
        body: updateOrgDomainSchema,
        response: { 200: orgDomainSchema },
      },
    },
    async (request) =>
      service.updateDomain(
        deps(request),
        await caller(request),
        orgScopeOf(request),
        request.params.domainId,
        request.body,
      ),
  );

  r.delete(
    '/orgs/:orgId/domains/:domainId',
    { ...manage, schema: { params: domainParams } },
    async (request, reply) => {
      await service.removeDomain(
        deps(request),
        await caller(request),
        orgScopeOf(request),
        request.params.domainId,
      );
      return reply.code(204).send();
    },
  );

  r.post(
    '/orgs/:orgId/domains/:domainId/verify',
    {
      ...manage,
      config: rateLimit,
      schema: {
        params: domainParams,
        body: verifyOrgDomainSchema,
        response: { 200: orgDomainSchema },
      },
    },
    async (request) =>
      service.verifyDomain(
        deps(request),
        await caller(request),
        orgScopeOf(request),
        request.params.domainId,
        request.body,
      ),
  );

  r.post(
    '/domains/confirm',
    { config: rateLimit, schema: { body: tokenOnlySchema, response: { 200: orgDomainSchema } } },
    async (request) => service.confirmDomainEmail(deps(request), request.body.token),
  );

  r.get(
    '/orgs/:orgId/domains/:domainId/candidates',
    {
      ...manage,
      schema: { params: domainParams, response: { 200: z.array(domainCandidateSchema) } },
    },
    async (request) =>
      service.listDomainCandidates(
        deps(request),
        await caller(request),
        orgScopeOf(request),
        request.params.domainId,
      ),
  );

  r.post(
    '/orgs/:orgId/domains/:domainId/candidates',
    {
      ...manage,
      schema: {
        params: domainParams,
        body: addDomainCandidatesSchema,
        response: { 200: z.object({ added: z.array(uuidSchema) }) },
      },
    },
    async (request) =>
      service.addDomainCandidates(
        deps(request),
        await caller(request),
        orgScopeOf(request),
        request.params.domainId,
        request.body.userIds,
      ),
  );

  // --- Join requests ---------------------------------------------------------------------

  r.get(
    '/me/joinable-orgs',
    { preHandler: app.requireUser, schema: { response: { 200: z.array(joinableOrgSchema) } } },
    async (request) => service.joinableOrgs(deps(request), sessionOf(request).user.id),
  );

  r.post(
    '/me/joinable-orgs/:orgId/join',
    {
      config: rateLimit,
      preHandler: app.requireUser,
      schema: { params: z.object({ orgId: uuidSchema }), response: { 200: joinOrgResponseSchema } },
    },
    async (request) =>
      service.joinOrg(deps(request), sessionOf(request).user.id, request.params.orgId),
  );

  r.get(
    '/orgs/:orgId/join-requests',
    {
      ...manage,
      schema: {
        params: orgParams,
        querystring: z.object({ status: joinRequestStatusSchema.optional() }),
        response: { 200: z.array(joinRequestSchema) },
      },
    },
    async (request) =>
      service.listScopeJoinRequests(
        deps(request),
        await caller(request),
        orgScopeOf(request),
        request.query.status,
      ),
  );

  r.post(
    '/orgs/:orgId/join-requests/:requestId/approve',
    {
      ...manage,
      schema: {
        params: requestParams,
        body: approveJoinRequestSchema,
        response: { 200: joinRequestSchema },
      },
    },
    async (request) =>
      service.approveJoinRequest(
        deps(request),
        await caller(request),
        orgScopeOf(request),
        request.params.requestId,
        request.body.grant,
      ),
  );

  r.post(
    '/orgs/:orgId/join-requests/:requestId/refuse',
    { ...manage, schema: { params: requestParams, response: { 200: joinRequestSchema } } },
    async (request) =>
      service.refuseJoinRequest(
        deps(request),
        await caller(request),
        orgScopeOf(request),
        request.params.requestId,
      ),
  );

  // --- Invite links: joining -------------------------------------------------------------

  r.post(
    '/invite-links/info',
    {
      config: rateLimit,
      schema: { body: inviteLinkTokenSchema, response: { 200: inviteLinkInfoSchema } },
    },
    async (request) => service.inviteLinkInfo(deps(request), request.body.token),
  );

  r.post(
    '/invite-links/join',
    {
      config: rateLimit,
      preHandler: app.requireUser,
      schema: { body: inviteLinkTokenSchema, response: { 200: joinInviteLinkResponseSchema } },
    },
    async (request) =>
      service.joinWithInviteLink(deps(request), sessionOf(request).user.id, request.body.token),
  );

  // --- Invitation lists and invite links: org and station routes --------------------------

  for (const [prefix, params] of [
    ['/orgs/:orgId', orgParams],
    ['/stations/:stationId', stationParams],
  ] as const) {
    const invite = { preHandler: app.requirePermission('member', 'invite') };

    r.get(
      `${prefix}/invitation-lists`,
      {
        preHandler: app.requirePermission('member', 'read'),
        schema: {
          params,
          querystring: invitationListQuerySchema,
          response: { 200: z.array(invitationWithInviterSchema) },
        },
      },
      async (request) =>
        service.listInvitationsWithInviter(
          deps(request),
          orgScopeOf(request),
          routeStationId(request),
          request.query,
          request.permissions?.has('member:invite') ?? false,
        ),
    );

    r.post(
      `${prefix}/invitation-lists/preview`,
      {
        ...invite,
        schema: {
          params,
          body: invitationListInputSchema,
          response: { 200: invitationListPreviewSchema },
        },
      },
      async (request) =>
        service.previewInvitationList(
          deps(request),
          await caller(request),
          orgScopeOf(request),
          routeStationId(request),
          request.body,
          limits,
        ),
    );

    r.post(
      `${prefix}/invitation-lists/send`,
      {
        ...invite,
        config: rateLimit,
        schema: {
          params,
          body: sendInvitationListSchema,
          response: { 201: invitationListResultSchema },
        },
      },
      async (request, reply) => {
        const result = await service.sendInvitationList(
          deps(request),
          await caller(request),
          orgScopeOf(request),
          routeStationId(request),
          request.body,
          limits,
        );
        return reply.code(201).send(result);
      },
    );

    r.get(
      `${prefix}/invite-links`,
      {
        preHandler: app.requirePermission('member', 'read'),
        schema: { params, response: { 200: z.array(inviteLinkSchema) } },
      },
      async (request) =>
        service.listScopeInviteLinks(deps(request), orgScopeOf(request), routeStationId(request)),
    );

    r.delete(
      `${prefix}/invite-links/:linkId`,
      {
        ...invite,
        schema: {
          params: params.extend({ linkId: uuidSchema }),
          response: { 200: inviteLinkSchema },
        },
      },
      async (request) =>
        service.revokeInviteLink(
          deps(request),
          await caller(request),
          orgScopeOf(request),
          request.params.linkId,
          routeStationId(request),
        ),
    );
  }

  r.post(
    '/orgs/:orgId/invite-links',
    {
      preHandler: app.requirePermission('member', 'invite'),
      schema: {
        params: orgParams,
        body: createInviteLinkSchema,
        response: { 201: createInviteLinkResponseSchema },
      },
    },
    async (request, reply) => {
      const created = await service.createInviteLink(
        deps(request),
        await caller(request),
        orgScopeOf(request),
        request.body,
      );
      return reply.code(201).send(created);
    },
  );

  r.post(
    '/stations/:stationId/invite-links',
    {
      preHandler: app.requirePermission('member', 'invite'),
      schema: {
        params: stationParams,
        body: createStationInviteLinkSchema,
        response: { 201: createInviteLinkResponseSchema },
      },
    },
    async (request, reply) => {
      const stationId = routeStationId(request);
      if (!stationId) throw new Error('unreachable: station route without station scope');
      const { role, ...rest } = request.body;
      const created = await service.createInviteLink(
        deps(request),
        await caller(request),
        orgScopeOf(request),
        { grant: { level: 'station', stationId, role }, ...rest },
      );
      return reply.code(201).send(created);
    },
  );
}
