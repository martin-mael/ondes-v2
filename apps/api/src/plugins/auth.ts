import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import {
  NotFoundError,
  type OrgScope,
  resolveOrgScope,
  type StationScope,
  unsafeScope,
} from '@ondes/db';
import {
  type Action,
  type Actor,
  type ApiKey,
  effectivePermissions,
  expandScopes,
  type Membership,
  type Permission,
  type Resource,
  type User,
  type UserVerifiedEvent,
  uuidSchema,
} from '@ondes/shared';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';
import fp from 'fastify-plugin';
import { createSecretBox, type SecretBox } from '../modules/auth/crypto.ts';
import {
  findApiKeyByToken,
  findSessionByToken,
  getOrgAuthPolicy,
  type SessionRow,
  stationOrgId,
  touchApiKey,
  touchSession,
  type UserAuthRow,
  userMembershipsInOrg,
} from '../modules/auth/repo.ts';
import { HttpError } from './errors.ts';

/** Routes under this prefix authenticate themselves (see the onRequest hook). */
const INTERNAL_PREFIX = '/internal/';

// Authentication and authorization (#6).
// - Every request is authenticated by an `ondes_session` cookie or an `Authorization: Bearer
//   ondes_…` API key, into `request.auth`.
// - Routes guard themselves with `preHandler: app.requirePermission('library', 'write')`, which
//   resolves the tenant scope from `:orgId` / `:stationId` into `request.scope`.
// - `app.auth.onUserVerified(handler)` is the extension point for #113 (domain auto-join).

export const SESSION_COOKIE = 'ondes_session';

export interface AuthConfig {
  /** AUTH_SECRET: keys the TOTP-secret encryption and recovery-code HMACs. 32+ chars. */
  secret: string;
  /** Base URL of the web app, for links in emails (`https://radio.example.org`). */
  appUrl: string;
  /** `Secure` cookie attribute. Only turn off for plain-http local development. */
  cookieSecure: boolean;
  sessionTtlMs: number;
  /** Per IP and per route, on every `/auth` route that takes credentials or sends email. */
  rateLimit: { max: number; timeWindowMs: number };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Reads `AUTH_SECRET`, `APP_URL`, `AUTH_COOKIE_SECURE`, `AUTH_SESSION_TTL_DAYS`, `AUTH_RATE_LIMIT_MAX`. */
export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const secret = env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error('AUTH_SECRET must be set (32+ characters)');
  const appUrl = env.APP_URL;
  if (!appUrl) throw new Error('APP_URL is not set');
  return {
    secret,
    appUrl: appUrl.replace(/\/$/, ''),
    cookieSecure: env.AUTH_COOKIE_SECURE !== 'false',
    sessionTtlMs: Number(env.AUTH_SESSION_TTL_DAYS ?? 30) * DAY_MS,
    rateLimit: { max: Number(env.AUTH_RATE_LIMIT_MAX ?? 10), timeWindowMs: 60_000 },
  };
}

export type RequestAuth =
  | {
      kind: 'session';
      user: User;
      session: SessionRow;
      twoFactorEnabled: boolean;
    }
  /** Password accepted, waiting for the second factor. Only the 2FA route accepts it. */
  | { kind: 'pending_2fa'; user: User; session: SessionRow; credentials: UserAuthRow | null }
  | { kind: 'api_key'; apiKey: ApiKey };

export type UserVerifiedHandler = (event: UserVerifiedEvent) => void | Promise<void>;

export interface AuthApi {
  config: AuthConfig;
  secrets: SecretBox;
  /**
   * Runs `handler` whenever a user's email becomes verified, and on every sign-in of a verified
   * user. Handlers run in registration order; a failing handler is logged and never blocks the
   * sign-in. Register it from a plugin at boot.
   */
  onUserVerified(handler: UserVerifiedHandler): void;
  /** Fires the `onUserVerified` handlers. Called by the auth module. */
  emitUserVerified(event: UserVerifiedEvent, log: FastifyBaseLogger): Promise<void>;
  setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void;
  clearSessionCookie(reply: FastifyReply): void;
  /** Route option for `config.rateLimit`. */
  rateLimit: { max: number; timeWindow: number };
}

declare module 'fastify' {
  interface FastifyInstance {
    auth: AuthApi;
    /** Signed-in user with a full session (not an API key, not a pending 2FA login). */
    requireUser: preHandlerAsyncHookHandler;
    requirePermission<R extends Resource>(
      resource: R,
      action: Action<R>,
    ): preHandlerAsyncHookHandler;
  }
  interface FastifyRequest {
    auth: RequestAuth | null;
    /** Set by `requirePermission`: the tenant the route acts on. */
    scope: OrgScope | StationScope | null;
    /** Set by `requirePermission`: what the caller may do in `scope`. */
    permissions: ReadonlySet<Permission> | null;
  }
}

/** The audit actor for an authenticated request. */
export function actorOf(request: FastifyRequest): Actor {
  const auth = request.auth;
  if (auth?.kind === 'session') return { type: 'user', userId: auth.user.id };
  if (auth?.kind === 'api_key') return { type: 'api_key', apiKeyId: auth.apiKey.id };
  throw new HttpError(401, 'unauthenticated', 'sign in first');
}

/** `request.auth` for a route behind `requireUser`. */
export function sessionOf(request: FastifyRequest): Extract<RequestAuth, { kind: 'session' }> {
  const auth = request.auth;
  if (auth?.kind !== 'session') throw new HttpError(401, 'unauthenticated', 'sign in first');
  return auth;
}

/** `request.scope` for a route behind `requirePermission` on an `:orgId` / `:stationId` route. */
export function orgScopeOf(request: FastifyRequest): OrgScope {
  if (!request.scope) throw new Error('route has no requirePermission guard');
  return request.scope;
}

export function stationScopeOf(request: FastifyRequest): StationScope {
  const scope = orgScopeOf(request);
  if (!('stationId' in scope)) throw new Error('route has no :stationId param');
  return scope as StationScope;
}

const SESSION_TOUCH_MS = 5 * 60 * 1000;

export const authPlugin = fp(
  async (app: FastifyInstance, config: AuthConfig) => {
    await app.register(fastifyCookie);
    await app.register(fastifyRateLimit, { global: false });

    const handlers: UserVerifiedHandler[] = [];
    const cookieOptions = {
      path: '/',
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'lax' as const,
    };

    app.decorate('auth', {
      config,
      secrets: createSecretBox(config.secret),
      onUserVerified: (handler) => {
        handlers.push(handler);
      },
      async emitUserVerified(event, log) {
        for (const handler of handlers) {
          try {
            await handler(event);
          } catch (err) {
            log.error({ err, userId: event.user.id }, 'onUserVerified handler failed');
          }
        }
      },
      setSessionCookie: (reply, token, expiresAt) => {
        reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt });
      },
      clearSessionCookie: (reply) => {
        reply.clearCookie(SESSION_COOKIE, cookieOptions);
      },
      rateLimit: { max: config.rateLimit.max, timeWindow: config.rateLimit.timeWindowMs },
    } satisfies AuthApi);

    app.decorateRequest('auth', null);
    app.decorateRequest('scope', null);
    app.decorateRequest('permissions', null);

    app.addHook('onRequest', async (request) => {
      // Internal routes (engine events, #35) check their own bearer tokens and are never
      // reachable through the public proxy: their Authorization header isn't an API key.
      if (request.url.startsWith(INTERNAL_PREFIX)) return;
      const header = request.headers.authorization;
      if (header) {
        const [kind, token] = header.split(' ');
        if (kind !== 'Bearer' || !token) {
          throw new HttpError(401, 'invalid_api_key', 'expected "Authorization: Bearer <key>"');
        }
        const key = await findApiKeyByToken(app.db, token);
        if (!key)
          throw new HttpError(401, 'invalid_api_key', 'unknown, revoked or expired API key');
        // Same throttle as sessions: a polling integration shouldn't turn every read into a write.
        if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > SESSION_TOUCH_MS) {
          await touchApiKey(app.db, key.id);
        }
        request.auth = { kind: 'api_key', apiKey: key };
        return;
      }
      const token = request.cookies[SESSION_COOKIE];
      if (!token) return;
      const found = await findSessionByToken(app.db, token);
      if (!found) return;
      if (found.session.twoFactorPending) {
        request.auth = {
          kind: 'pending_2fa',
          user: found.user,
          session: found.session,
          credentials: found.auth,
        };
        return;
      }
      if (Date.now() - found.session.lastSeenAt.getTime() > SESSION_TOUCH_MS) {
        await touchSession(app.db, found.session.id);
      }
      request.auth = {
        kind: 'session',
        user: found.user,
        session: found.session,
        twoFactorEnabled: found.auth?.totpEnabledAt != null,
      };
    });

    app.decorate('requireUser', async (request: FastifyRequest) => {
      const auth = request.auth;
      if (auth?.kind === 'api_key') {
        throw new HttpError(
          403,
          'session_required',
          'this route needs a signed-in user, not an API key',
        );
      }
      if (auth?.kind !== 'session') throw new HttpError(401, 'unauthenticated', 'sign in first');
    });

    app.decorate('requirePermission', <R extends Resource>(resource: R, action: Action<R>) => {
      const permission = `${resource}:${action}` as Permission;
      return async (request: FastifyRequest) => {
        const auth = request.auth;
        if (auth?.kind !== 'session' && auth?.kind !== 'api_key') {
          throw new HttpError(401, 'unauthenticated', 'sign in or use an API key');
        }
        const scope = await resolveRouteScope(app, request);
        const stationId = 'stationId' in scope ? (scope as StationScope).stationId : null;
        const notFound = () =>
          stationId
            ? new NotFoundError('station', stationId)
            : new NotFoundError('organization', scope.orgId);

        let permissions: Set<Permission>;
        if (auth.kind === 'api_key') {
          const key = auth.apiKey;
          // A key narrowed to a station can't act on the org or on another station.
          if (key.orgId !== scope.orgId || (key.stationId && key.stationId !== stationId)) {
            throw notFound();
          }
          permissions = expandScopes(key.scopes);
          // A key never outlives or outranks its creator: it can only use what the user who
          // made it may still do here. Keys without a creator (system-made) keep their scopes.
          if (key.createdBy) {
            const creator = await userMembershipsInOrg(app.db, key.createdBy, scope);
            if (!appliesTo(creator, stationId)) throw notFound();
            const held = effectivePermissions(creator, stationId);
            permissions = new Set([...permissions].filter((p) => held.has(p)));
          }
        } else {
          const memberships = await userMembershipsInOrg(app.db, auth.user.id, scope);
          if (!appliesTo(memberships, stationId)) throw notFound();
          const policy = await getOrgAuthPolicy(app.db, scope);
          if (policy.requireTwoFactor && !auth.twoFactorEnabled) {
            throw new HttpError(
              403,
              'two_factor_required',
              'this organization requires two-factor authentication: enable it in your account',
            );
          }
          permissions = effectivePermissions(memberships, stationId);
        }
        if (!permissions.has(permission)) {
          throw new HttpError(403, 'forbidden', `missing permission ${permission}`, { permission });
        }
        request.scope = scope;
        request.permissions = permissions;
      };
    });
  },
  { name: 'auth', dependencies: ['db'] },
);

/** Members see their org; station members see their station (org roles see every station). */
function appliesTo(memberships: readonly Membership[], stationId: string | null): boolean {
  if (memberships.length === 0) return false;
  if (stationId === null) return true;
  return memberships.some((m) => m.stationId === null || m.stationId === stationId);
}

/** Tenant scope from `:orgId` and/or `:stationId`. Unknown or mismatched ids are a 404. */
async function resolveRouteScope(
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<OrgScope | StationScope> {
  const params = (request.params ?? {}) as Record<string, string | undefined>;
  const { orgId, stationId } = params;
  if (stationId !== undefined) {
    if (!uuidSchema.safeParse(stationId).success) throw new NotFoundError('station', stationId);
    const owner = await stationOrgId(app.db, stationId);
    if (!owner || (orgId !== undefined && owner !== orgId))
      throw new NotFoundError('station', stationId);
    // `stationOrgId` just read this station's org from the database: the pair is proven.
    return unsafeScope(owner, stationId);
  }
  if (orgId !== undefined) {
    if (!uuidSchema.safeParse(orgId).success) throw new NotFoundError('organization', orgId);
    return resolveOrgScope(app.db, orgId);
  }
  throw new Error(
    `requirePermission on ${request.routeOptions.url} needs an :orgId or :stationId param`,
  );
}
