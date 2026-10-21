import {
  addMembership,
  auditDiff,
  createApiKey,
  createUser,
  type Db,
  getOrganization,
  getStation,
  invitation,
  narrowToStation,
  type OrgScope,
  resolveOrgScope,
  type StationScope,
  userAuth,
  withAudit,
} from '@ondes/db';
import {
  type Actor,
  type ApiKey,
  type CreateInvitation,
  createApiKeyRequestSchema,
  createInvitationSchema,
  effectivePermissions,
  expandScopes,
  highestRole,
  type Invitation,
  type Me,
  type OrgRole,
  type Permission,
  type Role,
  roleRank,
  type Signup,
  type StationRole,
  type User,
} from '@ondes/shared';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import type { AuthApi } from '../../plugins/auth.ts';
import { HttpError } from '../../plugins/errors.ts';
import { type Mailer, sendTemplate } from '../../plugins/mail.ts';
import {
  accountExistsTemplate,
  invitationTemplate,
  resetPasswordTemplate,
  verifyEmailTemplate,
} from './emails.ts';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.ts';
import {
  consumeAuthToken,
  deleteExpiredSessions,
  deleteSession,
  deleteUserSessions,
  findInvitationByToken,
  findUserWithAuth,
  getInvitation,
  getOrgAuthPolicy,
  type InvitationRow,
  insertInvitation,
  insertSession,
  invitationStatus,
  issueAuthToken,
  listInvitations,
  recordSecondFactorFailure,
  replaceRecoveryCodes,
  resetSecondFactorFailures,
  revokePendingInvitations,
  type SessionRow,
  secondFactorLockedUntil,
  toInvitation,
  type UserAuthRow,
  upsertOrgAuthPolicy,
  useRecoveryCode,
  userMemberships,
  userMembershipsInOrg,
} from './repo.ts';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from './totp.ts';

export interface AuthDeps {
  db: Db;
  mailer: Mailer;
  auth: AuthApi;
  log: FastifyBaseLogger;
}

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

const HOUR_MS = 60 * 60 * 1000;
const VERIFY_TTL_MS = 48 * HOUR_MS;
const RESET_TTL_MS = HOUR_MS;
const PENDING_2FA_TTL_MS = 10 * 60 * 1000;
const DEFAULT_INVITATION_DAYS = 7;

/** Anonymous auth flows (sign-up, password reset) have no user yet. */
const AUTH_SYSTEM: Actor = { type: 'system', name: 'auth' };
const userActor = (userId: string): Actor => ({ type: 'user', userId });

const invalidCredentials = () =>
  new HttpError(401, 'invalid_credentials', 'wrong email or password');
const invalidToken = () =>
  new HttpError(400, 'invalid_token', 'this link is invalid or has expired');

function link(deps: AuthDeps, path: string, token: string): string {
  return `${deps.auth.config.appUrl}${path}?token=${encodeURIComponent(token)}`;
}

// --- Sign-up and email verification ------------------------------------------------------

/**
 * Creates an account and sends the verification email. Answers the same way whether or not
 * the email is taken, so it can't be used to find accounts. If it is taken, the address's
 * owner gets an email with a password-reset link instead, so nobody can squat an address by
 * registering it first (the reset proves the inbox and replaces the squatter's password).
 * With a valid invitation token for the same email, the address counts as verified and the
 * invitation is accepted at once.
 */
export async function signup(deps: AuthDeps, input: Signup): Promise<void> {
  const email = input.email.toLowerCase();
  const existing = await findUserWithAuth(deps.db, { email });
  if (existing?.auth) {
    await sendAccountExists(deps, existing.user);
    return;
  }

  const invite = input.invitationToken
    ? await findInvitationByToken(deps.db, input.invitationToken)
    : undefined;
  const inviteValid =
    invite !== undefined && invitationStatus(invite) === 'pending' && invite.email === email;

  const passwordHash = await hashPassword(input.password);
  let created: User;
  try {
    created = await withAudit(deps.db, { actor: AUTH_SYSTEM, scope: null }, async (tx, audit) => {
      // A user row may exist without credentials (seeded, or created by an admin): claim it.
      const row =
        existing?.user ?? (await createUser(tx, AUTH_SYSTEM, { email, name: input.name }));
      await tx.insert(userAuth).values({
        userId: row.id,
        passwordHash,
        emailVerifiedAt: inviteValid ? new Date() : null,
      });
      await audit({
        action: 'user.signup',
        entity: { type: 'user', id: row.id },
        diff: { emailVerified: { from: null, to: inviteValid } },
      });
      return row;
    });
  } catch (err) {
    // Two sign-ups racing for the same email: the loser behaves like "already registered".
    if (isUniqueViolation(err)) return;
    throw err;
  }

  if (inviteValid && invite) {
    await acceptInvitationRow(deps, created, invite);
    await deps.auth.emitUserVerified({ user: created, reason: 'email_verified' }, deps.log);
    return;
  }
  await sendVerification(deps, created);
}

async function sendVerification(deps: AuthDeps, target: User): Promise<void> {
  const token = await withAudit(deps.db, { actor: AUTH_SYSTEM, scope: null }, async (tx, audit) => {
    const token = await issueAuthToken(tx, target.id, 'verify_email', VERIFY_TTL_MS);
    await audit({ action: 'user.verification_send', entity: { type: 'user', id: target.id } });
    return token;
  });
  await sendTemplate(deps.mailer, target.email, verifyEmailTemplate, {
    name: target.name,
    link: link(deps, '/verify-email', token),
  });
}

async function sendAccountExists(deps: AuthDeps, target: User): Promise<void> {
  const token = await withAudit(deps.db, { actor: AUTH_SYSTEM, scope: null }, async (tx, audit) => {
    const token = await issueAuthToken(tx, target.id, 'reset_password', RESET_TTL_MS);
    await audit({ action: 'user.signup_existing', entity: { type: 'user', id: target.id } });
    return token;
  });
  await sendTemplate(deps.mailer, target.email, accountExistsTemplate, {
    name: target.name,
    link: link(deps, '/reset-password', token),
  });
}

export async function resendVerification(deps: AuthDeps, email: string): Promise<void> {
  const found = await findUserWithAuth(deps.db, { email });
  if (!found?.auth || found.auth.emailVerifiedAt) return;
  await sendVerification(deps, found.user);
}

export async function verifyEmail(deps: AuthDeps, token: string): Promise<void> {
  const verified = await withAudit(
    deps.db,
    { actor: AUTH_SYSTEM, scope: null },
    async (tx, audit) => {
      const userId = await consumeAuthToken(tx, token, 'verify_email');
      if (!userId) throw invalidToken();
      const [row] = await tx
        .update(userAuth)
        .set({ emailVerifiedAt: new Date() })
        .where(and(eq(userAuth.userId, userId), isNull(userAuth.emailVerifiedAt)))
        .returning({ userId: userAuth.userId });
      await audit({
        action: 'user.verify_email',
        entity: { type: 'user', id: userId },
        diff: { emailVerified: { from: false, to: true } },
      });
      return row ? userId : null;
    },
  );
  if (!verified) return;
  const found = await findUserWithAuth(deps.db, { userId: verified });
  if (found)
    await deps.auth.emitUserVerified({ user: found.user, reason: 'email_verified' }, deps.log);
}

// --- Sign-in -----------------------------------------------------------------------------

export type LoginResult =
  | { status: 'ok'; me: Me; token: string; expiresAt: Date }
  | { status: 'two_factor_required'; token: string; expiresAt: Date };

/**
 * Checks the password and opens a session. A session cookie presented with the request is
 * dropped first: every sign-in gets a fresh token (no session fixation). With TOTP enabled, the
 * new session is only "pending" until `completeSecondFactor`.
 */
export async function login(
  deps: AuthDeps,
  input: { email: string; password: string },
  client: ClientInfo,
  previousSession: SessionRow | null,
): Promise<LoginResult> {
  const found = await findUserWithAuth(deps.db, { email: input.email });
  if (!found?.auth) {
    await verifyAgainstDummy(input.password);
    throw invalidCredentials();
  }
  if (!(await verifyPassword(found.auth.passwordHash, input.password))) throw invalidCredentials();
  if (!found.auth.emailVerifiedAt) {
    throw new HttpError(403, 'email_not_verified', 'confirm your email address first');
  }
  if (previousSession) await deleteSession(deps.db, previousSession.id);
  await deleteExpiredSessions(deps.db, found.user.id);

  if (found.auth.totpEnabledAt) {
    const expiresAt = new Date(Date.now() + PENDING_2FA_TTL_MS);
    const { token } = await insertSession(deps.db, {
      userId: found.user.id,
      twoFactorPending: true,
      expiresAt,
      ...client,
    });
    return { status: 'two_factor_required', token, expiresAt };
  }
  return openSession(deps, found.user, client, 'password');
}

async function openSession(
  deps: AuthDeps,
  target: User,
  client: ClientInfo,
  method: 'password' | 'totp' | 'recovery_code',
): Promise<Extract<LoginResult, { status: 'ok' }>> {
  const expiresAt = new Date(Date.now() + deps.auth.config.sessionTtlMs);
  const { token } = await withAudit(
    deps.db,
    { actor: userActor(target.id), scope: null },
    async (tx, audit) => {
      const created = await insertSession(tx, {
        userId: target.id,
        twoFactorPending: false,
        expiresAt,
        ...client,
      });
      await audit({
        action: 'session.create',
        entity: { type: 'session', id: created.session.id },
        diff: { method: { from: null, to: method }, ip: { from: null, to: client.ip } },
      });
      return created;
    },
  );
  await deps.auth.emitUserVerified({ user: target, reason: 'sign_in' }, deps.log);
  return { status: 'ok', me: await me(deps, target.id), token, expiresAt };
}

/** Second login step: a TOTP code or a single-use recovery code. */
export async function completeSecondFactor(
  deps: AuthDeps,
  pending: { user: User; session: SessionRow; credentials: UserAuthRow | null },
  input: { code: string } | { recoveryCode: string },
  client: ClientInfo,
): Promise<Extract<LoginResult, { status: 'ok' }>> {
  const credentials = pending.credentials;
  if (!credentials?.totpSecret || !credentials.totpEnabledAt) {
    throw new HttpError(400, 'two_factor_not_enabled', 'two-factor authentication is off');
  }
  let method: 'totp' | 'recovery_code';
  if ('code' in input) {
    await checkTotp(deps, credentials, input.code);
    method = 'totp';
  } else {
    await assertSecondFactorUnlocked(deps, pending.user.id);
    const hash = deps.auth.secrets.hmac(normalizeRecoveryCode(input.recoveryCode));
    if (!(await useRecoveryCode(deps.db, pending.user.id, hash))) {
      await secondFactorFailed(deps, pending.user.id);
      throw new HttpError(401, 'invalid_code', 'wrong or already used recovery code');
    }
    await resetSecondFactorFailures(deps.db, pending.user.id);
    method = 'recovery_code';
  }
  await deleteSession(deps.db, pending.session.id);
  return openSession(deps, pending.user, client, method);
}

const secondFactorLocked = (until: Date) =>
  new HttpError(429, 'two_factor_locked', 'too many wrong codes, try again later', {
    lockedUntil: until.toISOString(),
  });

async function assertSecondFactorUnlocked(deps: AuthDeps, userId: string): Promise<void> {
  const until = await secondFactorLockedUntil(deps.db, userId);
  if (until) throw secondFactorLocked(until);
}

/** Counts a wrong code; locks second-factor checks (and drops pending 2FA logins) at the limit. */
async function secondFactorFailed(deps: AuthDeps, userId: string): Promise<void> {
  if (await recordSecondFactorFailure(deps.db, userId)) {
    await withAudit(deps.db, { actor: AUTH_SYSTEM, scope: null }, async (_tx, audit) => {
      await audit({ action: 'user.second_factor_locked', entity: { type: 'user', id: userId } });
    });
  }
}

/**
 * Verifies a TOTP code and records its time step, so the same code can't be used twice.
 * Wrong codes count towards the per-account limit (see `recordSecondFactorFailure`).
 */
async function checkTotp(deps: AuthDeps, credentials: UserAuthRow, code: string): Promise<void> {
  if (!credentials.totpSecret)
    throw new HttpError(400, 'two_factor_not_set_up', 'set up 2FA first');
  await assertSecondFactorUnlocked(deps, credentials.userId);
  const secret = deps.auth.secrets.decrypt(credentials.totpSecret);
  const step = verifyTotp(secret, code, { afterStep: credentials.totpLastStep });
  if (step === null) {
    await secondFactorFailed(deps, credentials.userId);
    throw new HttpError(401, 'invalid_code', 'wrong or expired code');
  }
  const [row] = await deps.db
    .update(userAuth)
    .set({ totpLastStep: step })
    .where(
      and(
        eq(userAuth.userId, credentials.userId),
        sql`(${userAuth.totpLastStep} is null or ${userAuth.totpLastStep} < ${step})`,
      ),
    )
    .returning({ userId: userAuth.userId });
  if (!row) throw new HttpError(401, 'invalid_code', 'wrong or expired code');
  await resetSecondFactorFailures(deps.db, credentials.userId);
}

export async function logout(deps: AuthDeps, current: SessionRow): Promise<void> {
  await withAudit(deps.db, { actor: userActor(current.userId), scope: null }, async (tx, audit) => {
    await deleteSession(tx, current.id);
    await audit({ action: 'session.delete', entity: { type: 'session', id: current.id } });
  });
}

export async function me(deps: AuthDeps, userId: string): Promise<Me> {
  const found = await findUserWithAuth(deps.db, { userId });
  if (!found) throw new HttpError(401, 'unauthenticated', 'sign in first');
  return {
    user: found.user,
    emailVerified: found.auth?.emailVerifiedAt != null,
    twoFactorEnabled: found.auth?.totpEnabledAt != null,
    memberships: await userMemberships(deps.db, userId),
  };
}

// --- Password reset ----------------------------------------------------------------------

export async function forgotPassword(deps: AuthDeps, email: string): Promise<void> {
  const found = await findUserWithAuth(deps.db, { email });
  if (!found?.auth) return;
  const token = await withAudit(deps.db, { actor: AUTH_SYSTEM, scope: null }, async (tx, audit) => {
    const token = await issueAuthToken(tx, found.user.id, 'reset_password', RESET_TTL_MS);
    await audit({
      action: 'user.password_reset_request',
      entity: { type: 'user', id: found.user.id },
    });
    return token;
  });
  await sendTemplate(deps.mailer, found.user.email, resetPasswordTemplate, {
    name: found.user.name,
    link: link(deps, '/reset-password', token),
  });
}

/** Sets the new password and signs out every session of the account. */
export async function resetPassword(
  deps: AuthDeps,
  token: string,
  password: string,
): Promise<void> {
  const passwordHash = await hashPassword(password);
  const result = await withAudit(
    deps.db,
    { actor: AUTH_SYSTEM, scope: null },
    async (tx, audit) => {
      const userId = await consumeAuthToken(tx, token, 'reset_password');
      if (!userId) throw invalidToken();
      const [before] = await tx.select().from(userAuth).where(eq(userAuth.userId, userId));
      // The link came by email, so the address is proven too.
      await tx
        .update(userAuth)
        .set({ passwordHash, emailVerifiedAt: before?.emailVerifiedAt ?? new Date() })
        .where(eq(userAuth.userId, userId));
      const sessions = await deleteUserSessions(tx, userId);
      await audit({
        action: 'user.password_reset',
        entity: { type: 'user', id: userId },
        diff: { sessionsRevoked: { from: null, to: sessions } },
      });
      return { userId, newlyVerified: !before?.emailVerifiedAt };
    },
  );
  if (result.newlyVerified) {
    const found = await findUserWithAuth(deps.db, { userId: result.userId });
    if (found)
      await deps.auth.emitUserVerified({ user: found.user, reason: 'email_verified' }, deps.log);
  }
}

// --- TOTP 2FA ----------------------------------------------------------------------------

async function credentialsOf(deps: AuthDeps, userId: string) {
  const found = await findUserWithAuth(deps.db, { userId });
  if (!found?.auth) throw new HttpError(401, 'unauthenticated', 'sign in first');
  return { user: found.user, credentials: found.auth };
}

/** Starts TOTP enrolment: a new secret, active only once `enableTotp` confirms a code. */
export async function setupTotp(
  deps: AuthDeps,
  userId: string,
): Promise<{ secret: string; otpauthUrl: string }> {
  const { user, credentials } = await credentialsOf(deps, userId);
  if (credentials.totpEnabledAt) {
    throw new HttpError(
      409,
      'two_factor_already_enabled',
      'disable 2FA before setting it up again',
    );
  }
  const secret = generateTotpSecret();
  await withAudit(deps.db, { actor: userActor(userId), scope: null }, async (tx, audit) => {
    await tx
      .update(userAuth)
      .set({ totpSecret: deps.auth.secrets.encrypt(secret), totpLastStep: null })
      .where(eq(userAuth.userId, userId));
    await audit({ action: 'user.totp_setup', entity: { type: 'user', id: userId } });
  });
  return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
}

/** Confirms enrolment with a first code; returns the recovery codes (shown once). */
export async function enableTotp(deps: AuthDeps, userId: string, code: string): Promise<string[]> {
  const { credentials } = await credentialsOf(deps, userId);
  if (credentials.totpEnabledAt) {
    throw new HttpError(409, 'two_factor_already_enabled', '2FA is already on');
  }
  await checkTotp(deps, credentials, code);
  const codes = generateRecoveryCodes();
  await withAudit(deps.db, { actor: userActor(userId), scope: null }, async (tx, audit) => {
    await tx.update(userAuth).set({ totpEnabledAt: new Date() }).where(eq(userAuth.userId, userId));
    await replaceRecoveryCodes(
      tx,
      userId,
      codes.map((c) => deps.auth.secrets.hmac(normalizeRecoveryCode(c))),
    );
    await audit({
      action: 'user.totp_enable',
      entity: { type: 'user', id: userId },
      diff: { twoFactorEnabled: { from: false, to: true } },
    });
  });
  return codes;
}

export async function disableTotp(
  deps: AuthDeps,
  userId: string,
  input: { password: string; code: string },
): Promise<void> {
  const { credentials } = await credentialsOf(deps, userId);
  if (!credentials.totpEnabledAt) throw new HttpError(400, 'two_factor_not_enabled', '2FA is off');
  if (!(await verifyPassword(credentials.passwordHash, input.password))) throw invalidCredentials();
  await checkTotp(deps, credentials, input.code);
  await withAudit(deps.db, { actor: userActor(userId), scope: null }, async (tx, audit) => {
    await tx
      .update(userAuth)
      .set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null })
      .where(eq(userAuth.userId, userId));
    await replaceRecoveryCodes(tx, userId, []);
    await audit({
      action: 'user.totp_disable',
      entity: { type: 'user', id: userId },
      diff: { twoFactorEnabled: { from: true, to: false } },
    });
  });
}

export async function regenerateRecoveryCodes(
  deps: AuthDeps,
  userId: string,
  code: string,
): Promise<string[]> {
  const { credentials } = await credentialsOf(deps, userId);
  if (!credentials.totpEnabledAt) throw new HttpError(400, 'two_factor_not_enabled', '2FA is off');
  await checkTotp(deps, credentials, code);
  const codes = generateRecoveryCodes();
  await withAudit(deps.db, { actor: userActor(userId), scope: null }, async (tx, audit) => {
    await replaceRecoveryCodes(
      tx,
      userId,
      codes.map((c) => deps.auth.secrets.hmac(normalizeRecoveryCode(c))),
    );
    await audit({ action: 'user.recovery_codes_regenerate', entity: { type: 'user', id: userId } });
  });
  return codes;
}

// --- Org auth policy ---------------------------------------------------------------------

export function getAuthPolicy(deps: AuthDeps, scope: OrgScope) {
  return getOrgAuthPolicy(deps.db, scope);
}

export async function updateAuthPolicy(
  deps: AuthDeps,
  ctx: { actor: Actor; scope: OrgScope },
  input: { requireTwoFactor: boolean },
  /** The caller's own 2FA state, for users (`null` for API keys). */
  callerTwoFactorEnabled: boolean | null,
) {
  if (input.requireTwoFactor && callerTwoFactorEnabled === false) {
    throw new HttpError(
      409,
      'enable_two_factor_first',
      "enable two-factor authentication on your account first, or you'd lock yourself out",
    );
  }
  return withAudit(deps.db, ctx, async (tx, audit) => {
    const before = await getOrgAuthPolicy(tx, ctx.scope);
    const after = await upsertOrgAuthPolicy(tx, ctx.scope, input);
    await audit({
      action: 'org_auth_policy.update',
      entity: { type: 'organization', id: ctx.scope.orgId },
      diff: auditDiff(before, after),
    });
    return after;
  });
}

// --- Invitations -------------------------------------------------------------------------

/** Who is acting, with what they may do in the scope the route resolved. */
export interface Caller {
  actor: Actor;
  /** Memberships in the org, for users; `null` for API keys. */
  memberships: { role: Role; stationId: string | null }[] | null;
  /** API-key scopes, expanded. `null` for users. */
  keyPermissions: ReadonlySet<Permission> | null;
  /** API keys narrowed to one station. */
  keyStationId?: string | null;
  /** For API keys: the creator's current memberships in the org, which cap the key. */
  keyCreatorMemberships?: { role: Role; stationId: string | null }[] | null;
}

export async function callerFor(
  deps: AuthDeps,
  auth: { kind: 'session'; user: User } | { kind: 'api_key'; apiKey: ApiKey },
  scope: OrgScope,
): Promise<Caller> {
  if (auth.kind === 'api_key') {
    return {
      actor: { type: 'api_key', apiKeyId: auth.apiKey.id },
      memberships: null,
      keyPermissions: expandScopes(auth.apiKey.scopes),
      keyStationId: auth.apiKey.stationId,
      keyCreatorMemberships: auth.apiKey.createdBy
        ? await userMembershipsInOrg(deps.db, auth.apiKey.createdBy, scope)
        : null,
    };
  }
  return {
    actor: userActor(auth.user.id),
    memberships: await userMembershipsInOrg(deps.db, auth.user.id, scope),
    keyPermissions: null,
  };
}

/** What the caller may do at org level (`stationId` null) or on one station. */
export function callerPermissions(
  caller: Caller,
  stationId: string | null,
): ReadonlySet<Permission> {
  if (caller.keyPermissions) {
    if (caller.keyStationId && caller.keyStationId !== stationId) return new Set();
    if (!caller.keyCreatorMemberships) return caller.keyPermissions;
    // A key never outranks the user who created it (same rule as `requirePermission`).
    const held = effectivePermissions(caller.keyCreatorMemberships, stationId);
    return new Set([...caller.keyPermissions].filter((p) => held.has(p)));
  }
  return effectivePermissions(caller.memberships ?? [], stationId);
}

/**
 * Highest role the caller may grant in a scope: their own. API keys never grant org roles and
 * grant at most station manager.
 */
function grantCeiling(caller: Caller, stationId: string | null): number {
  if (!caller.memberships) {
    const keyCeiling = stationId ? roleRank.station_manager : 0;
    if (!caller.keyCreatorMemberships) return keyCeiling;
    const creatorRole = highestRole(caller.keyCreatorMemberships, stationId);
    return Math.min(keyCeiling, creatorRole ? roleRank[creatorRole] : 0);
  }
  const role = highestRole(caller.memberships, stationId);
  return role ? roleRank[role] : 0;
}

export async function createInvitation(
  deps: AuthDeps,
  caller: Caller,
  scope: OrgScope,
  input: CreateInvitation,
): Promise<Invitation> {
  const parsed = createInvitationSchema.parse(input);
  const stationScope: StationScope | null =
    parsed.level === 'station' ? await narrowToStation(deps.db, scope, parsed.stationId) : null;
  const stationId = stationScope?.stationId ?? null;

  if (!callerPermissions(caller, stationId).has('member:invite')) {
    throw new HttpError(403, 'forbidden', 'missing permission member:invite', {
      permission: 'member:invite',
    });
  }
  if (roleRank[parsed.role] > grantCeiling(caller, stationId)) {
    throw new HttpError(403, 'role_too_high', `you can't grant ${parsed.role}`);
  }

  const expiresAt = new Date(
    Date.now() + (parsed.expiresInDays ?? DEFAULT_INVITATION_DAYS) * 24 * HOUR_MS,
  );
  const created = await withAudit(deps.db, { actor: caller.actor, scope }, async (tx, audit) => {
    for (const old of await revokePendingInvitations(tx, scope, parsed.email, stationId)) {
      await audit({
        action: 'invitation.revoke',
        entity: { type: 'invitation', id: old.id },
        stationId: old.stationId,
        diff: { reason: { from: null, to: 'replaced' } },
      });
    }
    const result = await insertInvitation(tx, {
      orgId: scope.orgId,
      stationId,
      email: parsed.email,
      role: parsed.role,
      invitedBy: caller.actor.type === 'user' ? caller.actor.userId : null,
      expiresAt,
    });
    await audit({
      action: 'invitation.create',
      entity: { type: 'invitation', id: result.invitation.id },
      stationId,
      diff: auditDiff(null, toInvitation(result.invitation)),
    });
    return result;
  });
  await sendInvitationEmail(deps, caller, scope, created.invitation, created.token);
  return toInvitation(created.invitation);
}

async function sendInvitationEmail(
  deps: AuthDeps,
  caller: Caller,
  scope: OrgScope,
  row: InvitationRow,
  token: string,
): Promise<void> {
  const org = await getOrganization(deps.db, scope);
  const stationName = row.stationId ? (await getStation(deps.db, scope, row.stationId)).name : null;
  let inviter = org.name;
  if (caller.actor.type === 'user') {
    inviter =
      (await findUserWithAuth(deps.db, { userId: caller.actor.userId }))?.user.name ?? inviter;
  }
  await sendTemplate(deps.mailer, row.email, invitationTemplate, {
    inviter,
    orgName: org.name,
    stationName,
    role: row.role,
    link: link(deps, '/invitations/accept', token),
    expiresAt: row.expiresAt,
  });
}

/** Invitations of the org, or of one station when `stationId` is given. */
export async function listScopeInvitations(
  deps: AuthDeps,
  scope: OrgScope,
  stationId: string | null,
): Promise<Invitation[]> {
  const rows = await listInvitations(deps.db, scope);
  return rows.filter((r) => stationId === null || r.stationId === stationId).map(toInvitation);
}

/** Loads an invitation the caller may manage (invite permission on its scope). */
async function manageableInvitation(
  deps: AuthDeps,
  caller: Caller,
  scope: OrgScope,
  invitationId: string,
  onlyStationId: string | null,
): Promise<InvitationRow> {
  const row = await getInvitation(deps.db, scope, invitationId);
  if (!row || (onlyStationId !== null && row.stationId !== onlyStationId)) {
    throw new HttpError(404, 'not_found', `invitation ${invitationId} not found`);
  }
  if (!callerPermissions(caller, row.stationId).has('member:invite')) {
    throw new HttpError(403, 'forbidden', 'missing permission member:invite');
  }
  return row;
}

export async function revokeInvitation(
  deps: AuthDeps,
  caller: Caller,
  scope: OrgScope,
  invitationId: string,
  onlyStationId: string | null = null,
): Promise<Invitation> {
  const row = await manageableInvitation(deps, caller, scope, invitationId, onlyStationId);
  if (invitationStatus(row) !== 'pending') {
    throw new HttpError(409, 'invitation_not_pending', `invitation is ${invitationStatus(row)}`);
  }
  return withAudit(deps.db, { actor: caller.actor, scope }, async (tx, audit) => {
    const [updated] = await tx
      .update(invitation)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(invitation.id, row.id), isNull(invitation.acceptedAt), isNull(invitation.revokedAt)),
      )
      .returning();
    if (!updated)
      throw new HttpError(409, 'invitation_not_pending', 'invitation is no longer pending');
    await audit({
      action: 'invitation.revoke',
      entity: { type: 'invitation', id: row.id },
      stationId: row.stationId,
      diff: { revokedAt: { from: null, to: updated.revokedAt } },
    });
    return toInvitation(updated);
  });
}

/** Sends a pending (or expired) invitation again, with a new token and expiry. */
export async function resendInvitation(
  deps: AuthDeps,
  caller: Caller,
  scope: OrgScope,
  invitationId: string,
  onlyStationId: string | null = null,
): Promise<Invitation> {
  const row = await manageableInvitation(deps, caller, scope, invitationId, onlyStationId);
  const status = invitationStatus(row);
  if (status !== 'pending' && status !== 'expired') {
    throw new HttpError(409, 'invitation_not_pending', `invitation is ${status}`);
  }
  const days = Math.max(
    1,
    Math.round((row.expiresAt.getTime() - row.createdAt.getTime()) / (24 * HOUR_MS)),
  );
  return createInvitation(deps, caller, scope, {
    ...(row.stationId
      ? { level: 'station', stationId: row.stationId, role: row.role as StationRole }
      : { level: 'org', role: row.role as OrgRole }),
    email: row.email,
    expiresInDays: Math.min(days, 30),
  });
}

/**
 * Accepts an invitation as the signed-in user. The account's email must be the invited one:
 * the membership attaches to that existing account, never to a new one.
 */
export async function acceptInvitation(
  deps: AuthDeps,
  current: User,
  token: string,
): Promise<Invitation> {
  const row = await findInvitationByToken(deps.db, token);
  if (!row) throw new HttpError(404, 'invitation_not_found', 'unknown invitation');
  const status = invitationStatus(row);
  if (status === 'accepted')
    throw new HttpError(409, 'invitation_used', 'invitation already accepted');
  if (status !== 'pending')
    throw new HttpError(410, `invitation_${status}`, `invitation is ${status}`);
  if (row.email !== current.email.toLowerCase()) {
    throw new HttpError(403, 'invitation_email_mismatch', `this invitation is for ${row.email}`);
  }
  return acceptInvitationRow(deps, current, row);
}

async function acceptInvitationRow(
  deps: AuthDeps,
  current: User,
  row: InvitationRow,
): Promise<Invitation> {
  const scope = await resolveOrgScope(deps.db, row.orgId);
  const ctx = { actor: userActor(current.id), scope };
  return withAudit(deps.db, ctx, async (tx, audit) => {
    const [accepted] = await tx
      .update(invitation)
      .set({ acceptedAt: new Date(), acceptedBy: current.id })
      .where(
        and(
          eq(invitation.id, row.id),
          isNull(invitation.acceptedAt),
          isNull(invitation.revokedAt),
          gt(invitation.expiresAt, sql`now()`),
        ),
      )
      .returning();
    if (!accepted)
      throw new HttpError(409, 'invitation_not_pending', 'invitation is no longer pending');
    const existing = await userMembershipsInOrg(tx, current.id, scope);
    if (existing.some((m) => m.stationId === row.stationId)) {
      throw new HttpError(409, 'already_member', 'you already have a role in this scope');
    }
    await addMembership(
      tx,
      ctx,
      row.stationId
        ? {
            level: 'station',
            userId: current.id,
            stationId: row.stationId,
            role: row.role as StationRole,
          }
        : { level: 'org', userId: current.id, role: row.role as OrgRole },
    );
    await audit({
      action: 'invitation.accept',
      entity: { type: 'invitation', id: row.id },
      stationId: row.stationId,
      diff: { acceptedBy: { from: null, to: current.id } },
    });
    return toInvitation(accepted);
  });
}

// --- API keys ----------------------------------------------------------------------------

/**
 * Creates a scoped API key. Its scopes must be permissions the caller holds on the key's
 * scope (org, or the one station), so a key never escalates its creator.
 */
export async function createScopedApiKey(
  deps: AuthDeps,
  caller: Caller,
  scope: OrgScope,
  input: z.input<typeof createApiKeyRequestSchema>,
): Promise<{ apiKey: ApiKey; token: string }> {
  const parsed = createApiKeyRequestSchema.parse(input);
  const stationId = parsed.stationId ?? null;
  if (stationId) await narrowToStation(deps.db, scope, stationId);
  const held = callerPermissions(caller, stationId);
  if (!held.has('api_key:manage')) {
    throw new HttpError(403, 'forbidden', 'missing permission api_key:manage');
  }
  const missing = [...expandScopes(parsed.scopes)].filter((p) => !held.has(p));
  if (missing.length > 0) {
    throw new HttpError(403, 'scope_too_broad', 'a key can only carry permissions you hold', {
      missing,
    });
  }
  return createApiKey(
    deps.db,
    { actor: caller.actor, scope },
    {
      name: parsed.name,
      stationId,
      scopes: parsed.scopes,
      expiresAt: parsed.expiresAt ?? null,
    },
  );
}

function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  while (current && typeof current === 'object') {
    if ((current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
